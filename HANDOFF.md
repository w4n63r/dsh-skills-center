# HANDOFF — 现状交接（写给下一个会话）

> 最后更新：2026-10-21，仓库 `D:\dsh-skills-center`。最新一轮线上事实见 §9.4；§9.1–§9.3 是按日期留档的历史，里面的条数（7572 / 300 / 7639）是当时口径，**不要当成现状**。
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
- 中文层**只精做 installs top 300**，其余留英文占位、点开再补。（2026-10-21 演进：hand 层仍是 top 300，另加一层 `tier:"auto"` 机器生成层向全目录推进，当前 325/3879，见 §9.4。）
- 卡片字段由用户逐字指定为七项：**名称 / 介绍 / 用途 / 使用注意事项 / 安装数 / 8 周趋势 / 来源**。用户对卡片成色的评价是「这样还可以」，同时批评过第一版「满满的 AI 味」——**措辞要敢下判断、只写能验的事实、结尾不升华**（禁「专治/逼出/无死角/一站式/深度赋能」）。
- 用户要求**重启时机由他控制**：攒够一批改动再一起重启 GUI。

## 2. 现在做到哪一步了（分层看）

| 层 | 状态（2026-10-21） |
| --- | --- |
| M0 插件骨架 | **已完成并真机验证**：provider 注册、4 个工具（含 `skill_sync`）、Web API 10 路由（含榜单页 `/`、`/body` `/local` `/install` `/uninstall`）、50 上限、lossless JSON |
| 目录数据 | **线上全量已上线**：GitHub `catalog` 分支，version `full-2026-10-21T08-05-00-484Z`、**count 3879**（水位 2000 + curated 例外；门禁四条见 §3.4、§9.4） |
| 正文 | **已入库**：GitHub `bodies` 分支按 sha256 寻址，水位内正文覆盖率 0.974（`requireBody` 已打开） |
| M1 中文层 | **两层**：hand 300 + auto 25 均已合并进 `data/zh.json`（分片 `data/zh/part-1..7.json`，`tier` 计数 hand 300 / auto 25）= 325/3879；流水线在 `tools/zh_*.mjs` |
| 采集端 | **线上跑通**：`api/collect.js` + `vercel.json` + `collector/`；2026-10-21T08:05Z 一轮 count 3879、请求 1458/1500 |
| 本地装卸 | **宿主侧已实现**：`lib/installer.js` + `/install` `/uninstall` `/local` 路由（`tests/install-routes.test.mjs`）；**面板侧未接线**，GUI 里还没有安装按钮 |
| 装到 DSH | 已手工挂进 `desktop` profile，用户已重启验证过 |

### 2.1 已验证可用（真机，不是推断）

- 重启 GUI 后 `skill_search("设计")`、`skill_card("anthropics/skills/frontend-design")` 正常返回中文摘要与七字段卡片。
- `skill_activate` 之后**系统注入的技能目录里真的出现该技能**（带中文 intro），停用后消失 → provider + `invalidate()` + 文件实时读链路成立。
  > **语义更正（2026-10-21）**：DSH 核心**没有技能启用/停用的存储**（`ctx.skills` 只有 registerProvider/register/list/snapshot/get/collect；唯一开关是 frontmatter 的 `disable-model-invocation`/`user-invocable`）。这套 provider 机制现在只作「面板预览用的正文备份」，**不再叫「安装」**；真正的安装走 `lib/installer.js` 的官方 skills CLI（§3.4、§9.4）。
- 修复过一个真 bug：返回值里带 `reason: undefined` 导致 `$dsh-tools` 报 `returned invalid output: value is not lossless JSON`；修法是 `lib/index.js` 里 `const plain = (value) => JSON.parse(JSON.stringify(value ?? null));`，各工具（当时是三个）的 execute 出口都过一遍。
- **教训**：运行中的 GUI 进程加载的是旧模块，改盘上代码不生效，必须重启。

### 2.2 采集器（已完成并线上运行）

**Vercel + OIDC 全量采集器**，目录 `collector/`：

- `collector/pipeline.mjs` — 纯逻辑（可单测、无 IO）：`normalizeRecord` / `clusterKey` / `dedupe` / `scoreRecord` / `auditScore` / `flagsOf` / `buildCatalog`。
- `collector/pipeline.test.mjs` — 通过。用真实测量值做断言：ai-video-generation 六个 fork（801414/642000/484000/339000/333000/318000）必须合并成 1 条且 `installs_merged = 2917414`；139 万 vs 3 万的 H 分差必须 < 0.35（对数归一），否则腰部技能全归零。
- `collector/fetch.mjs` — /api/v1 客户端（限流 100ms/次、429 重试、401 立刻抛、`mapLimit` 并发隔离）。
- `collector/fetch.test.mjs` — 通过，但**断言还在用旧的假定**（见下面必须改的三处）。
- `collector/run.mjs` — 采集入口：全量目录 → 预聚类取头部 → detail+audit → `buildCatalog` → 写 `data/catalog.json`。支持 `--replay fixture.json` 离线跑同一条代码路径、`--stage list` 只跑列表段。

