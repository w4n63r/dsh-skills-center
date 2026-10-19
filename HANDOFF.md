# HANDOFF — 现状交接（写给下一个会话）

> 最后更新：2026-10-19，仓库 `D:\dsh-skills-center`，HEAD 之后有 1 个 WIP 提交（见「提交历史」）。
> 读这份文档就够了，不需要翻聊天记录。

## 1. 用户到底想干什么

用户在项目初期（原话大意，四条）说清了动机，这是整个项目的验收标准，不要改方向：

1. **skills.sh 里有很多优质 skill，但我不知道它们存在** → 需要一个我平时不会主动去看的「发现」入口。
2. **日常任务中不一定想得起来用某些 skill** → 光有目录没用，要能在任务开始时就命中。
3. 想要 **dsh-skills-center**：提前了解优质 skill 并**下载备用**，按**安装量、星标/趋势、类型**分类，每个 skill 有**中文的介绍 / 用途 / 功能**。
4. **插件要能通过 skills.sh 的能力直接安装 skill**（不自建安装器）。

用户后续的明确决策（都别推翻）：

- **放弃星标维度**（GitHub 星标与技能质量弱相关，且 API 拿不到），改用「安装量 + 8 周趋势 + curated + 审计等级」四维打分。
- 用户**有 Vercel 账号**；采集路线选定 **Vercel + OIDC 全量采集**（不走公开搜索矩阵、不走 sitemap 爬 2 万页）。
- 中文层**只精做 installs top 300**，其余留英文占位、点开再补。
- 卡片字段由用户逐字指定为七项：**名称 / 介绍 / 用途 / 使用注意事项 / 安装数 / 8 周趋势 / 来源**。用户对卡片成色的评价是「这样还可以」，同时批评过第一版「满满的 AI 味」——**措辞要敢下判断、只写能验的事实、结尾不升华**（禁「专治/逼出/无死角/一站式/深度赋能」）。
- 用户要求**重启时机由他控制**：攒够一批改动再一起重启 GUI。

## 2. 现在做到哪一步了（分层看）

| 层 | 状态 |
| --- | --- |
| M0 插件骨架 | **已完成并真机验证**：provider 注册、3 个工具、Web API 4 路由、50 上限、lossless JSON |
| M0 数据 | **只有 12 条样例** `data/catalog.json`（version `sample-2026-10-19`），全部来自手工采样 |
| M1 中文层 | 只有那 12 条的中文卡片（人工写的），**没有生成流水线** |
| 采集端 | **进行中**：`collector/` 已写 3 个文件 + 2 套单测（通过），但 venv 之外的网络层还没按最新 API 契约改完 |
| 装到 DSH | 已手工挂进 `desktop` profile，用户已重启验证过 |

### 2.1 已验证可用（真机，不是推断）

- 重启 GUI 后 `skill_search("设计")`、`skill_card("anthropics/skills/frontend-design")` 正常返回中文摘要与七字段卡片。
- `skill_activate` 之后**系统注入的技能目录里真的出现该技能**（带中文 intro），停用后消失 → provider + `invalidate()` + 文件实时读链路成立。
- 修复过一个真 bug：返回值里带 `reason: undefined` 导致 `$dsh-tools` 报 `returned invalid output: value is not lossless JSON`；修法是 `lib/index.js` 里 `const plain = (value) => JSON.parse(JSON.stringify(value ?? null));`，三个工具的 execute 出口都过一遍。
- **教训**：运行中的 GUI 进程加载的是旧模块，改盘上代码不生效，必须重启。

### 2.2 当前正在做的事（被打断的地方）

**Vercel + OIDC 全量采集器**，目录 `collector/`：

- `collector/pipeline.mjs` — 纯逻辑（可单测、无 IO）：`normalizeRecord` / `clusterKey` / `dedupe` / `scoreRecord` / `auditScore` / `flagsOf` / `buildCatalog`。
- `collector/pipeline.test.mjs` — 通过。用真实测量值做断言：ai-video-generation 六个 fork（801414/642000/484000/339000/333000/318000）必须合并成 1 条且 `installs_merged = 2917414`；139 万 vs 3 万的 H 分差必须 < 0.35（对数归一），否则腰部技能全归零。
- `collector/fetch.mjs` — /api/v1 客户端（限流 100ms/次、429 重试、401 立刻抛、`mapLimit` 并发隔离）。
- `collector/fetch.test.mjs` — 通过，但**断言还在用旧的假定**（见下面必须改的三处）。
- `collector/run.mjs` — 采集入口：全量目录 → 预聚类取头部 → detail+audit → `buildCatalog` → 写 `data/catalog.json`。支持 `--replay fixture.json` 离线跑同一条代码路径、`--stage list` 只跑列表段。

