# 开发计划

日期：2026-10-21（同日补状态标记）。收录标准、正文存储、本地管理与安装卸载、默认排序，以及此前那轮分析（星标/发布时间缺失、official 与 curated 重合等）合并成一份计划。

**状态总览**：阶段 1（收录标准 + 正文存储）、阶段 2（正文分发 + 中文层流水线）、阶段 3（本地管理与装卸）已落地，见各节的「已落地」标记；阶段 4 部分落地——M3 召回的最小版已实现（`ctx.skills.register()` 注册运行时技能 + 静态系统提示），强版本（`agent/pre-step` 注入）、空结果兜底与两套渲染合并仍未做。

**当前口径（2026-10-22T07:53Z 线上）**：version `full-2026-10-22T07-53-30-067Z`、**count 3987**、严格收录打开（水位 2000 内正文元数据覆盖率 ≥0.95）；正文按内容寻址存 GitHub `bodies` 分支，`body.v = 2` 才算已分发（当前 1729 条 v2 / 2124 条 v1 待重新分发 / 134 条无印章）；中文层 **1165 条**（hand 300 + auto 865，分片 `data/zh/part-1..41.json`）。下面这些 2026-10-21 的记录按日期保留为当时口径。

**数字口径**：改造前基线 = `tmp/catalog-branch/catalog.json`（version `full-2026-10-20T09-35-40-238Z`，count 7821）；改造后 = 2026-10-21T08:05Z 那轮线上采集（`tmp/run-2026-10-21T08-05-38-896Z.json`，version `full-2026-10-21T08-05-00-484Z`，count 3879）。已提交的采集端改动：`e82a30f`（正文水位门禁与头部优先富集）、`ecc27d9`（正文改存 GitHub bodies 分支）、`12f6ba7`（Blob 被停后的容错）、`93c6858`（GitHub 写入限速）；`lib/installer.js`、`/body` `/local` `/install` `/uninstall` 路由与中文层生成脚本当前在工作区（未提交），已通过 `npm test`（14 套）与线上采集验证。

---

## 1. 收录标准

改造前的目录是「列表里看到什么就收什么」（口径见文首「数字口径」）：7821 条里只有 2940 条抓过 detail（`enrich_v=2`），有英文描述的 2787 条，有中文卡的 300 条，而正文（SKILL.md）一条都没落盘。搜索能搜到 7821 条，其中 4881 条只有一个名字、一个装量、一个来源。

改成准入制：**先把正文抓到，再决定收不收**。

### 1.1 硬门槛（四条全满足才进目录）

> **已落地**（2026-10-21）：`collector/pipeline.mjs` 的 `buildCatalog({ requireBody, minBodyLength })` 按这四条过滤并记账 `dropped.no_body / thin_body / no_description`；正文来自 `collector/collect.mjs` 的 `mergeDetail`。线上那轮：`dropped_no_body 4426 / thin_body 10 / no_description 24`。

1. `detail` 抓到，且 `files` 里有 `SKILL.md`、`contents` 非空；
2. 正文长度 ≥ 300 字符；
3. frontmatter 有非空 `description`；
4. `hash` 可得（去重与"内容变了"的判断依据）。

第 2 条为什么是 300：`collector/pipeline.mjs:168` 已经在用 `body_length < 500` 标 `thin_body`，实测那批多是 `Call the Skill tool with "grilling".` 这类指路占位。300 是"比占位长、又不误杀短工具"的折中，且仍然保留 500 的 `thin_body` 标记给用户看。

第 3 条和第 1 条同源：`detail` 顶层没有 description 字段（实测只有 `id/source/slug/installs/hash/files`），描述只能来自 SKILL.md frontmatter（`collector/collect.mjs:53-64`）。没有正文 ⇒ 没有描述 ⇒ 也生成不出可信的中文卡。**「必须有正文」和「收录的都要有中文层」是同一条因果链上的两件事**，这是把门槛定在正文而不是描述上的理由。

失败重试：detail 失败率实测 14/497（2.8%）。失败记录下一轮重试，连续 3 轮失败移出候选池并记账。

### 1.2 收录水位

硬门槛只决定"收不收"，还得决定"抓多少条"——每抓一条正文要多花请求。水位按**装量降序**取前 N 条，N 由预算决定。