## 3. 三件事的现状（都已完成，保留依据）

> §3.1–§3.3 是当时的「必须先做」，2026-10-20/21 已全部落地；每节标了完成状态。§3.4 是本轮新增的运维事实（环境变量 / cron / 热加载）。

### 3.1 `collector/fetch.mjs` 已按实测契约改完（**已完成，勿重做**）

子代理实测（2026-10-19，curl 直连）推翻了四处原先的假设，代码与测试都已跟着改：

1. **`page` 是 0 起始**（文档：`page` default 0，`per_page` 1–500 default 100）；翻页终止看 `pagination.hasMore`。`listPage`/`listAll` 已统一为 0 起始。
2. **`x-vercel-oidc-token` 这个「等价写法」服务端不认**：打在 `/api/v1/skills` 与 `/skills/curated` 上直接 `401 authentication_required`。只有 `Authorization: Bearer <JWT>` 有效（`authHeaders` 已只发这一个，测试里断言另一个必须不发）。
3. **`/api/v1/skills/curated` 是「按 owner 分组」的形状**：`{data:[{owner, totalInstalls, featuredRepo, featuredSkill, skills:[V1Skill]}], totalOwners, totalSkills, generatedAt}` → 已有 `flattenCurated()` 摊平，`client.curated()` 直接返回扁平技能数组。
4. 列表项**没有 `hash`、没有审计信息**，字段是 `id/slug/name/source/installs/sourceType/installUrl/url/isDuplicate`；`hash` 只在 `/api/v1/skills/{id}` 里（内容 SHA-256，无快照时为 null）。
5. **`/api/v1/skills/audit/{id}` 实测无需鉴权（200）**，虽然文档写 required。返回 `{id, source, slug, audits:[{provider, slug, status, summary, auditedAt, riskLevel?, categories?}]}`；`status ∈ pass|warn|fail`；`riskLevel` 实测会出现文档没写的 `"SAFE"`；5 家 provider slug 实测为 `agent-trust-hub`(Gen Agent Trust Hub) / `socket` / `snyk` / `runlayer` / `zeroleaks`。
   `pipeline.auditScore` 已改读 `audit.audits`，**fail 计入分母**（剔掉等于给差技能刷分）。
6. 未鉴权全量窗口 = 100,000 行 → 总数以上游 `pagination.total` 为准，别把 8420 写死。


### 3.2 Vercel 侧（**已完成并跑通**）

- `api/collect.js`：读 token 的**正确渠道是 `Request` 上的 `x-vercel-oidc-token` 头**（或 `@vercel/oidc` 的 `getVercelOidcToken()`，须在 handler 内调用）。Vercel 官方文档明说：函数运行期 `process.env.VERCEL_OIDC_TOKEN` **不被保证**、不能模块级读。token 复用最长 90 分钟，TTL 两小时。
- 开启 OIDC 的位置：Vercel 项目 → **Settings → Security → "Secure backend access with OIDC federation"**（issuer 选 Team 或 Global），全套餐可用，**没有 vercel.json 开关**。
- 产物上传用 Vercel Blob：`put(pathname, body, { access: 'public'|'private', allowOverwrite: true })`，`access` **必填**；返回 URL 能否公开读取决于**store 创建时**选的访问模式（不可改）。
- `vercel.json` 的 crons 形状：`{"crons":[{"path":"/api/collect","schedule":"0 5 * * *"}]}`，5 字段、**UTC**、不能同时限定 DOM 与 DOW、不认 `MON`/`JAN` 这类名字。**Hobby 仅允许每天一次**，非每日表达式会**部署失败**（`Hobby accounts are limited to daily cron jobs`）。
- **时限倒推**：Hobby 函数上限 60s，客户端限流 100ms/次 → 一次运行最多约 400 个上游请求。所以 `run.mjs --enrich` 在 Hobby 上要压到 ~300（top 预聚类 + curated 合并去重后），否则超时。Pro（300s）可以放开。
- 仓库根目前**没有** `package.json` 依赖声明 vercel/blob 之外的部署配置——Vercel 项目建议单独部署 `collector/`，`api/` 放函数，或干脆把 `api/` 与 `vercel.json` 放在仓库根（插件包同时是可部署项目，注意别把 `lib/` 打进函数包）。

### 3.3 回填并重建样例数据（**已完成**，数据 bug，保留依据）

> **状态（2026-10-21）**：①②③④ 均已完成（见 §9.1），下面这张对照表保留作档案。

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

### 3.4 线上环境变量 / cron / 热加载（2026-10-21）

**Vercel production 环境变量**（改完**必须重新部署**才生效）：