## 3. 下一步必须先做的三件事（有明确依据）

### 3.1 `collector/fetch.mjs` 已按实测契约改完（**已完成，勿重做**）

子代理实测（2026-10-19，curl 直连）推翻了四处原先的假设，代码与测试都已跟着改：

1. **`page` 是 0 起始**（文档：`page` default 0，`per_page` 1–500 default 100）；翻页终止看 `pagination.hasMore`。`listPage`/`listAll` 已统一为 0 起始。
2. **`x-vercel-oidc-token` 这个「等价写法」服务端不认**：打在 `/api/v1/skills` 与 `/skills/curated` 上直接 `401 authentication_required`。只有 `Authorization: Bearer <JWT>` 有效（`authHeaders` 已只发这一个，测试里断言另一个必须不发）。
3. **`/api/v1/skills/curated` 是「按 owner 分组」的形状**：`{data:[{owner, totalInstalls, featuredRepo, featuredSkill, skills:[V1Skill]}], totalOwners, totalSkills, generatedAt}` → 已有 `flattenCurated()` 摊平，`client.curated()` 直接返回扁平技能数组。
4. 列表项**没有 `hash`、没有审计信息**，字段是 `id/slug/name/source/installs/sourceType/installUrl/url/isDuplicate`；`hash` 只在 `/api/v1/skills/{id}` 里（内容 SHA-256，无快照时为 null）。
5. **`/api/v1/skills/audit/{id}` 实测无需鉴权（200）**，虽然文档写 required。返回 `{id, source, slug, audits:[{provider, slug, status, summary, auditedAt, riskLevel?, categories?}]}`；`status ∈ pass|warn|fail`；`riskLevel` 实测会出现文档没写的 `"SAFE"`；5 家 provider slug 实测为 `agent-trust-hub`(Gen Agent Trust Hub) / `socket` / `snyk` / `runlayer` / `zeroleaks`。
   `pipeline.auditScore` 已改读 `audit.audits`，**fail 计入分母**（剔掉等于给差技能刷分）。
6. 未鉴权全量窗口 = 100,000 行 → 总数以上游 `pagination.total` 为准，别把 8420 写死。


### 3.2 写 Vercel 侧（都还没写）

- `api/collect.js`：读 token 的**正确渠道是 `Request` 上的 `x-vercel-oidc-token` 头**（或 `@vercel/oidc` 的 `getVercelOidcToken()`，须在 handler 内调用）。Vercel 官方文档明说：函数运行期 `process.env.VERCEL_OIDC_TOKEN` **不被保证**、不能模块级读。token 复用最长 90 分钟，TTL 两小时。
- 开启 OIDC 的位置：Vercel 项目 → **Settings → Security → "Secure backend access with OIDC federation"**（issuer 选 Team 或 Global），全套餐可用，**没有 vercel.json 开关**。
- 产物上传用 Vercel Blob：`put(pathname, body, { access: 'public'|'private', allowOverwrite: true })`，`access` **必填**；返回 URL 能否公开读取决于**store 创建时**选的访问模式（不可改）。
- `vercel.json` 的 crons 形状：`{"crons":[{"path":"/api/collect","schedule":"0 5 * * *"}]}`，5 字段、**UTC**、不能同时限定 DOM 与 DOW、不认 `MON`/`JAN` 这类名字。**Hobby 仅允许每天一次**，非每日表达式会**部署失败**（`Hobby accounts are limited to daily cron jobs`）。
- **时限倒推**：Hobby 函数上限 60s，客户端限流 100ms/次 → 一次运行最多约 400 个上游请求。所以 `run.mjs --enrich` 在 Hobby 上要压到 ~300（top 预聚类 + curated 合并去重后），否则超时。Pro（300s）可以放开。
- 仓库根目前**没有** `package.json` 依赖声明 vercel/blob 之外的部署配置——Vercel 项目建议单独部署 `collector/`，`api/` 放函数，或干脆把 `api/` 与 `vercel.json` 放在仓库根（插件包同时是可部署项目，注意别把 `lib/` 打进函数包）。

### 3.3 回填并重建样例数据（数据 bug，必须先修）

**已确认的 bug**：`samples/digest.json` 里的 `trend_pct` / `weekly_series` 全是错的。原因是 `tools/probe_catalog.py` 把 `aria-label="Weekly installs: 65,310, 62,524, …"` 按逗号裸 split，把 `65310` 拆成 `65` + `310`，于是 16 个碎片被当成 8 周序列的前后半段。