| 装量排名 | 该名次装量 | 累计装量占目录 |
|---|---|---|
| #100 | 502,439 | — |
| #300 | 172,698 | — |
| #500 | 70,227 | 78.8% |
| #1000 | 28,161 | 88.6% |
| #2000 | 10,065 | **95.9%** |
| #3000 | 2,007 | 99.4% |

建议 **N = 2000**：目录从 7821 条收到约 2000 条（-74%），但覆盖原目录 95.9% 的装量，且装量门槛在 1 万次安装以上。置信度：这份目录本身就是上游默认排序的前 3000 条，93,050 的全站规模里，2000 名之后基本是装量三位数以下的长尾（目录内 `installs < 100` 的有 3350 条）。

水位外只留两类例外：`curated`/`official`，以及每轮上限 50 条的其他来源（防止规则把新出的头部技能挡在外面）。

> **已落地**：`collector/collect.mjs` 的 `bodyGateStats(records, waterline)`（默认 `waterline = 2000`）按 `installs_merged ?? installs` 排序取前 2000 并算覆盖率；`official` 已并进 `curated`（`collector/pipeline.mjs`，实测 5527 = 5527、互通 0）。线上那轮：`head_total 2000 / head_stored 1948 / coverage 0.974 / strict true`。

### 1.3 代价与收益

- 目录条数：改造前 7800–8100 → **3879**（2026-10-21 线上实测；水位 2000，其余是 curated 例外与正文已入库但装量稍低的条目）。
- 每条从"只有名字"变成"名字 + 英文描述 + 正文 + 中文卡 + 可安装"。
- 搜索空间变小。换来的是"搜到的每一条都点得进去、装得了"——现在 62% 的搜索结果点进去是空白详情。
- 采集侧：2000 条 × 2 请求（detail + audit）= 4000 请求。当前单轮上限 1500（实测跑满 1478，耗时 155s，函数上限 300s）⇒ 2.8 轮；把单轮上限抬到 2700（仍在 300s 内）⇒ 1.5 轮。

### 1.4 要改的代码

| 位置 | 改什么 |
|---|---|
| `collector/collect.mjs:238-258` | 候选顺序改成装量降序优先。现在 `interleave(curatedRecords, headRecords)` 让 curated 与头部 1:1 交替，而 curated 有 5527 条、装量中位数只有 49（前 2000 名里只有 335 条）——**每轮预算约一半花在长尾上，这是头部 2000 名只有 792 条有描述的直接原因** |
| `collector/pipeline.mjs` | `buildCatalog` 末尾按 1.1 过滤，stats 如实记账 `dropped_no_body` / `dropped_thin_body` / `dropped_no_description` |
| `collector/collect.mjs` | `ENRICH_VERSION` 升到 3；给技能页解析单独立 `page_v`（否则以后再加页面字段又会漏掉已经打过章的条目） |
| `collector/collect.mjs:256` | `costPerTarget` 现在按 3 算，但日志按 2 打（`≤${selected.length * 2} requests`）——日志说谎，一起改掉 |
| `collector/pipeline.mjs:115-221` | `curated` 与 `official` 合并（实测 5527 = 5527，互通为 0）|

---

## 2. 正文的存储与使用

正文已经在采集时拿到了：`mergeDetail`（`collector/collect.mjs:49-66`）从 `detail.files[]` 里找 `SKILL.md`，取全文，算出 `bodyLength` / `body_excerpt` / `file_count`。但 `buildCatalog`（`collector/pipeline.mjs:174-221`）没有把它们写进目录——`body_excerpt` 只用来算 flags（`pipeline.mjs:89` 注释：「不进最终目录」）。

后果有两个：**正文白抓了**；以及**内容层 flags 全废**——`flagsOf` 读 `rec.body_excerpt`，而上游目录里没这个字段，重跑时 `thin_body` / `pointer` / `needs_api_key` 一个都算不出来（实测目录里 7821 条只剩 `deprecated 25 / has_references 10 / needs_external_cli 1`）。

正文不能塞进 `catalog.json`：那份文件已经 6.9MB，采集日志里有 `payload 6918141B is close to the 4.5MB serverless limit` 的告警。2000 条正文（SKILL.md 多数 2–8KB）再加 10MB 以上必然炸。

所以（**已落地**，2026-10-21）：

