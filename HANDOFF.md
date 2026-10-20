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
| M0 插件骨架 | **已完成并真机验证**：provider 注册、4 个工具（含 `skill_sync`）、Web API 5 路由（含榜单页 `/`）、50 上限、lossless JSON |
| M0 数据 | **只有 12 条样例** `data/catalog.json`（version `sample-2026-10-19`），趋势数字已按 `samples/weekly.json` 真实回填（§9.1） |
| M1 中文层 | 只有那 12 条的中文卡片（人工写的），**没有生成流水线** |
| 采集端 | **代码已完成、等部署验证**：`api/collect.js` + `vercel.json` + `collector/{collect,publish,replay}.mjs` + fixture，`--replay` 全链路与 5 套测试全绿 |
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
2. ~~修样例数据 bug（§3.3）~~ **已完成**（见 §9.1）。
3. ~~写 `api/collect.js` + `vercel.json`~~ **已完成**，`--replay` 用 fixture 跑通全链路（见 §9.1）。
4. ~~等用户部署~~ **已完成并跑通**（见 §9.2）：`https://dsh-skills-center.vercel.app` 生产环境真实采集一轮，7572 条、Blob 上 `catalog-latest.json` 已更新。
5. ~~插件侧「从远端同步目录」~~ 已做完；~~top 300 中文层~~ **已完成并上线**（300 条，见 §9.2）。

### 9.1 2026-10-19 这一轮的进度（下一轮已完成，保留作档案）

**数据层（已落盘，`npm test` 全绿）**

- `samples/digest.json` 的 20 条 `trend_pct` / `weekly_series` 按 `samples/weekly.json` 逐条回填；`samples/cards.v3.md` 的 12 条趋势行同步改。**趋势定义实测反推出来**：skills.sh 的 trend = 后半周均安装 / 前半周均安装 − 1，20/20 条目从序列反算都落在 ±0.05。
- `tools/probe_catalog.py` 的安装量解析原来按逗号裸 split，会把 `1,234,567` 碎成 16 段；改成 `\\d{1,3}(?:,\\d{3})*` 逐个数匹配 + 捕获止于属性引号。
- `data/catalog.json` 重建：head 换成 `hyperframes-animation`（S 0.757，+151.7%）、`frontend-design` 掉到第 3（S 0.662，+6.4%）、`prisma-postgres` 变 `deprecated`（−3.2%，S 0.312）。
- **坑（已踩）**：teammate 跑 `collector/run.mjs --replay` 时忘了 `--out`，默认输出覆盖了 `data/catalog.json`，它又 `git checkout` 恢复成 HEAD，把上面这份重建结果冲掉了 —— 已重跑 `python tools/build_catalog.py` 复原。**以后跑 collector 一律带 `--out` 指到临时目录。**

**采集端（已写完，只能部署后才知道对不对）**

- `api/collect.js`：GET(cron)/POST(手动) 共用 `run()`；`CRON_SECRET` 缺失直接 503、带错 401（常量时间比较）；OIDC token 只在 handler 内从 `x-vercel-oidc-token` 头或 `getVercelOidcToken()` 取（**代码里零处读 `process.env.VERCEL_OIDC_TOKEN`，有测试守**）；`maxRequests`/`maxRuntimeMs` 双闸门；上传前 `validateCatalog()` 自检，过了才写 `catalog-<ISO>.json` → `catalog-latest.json`。
- `collector/collect.mjs`（编排）、`collector/publish.mjs`（自检+版本化写入）、`collector/replay.mjs`（fixture → fetchImpl）、`collector/fixtures/v1-sample.json`。
- `vercel.json`：`{"crons":[{"path":"/api/collect","schedule":"0 5 * * *"}]}`（Hobby 只允许每天一次）。
- **Hobby 60s 的真实天花板**：目录段 17 页 + curated ≈ 18 个请求随便跑完（8420 条全量）；富集每目标 2 个请求，300 闸门下只够覆盖**约 140 个**头部技能，其余只有列表级数据（无 hash/正文/审计）。响应会标 `truncated:true`、`skipped_budget`。
- 修掉 3 个真 bug：`normalizeRecord` 非幂等（第二遍静默清空 `source_kind`/`trend_pct`/`description_en`/`first_seen`）、`mergeDetail` 丢掉 `detail.description`、列表项字段其实是 `sourceType`（现兼容并同时输出 `kind`）。
- **fleet 侧还修了一个 flake**：富集段原来用 `Promise.all([detail, audit])`，detail 一 404 就 reject，而 audit 请求还在限流 sleep 里、照样发出去 —— 白烧一次额度，而且落地时间晚于 `collect()` 返回，让 `requests.used` 在 21/22 之间随机（约 1/60 复现）。改成先 `detail` 成功再发 `audit`，连续 30 次单测 + 5 次 `npm test` 全绿。

**插件侧**