真实格式与真实值（已重抓到 `samples/weekly.json`，脚本 `tools/refetch_weekly.mjs`）：

| 技能 | 错误 trend | **真实 trend** |
| --- | --- | --- |
| grill-me | +19.3% | **-12.8%** |
| agent-browser | -4.4% | **+57.9%** |
| frontend-design | +105.1% | **+6.4%** |
| hyperframes-animation | -5.4% | **+151.7%** |
| design-mobile-apps | +22.6% | **+70.0%** |
| vercel-react-best-practices | -3.6% | **+22.0%** |
| ai-video-generation (101-skills) | +209.6% | **+76.1%** |
| design-taste-frontend | -9.3% | **+27.9%** |
| azure-compliance | -7.2% | **-0.3%** |
| supabase-postgres-best-practices | +96.1% | **-6.2%** |
| prisma-postgres | +35.1% | **-3.2%** |
| lark-drive (open.feishu.cn) | -52.0% | **null（该来源页无 aria-label）** |

待办：① 用 `samples/weekly.json` 回填 `samples/digest.json` 的 `trend_pct` 与 `weekly_series`（lark-drive 那条置 null 并保留 `larksuite/cli/lark-drive` 的 -33.2% 作为另一个 id）；② `python tools/build_catalog.py` 重建 `data/catalog.json`；③ 同步修正 `samples/cards.v3.md` 里的趋势数字与「八周翻倍」这类措辞；④ 修掉 `tools/probe_catalog.py` 的逗号解析（用 `/\d{1,3}(?:,\d{3})*/` 逐个数匹配）。做完 `npm test`，然后**告诉用户趋势数字变了**——这是用户会直接看到的内容。

## 4. 插件侧关键契约（已从 `app.asar` 一方源码核实，别再猜）

源码位置：`D:\dsh\resources\app.asar`（解开方式：`dataStart = 8 + u32(4)`，header JSON 在 `16..16+u32(12)`），涉及 `dsh-skill/lib/index.js`、`dsh-skill-filesystem`、`dsh-tools`、`dsh-tool-skill`。