- 正文全文存 **GitHub 的 `bodies` 分支**，内容寻址：`<body_base>/<sha256>.md`，默认 `body_base = https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies`（Vercel Blob 降级为可选回退，线上 store 被停用后已不依赖它）；
- 目录里只放元数据：顶层 `body_base` + 每条 `body: { length, sha256, v }`（`v` = 已入库的正文版本戳，当前 `1`）；
- 插件按 `body_base + sha256` 拉全文（无需鉴权），本地缓存到 `~/.dsh/skills-center/bodies/<sha256>.md`；
- 注意正文只能在 Vercel 上取：detail 需要 OIDC Bearer，本地直接 `curl` 是 401（实测）。本地安装时不能现抓，只能消费已落盘的正文。
- 匿名替代口子（实测 2026-10-21）：`GET https://skills.sh/api/download/{owner}/{repo}/{slug}` 也返回 `{"files":[{path,contents}],"hash"}` 全文，**不需要 token**——但限流 60 请求/小时/IP（只对回源 MISS 计费，CDN HIT 不计），150 条抽样批测得 `{200:63, 404:2, 429:85}`（429 body 是 `{"error":"rate_limit_exceeded","message":"Maximum 60 requests per hour."}`，带 `Retry-After: 60`）。所以它只够本地抽查几条，不足以替代采集；采集仍走 OIDC 那条（600/min）。
- 同一抽样给了 404 基准：`nvidia/skills/alerts`、`hashicorp/engineering-agent-skills/acli`、`firebase/firebase-tools/firebase-firestore-basics`、`vercel-labs/agent-browser/electron`、`vercel/ai/develop-ai-functions-example` 都在目录里但上游没快照。实测 404 率约 1%–3%（≈60–230 条 /7821），1.2 的水位线要按这个数留余量。
- HTML 技能页不能当正文源（实测反证：`https://skills.sh/anthropics/skills/pdf` 的正文 113 行长行只出现 14 行通用句，frontmatter 与 `name: pdf` 全无）；raw.githubusercontent 不限流（40/40 200）但**路径发现不可靠**（CLI 的 35 个前缀盲探只命中 5/18，嵌在 `plugins/*/skills/` 的全 miss），GitHub tree API 匿名同样只有 60/h。

---

## 3. 中文层扩到全量

现状（2026-10-21）：`tier: hand` 300 条（`data/zh.json`，由 `data/zh/part-1..6.json` 合并，缺 `tier` 时按 `hand`）+ `tier: auto` 首批 25 条已合入 `data/zh/part-7.json`（`data/zh.json` 现 325 条，`tier` 计数 hand 300 + auto 25，`generated_at 2026-10-21T08:29:46Z`）（口径合计 **325/3879**）。缺口是数据活，不是代码活；**没有做到「已全量覆盖 2000 条」**。

两层，数据里带 `tier` 字段区分，界面上不区分：

- `tier: 'hand'` —— 现在的精写层，300 条，继续按装量顺序扩；
- `tier: 'auto'` —— 生成层，输入是**正文 + frontmatter**（不是名字和装量），输出同一套四字段。

生成层的可用性完全依赖 1.1 的第 1 条：正文是唯一的事实来源，模型照着正文写「用途/注意事项」，不照着名字猜。这就是为什么中文层扩容必须排在收录标准之后。

流水线（现有的三个脚本扩开）：

| 脚本 | 状态（2026-10-21） |
|---|---|
| `tools/zh_fetch_bodies.mjs` | **已落地**：把正文抓到本地缓存当素材 |
| `tools/zh_generate.mjs` | **已落地**：`plan`（按批 25 条产出 `in-<from>-<to>.json`）/ `check`（校验 + 正文溯源）/ `apply`（合并进 `data/zh/part-N.json`，幂等） |
| `tools/zh_source.mjs` | **已落地**：`--offset` / `--limit` 分页 |
| `tools/zh_validate.mjs` | **已落地**：能力词必须在正文中出现；禁用词（专治/逼出/无死角/一站式/深度赋能）；字段长度上限；`tier` 校验 |
| `tools/zh_merge.mjs` | **已落地**：合并进 `data/zh.json`，保留 `tier`、`generated_at` |