- 新增 `lib/sync.js` + `skill_sync` 工具：`DSH_SKILLS_CENTER_CATALOG_URL` > `meta.json` 里记录的 sourceUrl > 默认 `https://dsh-skills-center.vercel.app/api/catalog`；先校验再写 `catalog.prev.json`、最后原子替换 `catalog.json`；只有 `mode:'replace'`（不 merge，避免留僵尸条目）；fetch 失败有 curl 回退。
- 新增 `lib/page.js` + `GET /api/dsh-skills-center/`：插件自己吐一张只读榜单页（表头可点排序、行点开看完整卡片），无前端构建、无外部资源。
- README / DESIGN 已同步（4 个工具、远端同步契约、Vercel 采集决策）。

**部署后必须先验的三件事**：`curl -H "Authorization: Bearer $CRON_SECRET" "https://<项目>/api/collect?dry=1"` 看 `count≈8420`；确认 `catalog-latest.json` 的 `generated_at` / `truncated`；把插件 `DSH_SKILLS_CENTER_CATALOG_URL` 指到 `catalog-latest.json` 后跑一次 `skill_sync`。

### 9.2 2026-10-20 这一轮的进度（线上已跑通 + 中文层上线）

**部署事实（都是真跑出来的，不是推断）**

- 生产域名 `https://dsh-skills-center.vercel.app`，项目 `prj_PavIFSFZ3VMt3EsZSpw5D3x6368c`；Blob store `skills-catalog`（`store_n6OtuGHMwpkpfyQb`，region hkg1，**凭据模式 OIDC**，没有 `BLOB_READ_WRITE_TOKEN`）；`CRON_SECRET` 在 production 环境，`vercel env pull` 拿不到它的值（Secret 类型不可读），本轮**已轮换成新值**并存进本地 `.env.local`（`.env*` 已 gitignore）。
- `vercel --prod` 每次约 23s；`/api/catalog` 是 **302 到 Blob**，不在函数里转发字节（7572 条 + 300 条中文卡 = 4.3MB，转发会撞 4.5MB 响应上限）。
- **上游真实规模是 93,043 条**（`list_total`），不是早先估的 8420。目录段按 `LIMIT_RECORDS=3000` 抓前 6 页（≈8s），去重 fork 后 **7572** 条（`deduped` 1554）。
- 一轮只富集得动 **497 个目标**（`MAX_REQUESTS=1500`，列表 6 + curated 1，约 3 请求/条），失败 1–4 个；靠 `previous` 目录继承上一轮富集结果（本轮 `inherited_enriched=1217`），覆盖率逐日爬升。整轮 125–200s，`truncated_reasons: list_cap:3000/93043, enrich_budget:6179`。
- 判失败的坑：`requests.max=1500` 但实际 `used=1522` —— 闸门是按"目标数"预算的，尾部几个目标会略微超，不是 bug 但别拿它当硬上限写断言。

**中文卡片层（`data/zh.json`，300 条）**

- 流程：`tools/zh_source.mjs` 切成 6 片（每片 50 条）→ 6 个写手并行产出 `data/zh/part-1..6.json` → `tools/zh_validate.mjs` 单条校验 → `tools/zh_merge.mjs` 合并成 `data/zh.json`（185KB）。合并脚本对**跨片重复 id / 超长 / 禁用词直接失败不落盘**，实测 300 条一次过。
- 贴法按 **id**（`collector/pipeline.mjs:189-190`，hash 会随正文变化所以不可靠），采集时同时给出 `name_zh`（拍平）和 `zh: {intro,usage,notes}`。
- 卡片渲染（`lib/catalog.js` `renderCard`）：有中文用中文；没有就从 `description_en` 截 240 字照抄并追一行「中文卡 — 未覆盖（只做安装量前 300 条）」；连英文描述都没有就写「上游没给描述，这条目前只有名称、装量、审计结论」——**不留占位符、不编**。
- 榜单页（`lib/page.js` + `lib/index.js`）：内联行 = 按 S 前 500 条 ∪ 所有有中文卡的条目（实测 697 行、HTML 292KB），URL 内联不再随目录膨胀到几 MB；`/card` 接口对任意 id 都有效，内联不是能力上限。

**这一轮踩到并修掉的真 bug**

- `lib/page.js` 的 `rankingPayload` 读 `s.intro_zh`，但采集端写的是 `s.zh.intro` → 榜单页中文列全空。改成两条路都认。
- 榜单页原本内联**全量**目录，7572 条会让 HTML 膨胀到 4MB+ 且卡主线程；改成「前 500 + 全部中文卡」并如实标注「本页列出前 N 条」。
- 上一轮的 `（缺中文，需生成）` 占位符违反文案规范，本轮换成上面那三种如实说法。

**下一个会话该接的**

1. M3 召回钩子（任务开始自动命中）还没做——`DESIGN.md §6` 里 M3 仍是设计。
2. 中文层只覆盖 300/7572；要扩就重复「切片→写手→合并」，`tools/zh_source.mjs --top N` 能一次切更多（目前只支持从头部取，没有 `--offset`，扩到第 301 名往后要先加这个参数）。
3. 富集覆盖慢：可以改成"每天优先补未富集的 top 段"，或用 `?limit=` 手动补跑几轮加速。
4. 用户侧的待办：重启 GUI 看新工具/榜单页（时机他自己定）。