| 变量 | 必需性 | 作用 |
|---|---|---|
| `CRON_SECRET` | **必需** | `/api/collect` 鉴权（缺失 503、错误 401、常量时间比较）；手动补跑 `curl -H "Authorization: Bearer $CRON_SECRET"` 也用它 |
| `GH_TOKEN` | **必需**（自动发布） | 细粒度 token，只有 `w4n63r/dsh-skills-center` 一个仓库，`Contents: Read and write`，90 天（2027-01-19 到期） |
| `GH_REPO` | 可选 | 默认 `w4n63r/dsh-skills-center`；`GH_BODIES_BRANCH` 默认 `bodies` |
| `BODY_BASE` | 可选 | 正文基址，默认 `https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies`；不配时按「本轮存储 > 上一版目录」推断 |
| `CATALOG_LATEST_URL` | 可选 | 采集响应里的目录指针；插件侧默认直接读 GitHub raw 的 `catalog` 分支 |
| `BLOB_ACCESS` / `BLOB_PREFIX` 等 `BLOB_*` | **已非必需** | 线上 Blob store 被 Vercel 停用（`This store has been suspended.`）后，GitHub 为主、Blob 只是可选回退；只有走回退才读它们 |
| `SKILLS_API_TOKEN` | 可选 | OIDC 之外的兜底；正常走 `x-vercel-oidc-token` 头或 `getVercelOidcToken()` |