批量执行：1700 条 ÷ 25 条/批 = 68 批，分轮并行（每轮 6–8 个），每批产出后立刻过校验，不过的不合。

---

## 4. 本地管理与安装/卸载（项目级 / 全局）

### 4.1 DSH 原生读哪几个目录

宿主技能发现的优先级阶梯（`lib/provider.js:14-22` 注释引自 `dsh-skill-filesystem/lib/index.js:20-24` 与 `dsh-skill/lib/index.js:21-23`，rank 越小越优先）：

| 落点 | rank | 层级 |
|---|---|---|
| `<项目>/.dsh/skills/` | 100 | 项目级 |
| `<项目>/.agents/skills/` | 200 | 项目级 |
| 运行期目录 | 250 | — |
| 自定义目录 | 300 | — |
| `~/.dsh/skills/` | 400 | 全局 |
| `~/.agents/skills/` | 500 | 全局 |
| 包内置 | 600 | — |

这份阶梯同时回答了"项目级/全局"该落在哪：`.dsh/skills/` 与 `.agents/skills/` 是 DSH 自己会读的位置。

已从宿主实现逐行核实（`D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js`，逻辑路径）：

- 五个根的来源名与 rank：项目级 `.dsh/skills`（`source:"project-dsh"`, 100）、`.agents/skills`（`project-agents`, 200）；插件自带 `customSkillDirs`（`custom`, 300）；全局 `$DSH_HOME/skills`（`user-dsh`, 400，`skipSystem` 跳过 `.system`）、`$DSH_AGENTS_HOME/skills`（`user-agents`, 500）；随包 `bundled`（600）。`$DSH_HOME` 缺省 `~/.dsh`，`$DSH_AGENTS_HOME` 缺省 `~/.agents`（`:149-187`、`:20-24`、`:83`；home 解析见 `dsh-home-paths/README.md:84`）。
- 发现形状（`:584-617`）：每个根只扫**一层**；目录取其下的 `SKILL.md`（`:589-592`），根下散放的 `.md` 也各算一个技能（`:592-595`）；watch 只盯 `SKILL.md` 与 `*.md`（`:549-559`）。
- 项目根（`:810-818`）：从 cwd 向上找最近的含 `.git` 的祖先，找不到就用 cwd——所以"项目级安装装到哪个目录"插件自己算得出来，不用问用户。
- 本机现状：`~/.dsh/skills` **不存在**（全局只有一个根有东西）；`~/.agents/skills` 存在，find-skills / hindsight-coding-agent / wewrite 等已在里面。
- **`~/.claude/skills` 不在扫描范围**：全 asar 搜 `claude/skills` 只有 1 处无关命中（`@anthropic-ai/sdk` 的 CHANGELOG）。本机 `C:\Users\Administrator\.claude\skills` 里的 find-skills、vision 属 Claude Code 自己的目录，DSH 看不见。

### 4.2 安装走 skills CLI

`skills` 官方 CLI（已下载 1.7.4 到 `tmp/pkg174`）的落点表：

| 作用域 | 参数 | 落点 |
|---|---|---|
| 项目 | 默认 | `./<agent>/skills/` |
| 全局 | `-g` | `~/<agent>/skills/` |

DSH 不在 CLI 支持的 agent 列表里（`tmp/pkg174/package/docs/agents.md` 那份表里没有 dsh），但表里有 `codex`（以及 cline / zed / pi / dexto / fx / loaf / warp 等一长串）的项目/全局落点正好是 `.agents/skills/` 和 `~/.agents/skills/`——**就是上面阶梯里 rank 200 / 500 的位置，DSH 原生可读**。表的位置是 `tmp/pkg174/package/docs/agents.md:20`（一行挤了 cline、codex、dexto、fx、kimi-code-cli、loaf、pi、sarvam-code、warp、zed 十个；注意同一张表里 `cursor` 的项目路径也是 `.agents/skills/`，但它的全局路径是 `~/.cursor/skills/`，不能拿来装全局）。

包里还有两条实现细节（`dist/cli.mjs:4906-4923`、`:2249-2270`）：canonical 目录恒为 `<root>/.agents/skills/<slug>`；**选中的 agent 只共享同一个 skillsDir 时（`uniqueDirs.size <= 1`）CLI 强制 copy，真文件直接写该目录；多个 agent 时才建链接（Windows 上是 Junction）**。所以 `-a codex --copy` 是「单 agent + 真文件」的确定组合，不会在项目里多长出 `.claude/skills` 这种旁支。