- **工厂必须同步**：`provider = create(control)` 之后 host 立刻读 `provider.name`（`:147-183`）。返回 Promise ⇒ name 为 undefined ⇒ 整个 provider 被跳过（`:354` 报 `provider.list is not a function`）。
- **`validateCandidate` 会 throw，且调用点在 `provider.list` 的 try 之外**（`:452-464` vs `:360`）→ 一个坏候选会让**所有** provider 的目录消失。所以 `list()` 必须整体 try、逐条 try，绝不抛。
- `name` 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`；`description` 非空；`provider` 必须逐字等于注册名；`rank` 必须有限数字；`locator` 不校验、原样回传。
- `get()` 拿到的是 `list()` 返回的那个对象本身（`:256`）；`definition.name !== candidate.name` 会被静默判为不存在并清缓存（`:259-262`）；`content` 必须字符串；**host 从不剥 frontmatter**（只 `dsh-skill-filesystem:673` 剥）。
- `resourceBase` 决定相对路径解析（`:71-80`）。
- 缓存键 `{cwd, scopes, revision}`、上限 128；`invalidate()` = `revision += 1` + 清缓存，是**库存改动后唯一生效路径**。
- **没有技能数量上限**；唯一截断是 `dsh-tool-skill:768` 的 `catalogDescriptionMaxLength = 500` → 中文 intro 必须 ≤500 字。`MAX_ACTIVE = 50` 是我们自己的闸门（每个技能的 name+description 都会注入系统提示，太多会烧 token 且稀释选择）。
- `dsh-tools` 只强校验 `output.render` 是函数、`output.schema` 在受支持子集内；execute 返回值按 schema 校验后 render 须**无损投影**（这也是 `undefined` 那个 bug 的根源）。
- **rank 梯子**（越小越优先）：project `.dsh` 100 / project `.agents` 200 / runtime 250 / custom dirs 300 / user `.dsh` 400 / user `.agents` 500 / bundled 600 → 本项目 `DEFAULT_RANK = 700`，保证激活技能不盖住用户自己的同名技能。

## 5. 安装 / 环境坑（都踩过）

- `dsh plugin --profile desktop add D:\dsh-skills-center` **会失败**：`[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @dsh-ops/bash-win32-x64@0.2.1 … installing the dependencies of dsh-ops@0.3.0`。任何 `pnpm add` 都会重解析依赖树，必撞。
- `dsh --profile desktop --dump-config` 被拒：`profile "desktop" is managed exclusively by the Electron application`。
- 可用的是**手工三步**（已对 desktop 执行）：① `~/.dsh/profiles/desktop/package.json` 的 dependencies 加 `"dsh-skills-center": "link:D:/dsh-skills-center"`，`dsh.profile.bundles` 追加 `"dsh-skills-center"`；② `node -e "require('fs').symlinkSync('D:\\dsh-skills-center', '<profile>/node_modules/dsh-skills-center', 'junction')"`（bash 里 `cmd //c mklink /J` 的引号转义必坏）；③ 重启 GUI。
- 网络：`skills.sh` 解析到 fake-ip（198.18.x.x），会话内 `web_fetch` 报非公网 IP、`web_search` provider 不可用；**curl 走系统代理可用**。Node 自带 fetch **不走系统代理**，所以采集/抓页面脚本一律用 `curl` 子进程。
- GitHub REST API 不可用（本机出口 IP 未授权限额已耗尽，`core.remaining=0`）；`raw.githubusercontent.com` 可用；`npx skills add` 走 git clone，不吃 API 限额，维护 `skills-lock.json`。

## 6. 仓库结构与已知文件

```
DESIGN.md             设计文档（架构/打分/里程碑/§12 契约/§13 安装），改动前先读
README.md            项目定位、安装、三个工具
lib/index.js         插件入口：apply / tools.register / webServer.register；plain() 保证 lossless
lib/provider.js      skills.registerProvider：kebab 归一、list 绝不抛、rank 700
lib/catalog.js       目录读取 + 卡片渲染 + verdict + 检索打分
lib/activation.js    激活态（~/.dsh/skills-center/activation.json，50 上限）
lib/paths.js         ~/.dsh/skills-center/{catalog,library,activation.json} 路径
data/catalog.json    12 条样例目录（含 score.S/H/T/C/A 与 flags）——即将被真实采集替换
samples/             digest.json（页面采样）· digest2.json（SKILL.md 采样）· cards.v3.md（12 张定稿卡片）· weekly.json（真实 8 周序列，新）
tools/               build_catalog.py（样例→catalog.json）· probe_catalog.py · fetch_skillmd.py · refetch_weekly.mjs（新）
collector/           pipeline.mjs / fetch.mjs / run.mjs + 两套 .test.mjs（新，WIP）
tests/smoke.mjs      假 ctx 全链路 + host 校验器镜像 + 畸形目录 + Web API 四路由
```

`npm run check`（node --check + 导出校验）与 `npm test`（`tests/smoke.mjs`）目前都通过；`collector/*.test.mjs` 单独 `node collector/pipeline.test.mjs`、`node collector/fetch.test.mjs` 跑。

## 7. 明确的「不做」

排行榜镜像站 · 评分/评论 · 上传发布 · 把第三方 skill 正文 vendor 进本仓库（只存元数据 + hash + 来源 URL，规避 license 风险）· 自建安装器（复用 `npx skills add`）· 与 `@michengai/dsh-skills-manager` 重复的在线搜索/安装（本项目只做目录层与判断层）。

## 8. 提交历史（最近）

```
fcb4f5a fix(tools): emit lossless JSON — undefined props made $dsh-tools reject skill_activate
f10295e fix(provider): rank 700, kebab-normalize slugs, never throw from list(); tests mirror host validators
fc79b74 docs: replace dsh plugin add with the manual mount that actually works
6554bdc docs(design): zh layer scoped to top 300; record profile install reality
10f937c docs(design): record verified provider contract and rank direction
33fea28 fix(provider): rank 500 so activated skills never shadow user's own
8dd62d2 docs: how to install into a dsh profile
f6e6c8c test: cover web api + honest activate when body missing
76122ff feat: M0 plugin skeleton — provider + 3 tools + smoke test
```

## 9. 建议的开工顺序

1. ~~修 `collector/fetch.mjs` 三处~~ **已完成**（0 起始分页 / 只发 Authorization / curated 摊平 / `audit.audits` + fail 计入分母），`npm test` 现在会一起跑两套 collector 单测。
2. 修样例数据 bug（§3.3），`npm test` + 重建 `data/catalog.json`，向用户报告趋势数字变化。
3. 写 `api/collect.js` + `vercel.json`，`--replay` 用真实 fixture 跑通全链路。
4. 让用户部署（需要他本人登录 Vercel 开 OIDC、建公共 Blob store），第一次真实采集。
5. 插件加「从远端 URL 同步目录」的能力（目前只读本地 `data/catalog.json`），再做真实数据下的 top 300 中文层生成。