- **cron**：`vercel.json` = `{"crons":[{"path":"/api/collect","schedule":"0 5 * * *"}]}`（Hobby 只允许每天一次，UTC）。手动补跑用 POST + `Authorization: Bearer $CRON_SECRET`。
- **本地 `.env.local`** 存 `CRON_SECRET` / `GH_TOKEN` 等（`.env*` 已 gitignore）；Vercel 上的 Secret 类型变量 `vercel env pull` 读不出来。
- **改代码后哪些生效**（2026-10-20 实测）：
  - **host 半边会热加载**：改 `lib/*.js` 后不重启 GUI，`GET /api/dsh-skills-center/list` 就返回新字段。
  - **client 半边要刷新/重启**：`package.json` 的 `dsh.client` 与 `client/client.js` 是启动期加载的，必须刷新页面（浏览器半边）或重启 GUI 才生效。
  - 插件整体（`lib/index.js` 的 `apply`）改了走「重启 GUI」最稳；`ctx.skills` 的缓存靠 `invalidateCache()` 刷新（缓存键 `{cwd, scopes, revision}`）。

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
DESIGN.md             设计文档（架构/打分/里程碑/§8.4 安装与正文/§12 契约），改动前先读
README.md             面向使用者：这是什么、收录标准、安装与卸载、数据从哪来
lib/index.js          插件入口：apply / tools.register / webServer.register；plain() 保证 lossless
lib/installer.js      本机盘点 + 装卸 argv 与内核（官方 skills CLI，子进程/fs 注入；当前未提交）
lib/provider.js       skills.registerProvider：kebab 归一、list 绝不抛、rank 700
lib/catalog.js        目录读取 + 卡片渲染 + 检索/浏览（默认按总安装量排序）+ verdict
lib/categories.js     29 个分类的关键词推断（按目录版本缓存，apply() 里预热）
lib/activation.js     ~/.dsh/skills-center/activation.json（50 上限；现降级为面板预览用的正文备份）
lib/sync.js           远端目录同步（GitHub raw catalog 分支 → 本地 catalog.json）
lib/page.js           插件自吐的只读榜单页（无前端构建、无外部资源）
lib/paths.js         ~/.dsh/skills-center/{catalog,bodies,library,activation.json} 路径；MAX_ACTIVE=50
client/client.js     浏览器半边（手写无构建；dsh.client 启动期加载，改完要刷新/重启）
data/catalog.json    仓库内回退目录（线上以 GitHub catalog 分支为准）
data/zh.json         中文卡片汇总（hand 300 + auto 25 = 325 条；分片在 data/zh/part-1..7.json）
samples/             digest.json（页面采样）· digest2.json（SKILL.md 采样）· cards.v3.md（定稿卡片）· weekly.json（真实 8 周序列）
tools/               build_catalog.py · probe_catalog.py · fetch_skillmd.py · refetch_weekly.mjs · zh_source.mjs · zh_fetch_bodies.mjs · zh_generate.mjs · zh_validate.mjs · zh_merge.mjs
collector/           collect.mjs / pipeline.mjs / fetch.mjs / publish-github.mjs / replay.mjs + 各 .test.mjs
tests/               14 套（见下）；另有 api/collect.test.mjs、collector/*.test.mjs、tools/*.test.mjs
```

`npm run check`（node --check + 导出校验）与 `npm test` 目前都通过；`npm test` 依次跑 14 套：`tests/smoke.mjs`、`tests/categories.test.mjs`、`tests/sync.test.mjs`、`tests/body.test.mjs`、`tests/installer.test.mjs`、`tests/install-routes.test.mjs`、`collector/publish-github.test.mjs`、`tests/client.test.mjs`、`collector/pipeline.test.mjs`、`collector/fetch.test.mjs`、`collector/replay.test.mjs`、`api/collect.test.mjs`、`tools/zh_source.test.mjs`、`tools/zh_validate.test.mjs`。

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

### 9.3 2026-10-20 这一轮的进度（GUI 面板：左侧栏入口 + 主区浏览器）

**起因**：用户重启后说（m01324）「我重启完了 并没有看到技能中心」——插件此前只有工具和 HTTP 路由，GUI 里没有任何入口。查询 `cordis_inspect_list`/`cordis_inspect_query` 拿到 slot 树与契约后补了浏览器半边。

**做了什么**

- 新增 `client/client.js`（手写、无构建）：`window.__ModuleLoader__.load({id:'dsh-skills-center', factory})`，只 `require('react')`；在 `sidebar.panellist` 注册 `{id:'skills-center'}` 画一个 SVG 目录图标，在 `main` 注册 `{key:'skills-center'}` 画面板（**key 必须等于 sidebar 的 id**，宿主靠这个把图标和面板对上）。注册包在 `ctx.slots.inject('sidebar.panellist', …)` 内，缺 slot 时整块不注册。
- 面板：搜索（服务端搜全目录）、只看有中文卡、表头点击换排序（名称/安装数/8 周/S）、点行在右侧读完整中文卡（介绍/用途/注意事项/安装数/趋势/来源/标记/S 分/id）、顶部一行 `目录 7572 条 · 版本 … · 已激活 n/50`。样式只用 `--dsw-alias-*` token，文案走 locale 服务并带中文兜底。
- 新增只读接口 `GET /api/dsh-skills-center/list?q=&limit=&offset=&zh=1&sort=`（`lib/catalog.js` 的 `browseSkills` + `rowOf`）：回 `{version,total,matched,offset,limit,active,maxActive,rows[]}`，行里只有面板要用的字段，`limit` 硬上限 500。`searchSkills` 与 `browseSkills` 共用 `matchScore()`，判据不两处漂移。
- `package.json`：加 `exports["./client"]`、`files` 加 `client`、`dsh.client = {platform:'web', immediately:true, inject:[slots, locale]}`（与 `templates/decoration` 同形）。
- 测试：`tests/client.test.mjs`（假 `__ModuleLoader__` + 假 react）：模块 id、只 require react、两个 slot 的 id/key 对应、`label()` 是中文、fetch → 表格渲染（`1,003,686` / `+6.4%` / `-33.2%` / 标记位 / `已激活 1/50`）、样式走主题 token。已加入 `npm test`，六套全绿。

**关键坑 / 事实**

- 模块 `id` 与包名不一致，宿主就不会认领；`require` 白名单只给 `react`，`react-dom` 不许 require。
- 面板不能自己读盘：宿主只把插件的 HTTP 路由暴露给页面，数据必须走 `fetch('/api/dsh-skills-center/…')`。
- 未展开的子组件在假 react 里不会被调用——`tests/client.test.mjs` 的 `expand()` 手动调用函数型组件，否则断言看不到子组件文字。

**下一个会话该接的**

1. **重启 GUI 才会生效**（`dsh.client` 是启动期从 package.json 读的）。重启后先看左侧栏有没有「技能中心」图标；没有就查该插件在浏览器里的加载错误。
2. 面板目前只读。要做「点一下就装」，必须先有「把技能正文下载到 `~/.dsh/skills-center/library/<来源>/<slug>/SKILL.md`」的路径（`npx skills` 或自己抓 SKILL.md），否则激活了 provider 也暴露不出来（见 §4 / `DESIGN.md §6`）。
3. M3 召回：最小版已做（`ctx.skills.register()` 注册运行时技能 + 静态 `systemPrompt.section`）；「首条用户消息命中后经 `agent/pre-step` 注入一行」的强版本仍未做。

#### 9.3.1 版式改成卡片墙（2026-10-20 当天，用户拿插件市场截图提的）

用户看完第一版（表格 + 右侧详情栏）说「现在样式并不是我想要的，我想要的是类似截图中的这样的」——指 `dshmarket` 插件市场那种版式。于是把面板整体改成同构的**卡片墙**：

- 顶部状态行（目录/匹配/版本/已激活）+ 工具条（搜索框 / 排序下拉 / 降序·升序切换）+ **筛选胶囊**（全部 / 有中文卡 / 官方精选 / 有风险信号 / 已抓正文）+ 卡片墙（`repeat(auto-fill,minmax(300px,1fr))`）+ 底部「已显示 N / 共 M」与「加载更多」（每页 60，按 id 去重）。
- 卡片：中文名（没有就 slug）+ `slug · 来源` + 右上角 S 分 + 三行截断的介绍 + `安装数 / 8 周趋势` 事实行 + 标签行（官方 / 精选 / 中文卡 / 有正文 / `审计 4/5 家通过` / flags）。审计标签按 warn/fail 上色。
- 点卡片 → 居中详情弹层（Esc / 点遮罩 / 点关闭都能关）：完整中文卡、S 分四维、逐条审计（provider + status + riskLevel）、首次收录、id，GitHub 来源还给 `npx skills add <source> --skill <slug>`。
- 服务端随之扩展：`/list` 新增 `filter`（zh/official/risky/enriched）与 `dir`（asc/desc），行里新增 `name/source_kind/installs_merged/score/official/curated/enriched/first_seen/audit{judged,pass,warn,fail}/install_hint`；`install_hint` 只对 `source_kind === 'github'` 生成。
- 客户端：查询条件（q/sort/dir/filter）变化 → 200ms 防抖重拉第一页，用请求序号丢弃过期响应；`requestId` 在卸载时作废，避免回过头的 setState。
- 顺手发现的事实：**宿主半边是热加载的**——改完 `lib/catalog.js` / `lib/index.js` 后不重启 GUI，`GET /api/dsh-skills-center/list` 已经返回新字段（实测 `dir`/`filter`/`audit`/`install_hint` 都在）。所以只有 **client 半边**（`package.json` 的 `dsh.client` 与 `client/client.js`）需要刷新页面/重启才能生效。

#### 9.3.2 第二轮版式反馈（同日，仍是「和市场对比」）

用户第二次发市场截图，指出两点：「内容两侧会有智适应的留白」「底部的加载更多不合适」。

- 把截图**按像素量了一遍**（`tmp/measure*.py`、`tmp/measure-preview.py`，都未提交）：市场内容栏最大约 1180px、右侧留白；卡片约 310–380px、间距 11–20px、内边距 12–19px。本插件第一版是**拉满整屏 5 列、卡片 309px、卡内塞 7 块信息**——「拥挤」的根因是信息密度 + 满屏铺开，不是卡片小。
- 改法：`.dsc-inner{max-width:1180px;margin:0 auto}`（页头 / 卡片墙 / 底栏共用一栏，两侧留白自适应；实测预览 1600px 时左右各约 70px）；卡片最小 360px、网格间距 20/18 → 3 列（实测卡片 380px、列距 19px）；卡内信息砍到「名称 + 来源 + 两行介绍 + 装量/趋势 + 至多两个标签」。
- 底栏从「加载更多」换成分页：`上一页 / 页码窗口 / 下一页` + 右侧「第 X / Y 页 · 每页 24/48/96/192」（默认 24，取数 `offset=(page-1)*size`）；改条件回第 1 页、换页滚回顶部。页码窗口 = 首末页 + 当前页 ±1，中间省略号（7600 条 / 24 = 319 页）。
- 视觉迭代方式：`tmp/render-panel.mjs`（假 react 把**真的** `client.js` 渲成静态页，用真实 `/list` 数据）+ headless Chrome 截图 + `claude-vision-skill` 的 `vision.js` 打分。六轮下来 6 分 → 8 分，剩余意见都是细节。**这套 harness 只在 `tmp/`，不是产品代码**。
- 经验：那个视觉模型对同一张图的评分会上下浮动 1–2 分，只适合当「有没有硬伤」的筛子，不能当验收标准；最终判断还是用户看真机。

#### 9.3.3 把「这些数字是什么意思」放进界面（同日）

用户连着问了「S 分是什么东西」「审计是什么」，说明光在聊天里解释不够。做法：

- 页头加 `? 说明` 按钮 → 弹层分节讲清：总览 / S 分算法（H 热度、T 势能、C 官方性、A 可信逐项）/ 安装数与趋势口径 / 审计（五家 provider 名单、pass·warn·fail、fail 计入分母、pass ≠ 安全、fail 也可能是误报）/ 卡片标签（官方·精选·中文卡·有正文 + 六个风险标记逐条）/ 数据更新频率。
- 卡片 tooltip：S 分、审计、风险标记（按 flag 列解释）、装量、趋势各带悬停提示。
- 详情弹层：S 分下面加「不是 skills.sh 官方的分数」，审计结论下面加「pass 不等于安全」，flags 从一行拼接改成 `flag — 解释` 的逐条列表。
- 文案全部进 `client/client.js` 的 ZH/EN 词典（`help*` / `tip*` / `flag*` / `auditNote` / `scoreNote`），中英各一份。
- 测试：`tests/client.test.mjs` 新增「点说明按钮 → 弹层里必须出现公式、五家 provider、六个 flag、更新频率」与三条 tooltip 断言。
- 说明弹层用 `tmp/render-panel.mjs`（现在会同时出「面板」「详情」「说明打开」三张预览）+ 视觉复核，从「层级不清、行宽过宽」改到 8 分。

#### 9.3.4 展示层改名（同日，用户逐条指定）

用户要求：`S 分` → `评分` 且改百分制；`审计` → `第三方安全检查`；`使用注意事项` → `注意事项`；详情弹层里的 `id` 换个中文名。做法：

- 只改**展示层**，内部字段名不动（`score.S`、`audit`、`flags`），采集产物格式与 `/list` 返回字段全不变，避免连带改采集端与历史数据。
- 评分：卡片徽标 `评分 88`（`Math.round(S×100)`），详情写成 `88 分 · 热度 88 · 趋势 85 · 官方 100 · 安全检查 80`，权重说明放在下面一行。
- 第三方安全检查：卡片徽标变长（`第三方安全检查 4/5`），详情标题与说明同步；「没有第三方安全检查结论（不等于安全）」。
- 注意事项：`lib/catalog.js` 的 `renderCard`、卡片详情、`skill_card` 工具输出一起改，免得工具和界面两套说法。
- 唯一标识：标签叫「唯一标识」，下面附一行 `格式是「来源/仓库/技能名」，用来在 skills.sh 上定位这一条`。
- 顺带修掉：`/card` 接口现在会带上渲染好的 `text`（`renderCard`），榜单页的详情栏不再显示原始 JSON。
- 测试同步：`tests/client.test.mjs` 断言 `评分 66`、`注意事项`、`第三方安全检查`、`唯一标识`、`来源/仓库/技能名`；`tests/smoke.mjs` 的卡片字段清单加了 `评分 —`。

#### 9.3.5 功能分类（同日，用户要「像插件市场那样按功能分类」）

用户发来插件市场截图：分类 chips（全部 6.1k / AGI 架构探索 / UI 增强 / …）+ 右侧「筛选」下拉。问「这样可以吗」。
可以做，但**skills.sh 没有分类字段**，只能自己推断，做法与结论：

- 新增 `lib/categories.js`：29 个分类（前端与界面 / 设计与图像 / 移动端 / 后端与数据库 / 语言与框架 / 数据与分析 /
  测试与质量 / 调试与排障 / 代码评审与 Git / 部署与运维 / 浏览器与自动化 / 安全与合规 / 电商与支付 / 文档与写作 /
  办公文档 / 视频与音频 / AI 与模型 / 编辑器与插件 / 协作与沟通 / 产品与项目 / 研究与调研 / 财务与交易 / 销售与客服 /
  法务与合同 / 游戏与图形 / GPU 与加速计算 / 科学与工程 / 内容与营销 / 其他），关键词规则 + 词边界 + 连字符归一，
  最多 3 个标签，多标签。
- **实测覆盖**：7639 条里 75.6% 落到具体分类，24.4%（1866 条）进「其他」——大多是只有 owner/slug、正文全空的条目
  （nvidia/skills、wshobson/agents 这类合集）。
- **性能**：整目录分类 2.1s，按目录版本缓存，并在 `apply()` 里启动预热。
- **接口**：`/list` 新增 `category` 参数，响应加 `categories`（计数按整目录算，菜单稳定）与 `classified`；
  行上带 `categories`。**界面**：`全部(总数)` + 前 12 个分类 chips + 「更多分类」下拉；「其他」固定排最后；
  质量筛选降到第二行；下面一行写明「关键词规则推断，不是官方字段」+ 匹配数。
- **工具侧**：`skill_search` 每行带上「分类 X/Y」，让 agent 按功能筛。
- **测试**：新增 `tests/categories.test.mjs`（21 条归类断言 + 5 条词边界反例：latest≠test、docker≠doc、find-skills≠AI…）；
  smoke 增加分类菜单/过滤/计数稳定性断言；client 测试增加 chips 渲染与点击带参断言。`npm test` 现在是 7 套。
- **原生下拉踩雷**：第一版把长尾分类放进 `<select>`，用户看到展开层直接说「不要使用这样的方式」——那是
  操作系统画的菜单，与面板主题（token 控制的颜色/圆角/字号）完全两套。改法：`更多分类（N）` chips 行内展开；
  排序与每页条数也从 `<select>` 换成自绘 `Menu`（按钮 + 绝对定位浮层 + 点外部/Esc 关闭，颜色走 token）。
  现在 `client/client.js` 里**没有任何 `select` 元素**，测试里也钉了「分类行不许出现原生 select」。
#### 9.3.9 GitHub token 配好，自动发布跑通（2026-10-21）

- 建的是**细粒度 token**：只有 `w4n63r/dsh-skills-center` 一个仓库，权限 `Contents: Read and write`（+ 强制的 `Metadata: Read-only`），
  90 天有效期（2027-01-19 到期）。存两处：本地 `.env.local` 的 `GH_TOKEN`（gitignore 覆盖）与 Vercel 的 production 环境变量 `GH_TOKEN`。
- 坑 1：GitHub 建 token 要 **sudo 二次验证**，必须用户本人过；而且 token 只显示一次，
  窗口一关就没了（我前后删了两个作废的）。上一版我把 token 明文读进了会话上下文，直接删掉重建。
- 坑 2：`npx --yes vercel` 今天解析依赖失败（`@vercel/fastify@21.0.0` 不存在），要用 npm 缓存里的 CLI
  （`%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\.bin\vercel.cmd`）；而且不能设 `VERCEL_TOKEN`（那个 token 已过期），
  要让 CLI 用自己 `auth.json` 里的 session 自动刷新。环境变量加完**必须重新部署**，旧部署读不到新变量。
- 实测（自动发布，不靠手动推）：采集响应 `uploaded.github` = raw URL + `commit 1d3a134`，6,918,141B；
  `catalog` 分支**只有 1 个 commit、0 个父提交**（单提交强推成立）；`If-None-Match` → 304/0 字节；
  本地同步首次 6,918,141B/3.05s，第二次 **155ms / 0 字节**。
- 待补：星标只有 93 条有（`enrich_v === ENRICH_VERSION` 的记录会被跳过，不再抓页面）。
  已把 `ENRICH_VERSION` 从 2 升到 3，每天约 485 条重新抓页面，约 6 天把存量补齐。
#### 9.3.8 分发搬到 GitHub（同日，Blob 公开读故障当天）

- 现象：Blob 公共地址对所有对象返回 404 `Store not found`（含新上传的探针文件），
  鉴权 API 正常；Vercel 状态页说一切正常。curl 与 Node fetch 都一样。
- 决策：**GitHub raw 做主分发，Blob 保留为回退**（理由与对比见 DESIGN §5.4）。
- 落地：`collector/publish-github.mjs`（单提交强推 catalog 分支 + catalog-meta.json）、
  采集端双写（GitHub 失败不回滚 Blob）、插件默认地址换成 raw、同步「小文件先行」、
  `checkForUpdate` 也走 meta。
- 实测：首次同步 6.66MB/4.6s；第二次 229ms/0 字节；`If-None-Match` → 304 零字节。
- 还差：Vercel 环境变量 `GH_TOKEN`（细粒度 contents:write）。GitHub 创建 token 需要 sudo 二次验证，
  必须由用户本人完成；没配 token 前每天的自动发布只写 Blob，分发内容靠 `tmp/push-catalog-branch.ps1` 手动推。

#### 9.3.7 Vercel 额度实测（同日，用户问「免费额度够用吗」）

Hobby 额度（2026-10-20 查官方文档）：函数 **1M 次调用 + 4 小时 Active CPU + 360 GB-hrs 预置内存**；
Cron **每项目 100 个、最小间隔一天**（精度 ±59 分钟）；Blob **存储 1 GB + 简单操作 10,000 次 + 高级操作 2,000 次 + 流量 10 GB**。
免费额度是**项目级共享**的，将来加别的功能要一起算。

实测消耗（`vercel blob ls` + 采集响应里的 elapsed_ms）：

| 项目 | 我们用的 | 额度 | 占比 |
|---|---|---|---|
| Blob 存储 | **40.3 MB**（10 个对象：8 个版本 + latest + 一个测试文件） | 1 GB | 3.9% |
| 函数调用 | 约 30–60 次/月（cron 30 + 手动 + 每次插件 sync 打一次 `/api/catalog`） | 1,000,000 | ~0% |
| Active CPU | 每次采集墙钟 ~150s，绝大多数是等网络；即使按 60s CPU 算，30 次也只有 0.5 小时 | 4 小时 | ≤12% |
| 预置内存 | 150s × 1 GB × 30 次 ≈ 1.25 GB-hrs | 360 GB-hrs | 0.35% |
| Blob 高级操作 | 每次采集 2 次 put（版本 + 指针）、每次 sync 1 次 list | 2,000 | 个位数 |
| Blob 流量 | 每次 sync 下 ~6 MB | 10 GB | 约 1,600 次 sync |

**唯一会先撞墙的是 Blob 存储**：`publishCatalog` 只写不删，每天新增一个 ~6 MB 的版本化快照，
按当前 40 MB 起步还剩约 **160 天**到 1 GB。要治的话是给 publish 加保留策略（保留最近 N 个版本 / 删 30 天以前的），
用 `@vercel/blob` 的 `list` + `del`，十几行；另外审计字段占目录 38%（2.15 MB），只留 provider/status/riskLevel/categories、
丢掉长 summary 能再瘦一圈（代价：详情弹层里少一句人话总结）。

目录大小构成（5.73 MB / 7715 条）：审计 2.15 MB（38%）、中文卡 0.08 MB（1%），其余是每条的 id/slug/name/installs/flags/score。
`body_excerpt` 不进线上目录（面板用不到），所以正文长度不影响额度。
#### 9.3.6 发布时间与近 30 天安装量（同日，用户问「能获取到吗」）

先扫活页面再回答，结论与实现：

- **发布时间 ✅**：技能页有 `First Seen`（`<span>First Seen</span></div><div …>Jan 19, 2026</div>`）。
  我们本来就要抓这一页拿 8 周趋势，所以**不加任何请求**，在 `collector/fetch.mjs` 里顺手 `parseFirstSeen`。
  坑：`new Date('Jan 19, 2026')` 按本地时区解析，`toISOString()` 在 +08:00 下会退成前一天（实测 Jan 19 → Jan 18），
  改成月名映射拼字符串。真实页面验证：`frontend-design` → `2026-01-19`。
- **更新时间 ❌**：页面和 `/api/v1` 都没有。实测扫 ISO 日期、`Updated/Published/Created`、`N days ago` 全 0 命中。
  不编字段，面板里不显示。
- **近 30 天安装量 ⚠️ 可以算**：页面 `aria-label="Weekly installs: …"` 有 8 周周量，
  最近 4 周求和 ≈ 28 天（`weeklySum`）。界面上叫「近 30 天安装量」但附口径说明，不冒充上游字段。
  顺带确认：`weekly_series` 已经在采集产物里（1502/1723 条有 8 周数据），所以**不用重采也能排序**。
- **覆盖**：时间字段只覆盖抓过页面的条目（约 1700/7639）；选了时间范围时面板写出覆盖数，
  没时间的条目不参与筛选。接口新增 `since`（天数）与 `dated`（有时间信息的条数）。
- **界面**：排序从「一个下拉」升级成**分组浮层**（排序字段 / 排序方向 / 发布时间范围），
  方向不再单独占一个按钮；详情弹层补「近 30 天安装量」与「发布时间」两行并各带口径说明。
- **没做的事**：分类没有落进采集产物（`catalog.json` 里没有 `categories` 字段），是查询时按目录版本算的。
  好处是不用重采、随时可调词表；坏处是每次进程启动要重算一遍（已用启动预热遮掉）。

### 9.4 2026-10-21 现状（收录门禁 + 正文入库 + 本地装卸）

**目录（线上）**：version `full-2026-10-21T08-05-00-484Z`，**count 3879**（改造前 7800–8100 —— 条数下降是预期的门禁行为，不是数据丢失）。口径：`tmp/run-2026-10-21T08-05-38-896Z.json`；上游 `list_total 93036`、`raw_count 9141`、`deduped 802`、`requests 1458/1500`；`body_gate {head_total 2000, head_stored 1948, coverage 0.974, strict true}`；`dropped_no_body 4426 / thin_body 10 / no_description 24`；`payload_bytes 7,655,253`（贴 4.5MB 上限，所以只走「先传文件、再回 302」）。

**收录标准四条**（`collector/pipeline.mjs` 的 `buildCatalog({ requireBody, minBodyLength:300 })`，逐条记账 `dropped.*`）：① 从 detail 接口拿到 SKILL.md 正文（全文存对象存储，目录只留指纹）② 正文 ≥300 字符 ③ frontmatter 有非空 `description` ④ 有内容 hash。水位按**总安装量**降序取前 2000（占全站 95.9% 安装量），水位外只留 curated/official 例外；严格门禁**自动**开：水位内正文覆盖率 ≥0.95 才打开 `requireBody`（本轮 0.974 → 已开）。

**正文**：`https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies/<sha256>.md`；目录顶层 `body_base`，每条 `body: {length, sha256, v:1}`。本轮 `bodies` 上传 323 条（成功 70、失败 253 下一轮重试）。插件取正文走 `GET /body?id=`，本地缓存 `~/.dsh/skills-center/bodies/<sha256>.md`。

**本地装卸**：`lib/installer.js` + `/install` `/uninstall` `/local`（对应用 `tests/install-routes.test.mjs`）。命令是官方 CLI：`npx skills@1.7.4 add <owner/repo> --skill <slug> -a codex --copy [-g] -y`；落点 `<项目>/.agents/skills/<slug>`（rank 200）/ `~/.agents/skills/<slug>`（rank 500）——正是 DSH 的扫描根，装完立刻可用、卸载就是删目录。项目根 = 从当前目录向上找最近的 `.git`。**面板还没接这三个路由**（`client/client.js` 里有「本地」视图字符串与组件，但 Panel 只渲染目录视图），别在文档里说 GUI 能一键装。

**中文层**：hand 300 + auto 325 = **625/3960**，均已合并进 `data/zh.json`（`tier` 计数 hand 300 / auto 325，分片 `data/zh/part-1..19.json`）。流水线 `tools/zh_fetch_bodies.mjs` → `zh_generate.mjs plan/check/apply` → `zh_merge.mjs`；`check` 的「能力词必须在正文里出现」与 tier/正文溯源校验已生效。**没做到全量覆盖**（剩 ~3335 条，一批 25 条）。

**测试**：`npm test` 14 套全绿（清单见 §6）。

**仍未做**：M3 召回的强版本（`agent/pre-step` 注入；当前是注册运行时技能 + 静态系统提示的最小版）；同 slug 跨仓库重复卡（正文 hash 缺失时聚类键退化，例：`ai-video-generation` 的 101-skills / magentosh 两条）；`stars`（8 个仓库 93 条）与 `first_seen` 覆盖很低（页面抓取只对历史上抓过的那批生效，升 `ENRICH_VERSION` 只解决一部分）；水位外条目没有正文，因此不在目录里。