于是安装＝官方 CLI，一行：

```
项目级：npx skills add <source> --skill <slug> -a codex --copy -y
全局级：npx skills add <source> --skill <slug> -a codex --copy -g -y
```

`--copy` 而不是默认 symlink：Windows 上建符号链接要管理员或开发者模式。这一条要在实现前先在真实 Windows 上验一遍（见 4.6）。

这条路线同时满足原始要求④（通过 skills.sh 的能力安装、不自建安装器）：下载、解包、找 SKILL.md、写锁文件都是 CLI 的活，插件只负责选源、选作用域、选落点，事后核对目录。

### 4.3 卸载与列表

```
卸载：npx skills remove <name> -a codex [-g] -y
列表：npx skills list [-g] -a codex
```

列表不解析 CLI 的输出（它是给人看的、可能带颜色和交互），直接扫上表四个目录 + 读 `SKILL.md` frontmatter，事实以文件系统为准。删除走 CLI 保证锁文件（`skills-lock.json`）一致，删完再核对目录真没了。实测（见 4.6）：卸载后 `skills-lock.json` 仍在，只是变成空表——所以"删干净"的判据只能是目录不存在，不能拿锁文件当判据。

### 4.4 面板要加的东西

- 页签：现有一个卡片墙，拆成「发现」和「本地」两个视图（面板工具条切换）。
- 发现：卡片上加「安装」按钮，点开选项目级 / 全局，显示进度和结果。
- 本地：列出四个落点里扫到的技能，标出层级（项目/全局）、来源、装量、是否本插件装的；能卸载。
- 详情弹层：安装命令现在是不能复制的纯文本，至少要能一键复制；再加正文预览（拉 `/body`）。

Host 半边新增的路由（现有前缀 `/api/dsh-skills-center`）：

| 路由 | 请求 / 响应（实现形状见 `DESIGN.md` §8.4） |
|---|---|
| `GET /local[?project=<绝对路径>]` | 扫四个根；回 `{ok, project, projectSource:"host"\|"query", roots[], skills[]}` |
| `GET /body?id=<catalogId>` 或 `?sha=<sha256>` | 回 `text/markdown`；缓存命中带 `x-body-via: cache`，主存储取回 `remote`，主存储没有时回退 skills.sh 下载接口（校验 sha256 后标 `skills.sh`） |
| `POST /install` `{id, scope, project?}` | 跑 skills CLI，回 `{ok, scope, dir, rootId, exitCode, stdout, stderr, ...}`，失败 502 |
| `POST /uninstall` `{name, scope, project?}` | 跑 skills remove，回 `{ok, scope, removed[], stillInstalledElsewhere[]}` |

> **已落地**（工作区，未提交；`tests/install-routes.test.mjs` 端到端覆盖）：`lib/installer.js` 提供 `rootDescriptors / listInstalled / installArgs / uninstallArgs / installSkill / uninstallSkill / findProjectRoot`，子进程由 `ctx.subprocess` 注入。安装作用域只有 `.agents/skills/` 两个根（rank 200 / 500）。

### 4.5 库存与激活这条旧路

现有另一套机制：正文落 `~/.dsh/skills-center/library/<source>/<slug>/SKILL.md`、`activation.json` 记录激活集合、`lib/provider.js` 以 rank 700 把"已激活且有正文"的技能暴露给宿主（`MAX_ACTIVE = 50`）。`library/` 里目前只有 1 个 SKILL.md。

> **已落地**（如实降级）：这套机制仍在代码里（`lib/index.js` 的 provider 与 `skill_activate` 工具、`lib/activation.js`），但对外语义已改为「面板预览用的正文备份」，不再承担「安装」。安装只有 4.2 那条 CLI 路径。

两套"已安装"会让用户困惑（面板显示已装，`skills list` 里没有；或者反过来）。建议：

- **安装只有一个含义**：落到 4.1 的目录，DSH 原生可发现，`skills` CLI 能管；
- 库存 + 激活降级为「不进任何 agent 目录的试用/备用」（下载正文供面板预览），不再叫"安装"。

还有一条同源硬事实：**DSH 核心没有"技能启用/停用"的存储**。全 asar 搜 `activation.json` 零命中；`ctx.skills`（`dsh-skill/lib/index.js:119` 的 `SkillRegistry`）只有 `registerProvider`(`:147`) / `register`(`:193`) / `list`(`:224`) / `snapshot`(`:234`) / `get`(`:250`) / `collect`(`:265`) / `invalidateCache`(`:376`) / `invalidateEntry`(`:382`)——**没有任何安装、下载、删除、启用、停用方法**。唯一的开关是写在 SKILL.md frontmatter 里的文件级声明：`disable-model-invocation` 与 `user-invocable`（`dsh-skill-filesystem/lib/index.js:856-857`；旧键 `disableModelInvocation`/`modelInvocable` 已被显式拒绝）。

所以"管理"能诚实做到的是：**列出**（扫四个根）/ **安装**（skills CLI）/ **卸载**（skills CLI），以及"把不想用的移出扫描根"这一种停用；做不到"留着但停用"。这反而让上面的建议更划算：`activation.json` + rank 700 那套降级成预览缓存后，就不用再假装自己有宿主不支持的语义。

### 4.6 装机通道：已在真机上验完（2026-10-21）

**实测结果**（Windows / Node 22.22.0，工作目录 `tmp/cli-test/` 下一个 `git init` 过的空项目）：

| 动作 | 命令 | 结果 |
|---|---|---|
| 项目级安装 | `npx -y skills@1.7.4 add vercel-labs/skills --skill find-skills -a codex --copy -y` | exit 0；落 `<项目>/.agents/skills/find-skills/SKILL.md`（真文件，不是 symlink）；写 `<项目>/skills-lock.json` |
| 全局安装 | 同上再带 `-g`（先把 `USERPROFILE`/`HOME` 指到临时目录） | exit 0；落 `~/.agents/skills/find-skills/SKILL.md`；写 `~/.agents/.skill-lock.json` |
| 列表 | `npx -y skills@1.7.4 list -a codex` | `find-skills  .\.agents\skills\find-skills` + `Agents: not linked  Source: vercel-labs/skills` |
| 卸载 | `npx -y skills@1.7.4 remove find-skills -a codex -y` | exit 0；目录被删；`skills-lock.json` 保留但变成 `{"version":1,"skills":{}}` |

两条由此确定的事实：① 落点就是 DSH 扫描的 rank 200 / 500 两个根，与 4.1 的推算一致；② CLI 的 stdout 是 ANSI + 盒线 + 光标转义（`[1G[J` 这种），**不能拿它当结果解析**，一律以文件系统为准。

**子进程通道**：宿主没有子进程形的 `command` 服务（`commands` 是斜杠命令注册表，不跑进程），但有 `subprocess` 服务（`ctx.subprocess`；硬依赖用 `inject:['subprocess']`，否则 `ctx.get('subprocess')` 判空）：

```ts
resolveExecutable(command: string, env?, signal?): Promise<string>   // 裸名走被清洗过的 PATH；含分隔符的相对路径直接拒绝
spawn(spec: {
  argv: readonly string[]; cwd: string;
  stdio: { stdin: 'ignore'|'pipe'|{data:string};
           stdout: 'pipe'|'inherit'|{ maxBytes: number; spill?: { maxBytes: number } };
           stderr: 同 stdout; control?: 'pipe' };
  graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): SubprocessHandle   // 同步返回
// handle: stdin/stdout/stderr/control(Duplex) | collected.{stdout,stderr}?.readFrom(fromByte) -> { text, nextOffset, lossy, spillPath? } | done: Promise<{ exitCode, signal }> | terminate() | waitForExit(signal?)
```

比 `child_process.spawn` 好在：`readFrom` 是偏移式、**不消费**，多个读者互不影响；超限就读 spill 文件且带 `lossy` 标记；服务销毁时会终结所有在跑的托管进程。安装与卸载走它，不自己 spawn。

还剩一个实现问题（阶段 3 第一步就测）：**用哪个可执行文件跑 CLI**。`resolveExecutable('node')` 在这个打包环境里未必解析得到；候选顺序是 `resolveExecutable('node')` → `process.execPath`（Electron 要带 `ELECTRON_RUN_AS_NODE=1`）→ `resolveExecutable('npx.cmd')`。同时决定：把 `skills` 作为本插件的一个 npm 依赖装进来（固定版本、离线可用、仍然是官方 CLI），而不是每次让 npx 去网上取。

---

## 5. 默认排序改为总安装量

面板与服务端的排序默认值都改成装量降序（`lib/catalog.js` 的 `SORTS` / `/list` 的 `sort` 默认值 / `lib/page.js` 榜单页）。

> **已落地**（commit `87e9ffa`，2026-10-21）：`lib/catalog.js` 导出 `DEFAULT_SORT = 'installs'`，取数口径 `installs_merged ?? installs`；`/list` 默认 `sort=installs`，旧的 S 分降级为可选排序项（界面上叫「综合分」）。

口径定案（**上一版写错了，这里更正**）：`installs_merged` 不是坏数据。它等于「主条目装量 + 所有跨仓库副本装量」，恒大于等于 `installs`（902/902 条都更大），算式能对上——`anthropics/skills/frontend-design` 的 `installs` 1008746 加 7 个副本（53177+16638+6830+411+32+1+1）正好等于 `installs_merged` 1085836。上一版说的「有值的每一条都与 `installs` 不相等」是恒真陈述，不是数据问题。

只有 902/7821 条有值的原因在聚类键：没有正文 hash 时它退化成 `slug|描述前160字`（`collector/pipeline.mjs:99-103`），跨仓库副本聚不到一起。1.1 的收录标准要求每条都有正文与 hash 之后，聚类会收紧，覆盖率随之上升。

于是：**排序口径 = `installs_merged ?? installs`**，不引入第三个字段；有副本时界面注明「含 N 个副本」，没有就是本身。这样「总安装量」只有一个含义。

改默认排序的副作用要说在前面：S 分排序的前 20 名与装量排序的前 20 名**只重合 3 条**（S 分里有 curated 加权，能把装量 862 的条目推到第 100 位）。改完之后，榜单页和面板的"默认第一屏"会完全变样。

---

## 6. 上一轮分析的问题，并入本计划

| 编号 | 问题 | 并到哪 |
|---|---|---|
| P0-1 | 头部 624 名的 `stars` / `first_seen` 恒为空——`ENRICH_VERSION` 没跟着 `fetch.mjs` 新增的页面解析一起升，头部被永久跳过 | 阶段 1（第 2 项）|
| P0-2 | `official` 与 `curated` 完全重合（5527 = 5527） | 阶段 1（1.4）|
| P0-3 | `installs_merged` 只有 902/7821 条有值（聚类键缺 hash 聚不出副本，不是缺数据） | 阶段 1（聚类键用正文 hash）/ 第 5 节（排序取 `installs_merged ?? installs`） |
| P0-4 | 同一 slug 跨仓库「重复卡」（当前 198 组 / 多出 338 条） | **已定（用户 2026-10-22）：这是正确行为，不是缺陷**——同名但作者/来源不同就是两条技能（内容可能不一样）；只有聚类键一致（同一份内容）才合并成一条并标「含 N 个副本」|
| P0-5 | 排序项没有覆盖条数提示，点了像坏了 | 阶段 1（排序项标可用条数，覆盖为 0 就置灰）|
| P1 | 星标按仓库级抓（7395 条 github 技能出自少数仓库） | 阶段 1（批量档）|
| P2 | 面板只读、`library/` 只有 1 个正文 | 阶段 2 + 3 |
| P3 | M3 召回钩子 | 阶段 4。**最小版已落地**：`ctx.skills.register()` 注册运行时技能 `skills-center`（宿主每步把 name + description 拼进可用技能列表）+ 静态 `ctx.systemPrompt.section()`；「按首条用户消息命中后经 `agent/pre-step` 注入一行」的强版本仍未做（要替宿主构造 UserMessage，风险大于收益）|
| P4 | 空结果没有出口（本地 7821 条 vs 上游 93043 条） | 阶段 4。接口已定：`GET https://skills.sh/api/search?q=<≥2字符>&limit=<n>[&owner=<owner>]`（公开无鉴权、CLI `find` 用的就是它、限流 30/分钟/IP、`limit` ≤100、返回 algolia fuzzy 结果含 `id/source/name/installs`；缺 `q` 或 1 字 → 400）；认证版 `/api/v1/skills/search`（limit ≤200，多词走 semantic）另计额度 |
| P5 | 文档漂移（README 说"三件事"列了四条；条数有 8420/7639/7821 三种说法；榜单页与面板各维护一套卡片渲染） | 阶段 4（文档漂移部分已于 2026-10-21 本轮清掉：README/PLAN/DESIGN/HANDOFF 已对齐目录与接口；榜单页与面板两套渲染合并仍未做） |

---

## 7. 阶段与验收

| 阶段 | 内容 | 验收 | 状态（2026-10-21） |
|---|---|---|---|
| **1** | 收录标准 + 富集顺序 + `ENRICH_VERSION` 升版 + `official`/`curated` 合并 + 默认排序改装量 + 排序项覆盖提示 | 一轮采集后：目录每条都有 `description_en` 与 `body.length`；装量前 100 名的 `stars`/`first_seen` 非空；`npm test` 六套全绿 | **已完成**：2026-10-21T08:05Z 线上采集 count 3879、水位内正文覆盖率 0.974、`requireBody` 已打开；默认排序改装量见 `87e9ffa`。`stars`/`first_seen` 覆盖率仍低（§6 P1、README「已知未完成」） |
| **2** | 正文落 Blob + `/body` 路由 + 中文层流水线（扩到 2000） | 2000 条正文可在面板打开；中文卡 2000 条且全部过校验脚本 | **部分完成**：正文改存 GitHub `bodies` 分支（`ecc27d9`），`/body` 路由与本地缓存已落地（`tests/body.test.mjs`）；中文层 hand 300 + auto 425 = 725/3969，**扩容进行中** |
| **3** | `/local` `/install` `/uninstall` + 面板「本地」页签 + 项目级/全局选择 | 面板上装一个技能，`npx skills list` 和 DSH 技能目录都能看到；卸载后两处都消失 | **宿主侧已完成**（`lib/installer.js` + 三条路由，`tests/install-routes.test.mjs` 端到端）；**面板侧未接线**：`client/client.js` 有「本地」视图与按钮的字符串/组件，但当前 Panel 只渲染目录视图 |
| **4** | 召回钩子（最小版）+ 空结果兜底 + 文档对齐 + 两套渲染合并 | 新会话首条消息命中时出现一行提示；文档里的条数与实际一致 | **未开工**：M3 召回钩子只有设计（§6 P3）；本次只做了文档对齐（README/PLAN/DESIGN/HANDOFF） |

阶段 1 和阶段 2 有依赖（正文存储要在收录标准生效前落好，否则那一轮抓到的正文又丢一次）。阶段 3 与 1、2 无依赖，可以并行。

---

## 8. 不建议做的

- **不追全站 93,050 条**：单轮列表上限 3000，铺到全站只会让"只有名字"的条目更多。
- **不自建安装器和包格式**：安装就是 skills CLI，正文存储只为预览与备用。
- **不把 Host 的 HTML 用 iframe 嵌进 slot**（已经踩过）。
- **不为"总安装量"改口径发明新指标**：只发 `installs` 和（有值时）`installs_merged`，并在界面注明含副本。

---

## 9. 三件事的现状（都已定）

1. **收录水位 N = 2000**（用户定）。严格过滤先不开：现在只有 480/7821 条有正文，立刻开会让目录先掉到 480 条；改成「水位内正文覆盖 ≥ 95% 自动开」，`requireBody` 可强制覆盖。
2. **安装落点 = 只保留 `.agents/skills/`**（项目级 `<项目>/.agents/skills/`、全局 `~/.agents/skills/`）。理由不只是"DSH 能读"：DSH 核心根本没有启用/停用存储（见 4.5），第二条路（`library/` + 激活 + rank 700 + 上限 50）等于自造一套宿主不认的语义；`library/` 降级为预览缓存。
3. **"总安装量"口径 = `installs_merged ?? installs`**（见第 5 节）：它是主条目加全部副本的合计，不是缺数据；覆盖率随收录标准（每条都有正文 hash）自然提升。

阶段 1、2、3 的代码已落地（部分在工作区未提交）；阶段 4 未开工。本轮线上验证：2026-10-21T08:05Z 采集，count 3879、水位内正文覆盖率 0.974、正文通过 `bodies` 分支分发。
