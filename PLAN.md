# 开发计划

日期：2026-10-21。收录标准、正文存储、本地管理与安装卸载、默认排序，以及此前那轮分析（星标/发布时间缺失、official 与 curated 重合等）合并成一份计划。

所有数字来自 `tmp/catalog-branch/catalog.json`（version `full-2026-10-20T09-35-40-238Z`，count 7821）与 `tmp/collect-github.json`（2026-10-21T01:42Z 那轮采集的 stats）。

---

## 1. 收录标准

现在的目录是「列表里看到什么就收什么」：7821 条里只有 2940 条抓过 detail（`enrich_v=2`），有英文描述的 2787 条，有中文卡的 300 条，而正文（SKILL.md）一条都没落盘。搜索能搜到 7821 条，其中 4881 条只有一个名字、一个装量、一个来源。

改成准入制：**先把正文抓到，再决定收不收**。

### 1.1 硬门槛（四条全满足才进目录）

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

### 1.3 代价与收益

- 目录条数：7821 → ~2000。
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

所以：

- 正文全文存 Vercel Blob，一条一个对象：`body/<sha256(id)>.md`；
- 目录里只放元数据：`body: { length, sha256, key }`；
- 插件按 `body.key` 拉全文（Blob public URL，不需要鉴权）；
- 注意正文只能在 Vercel 上取：detail 需要 OIDC Bearer，本地直接 `curl` 是 401（实测）。本地安装时不能现抓，只能消费已落盘的正文。

---

## 3. 中文层扩到全量

现状：300 条（`data/zh.json`，`{name_zh, intro, usage, notes}`），且全部落在装量前 800 名内（前 500 名 291 条、前 800 名 300 条）。收录水位到 2000 后，缺口是 1700 条。

两层，数据里带 `tier` 字段区分，界面上不区分：

- `tier: 'hand'` —— 现在的精写层，300 条，继续按装量顺序扩；
- `tier: 'auto'` —— 生成层，输入是**正文 + frontmatter**（不是名字和装量），输出同一套四字段。

生成层的可用性完全依赖 1.1 的第 1 条：正文是唯一的事实来源，模型照着正文写「用途/注意事项」，不照着名字猜。这就是为什么中文层扩容必须排在收录标准之后。

流水线（现有的三个脚本扩开）：

| 脚本 | 现在 | 要加 |
|---|---|---|
| `tools/zh_source.mjs` | 出待写清单 | `--offset` / `--limit`，输入带正文而不是只带描述 |
| `tools/zh_generate.mjs` | 无 | 按正生成批次 JSON，每批 25 条 |
| `tools/zh_validate.mjs` | 规则校验 | 能力词必须在正文中出现；禁用词（专治/逼出/无死角/一站式/深度赋能）；字段长度上限 |
| `tools/zh_merge.mjs` | 合并进 `data/zh.json` | 保留 `tier`、`generated_at` |

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

### 4.2 安装走 skills CLI

`skills` 官方 CLI（已下载 1.7.4 到 `tmp/pkg174`）的落点表：

| 作用域 | 参数 | 落点 |
|---|---|---|
| 项目 | 默认 | `./<agent>/skills/` |
| 全局 | `-g` | `~/<agent>/skills/` |

DSH 不在 CLI 支持的 agent 列表里（`tmp/pkg174/package/docs/agents.md` 那份表里没有 dsh），但表里有 `codex`（以及 cline / zed / pi / dexto / fx / loaf / warp 等一长串）的项目/全局落点正好是 `.agents/skills/` 和 `~/.agents/skills/`——**就是上面阶梯里 rank 200 / 500 的位置，DSH 原生可读**。

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

列表不解析 CLI 的输出（它是给人看的、可能带颜色和交互），直接扫上表四个目录 + 读 `SKILL.md` frontmatter，事实以文件系统为准。删除走 CLI 保证锁文件（`skills-lock.json`）一致，删完再核对目录真没了。

### 4.4 面板要加的东西

- 页签：现有一个卡片墙，拆成「发现」和「本地」两个视图（面板工具条切换）。
- 发现：卡片上加「安装」按钮，点开选项目级 / 全局，显示进度和结果。
- 本地：列出四个落点里扫到的技能，标出层级（项目/全局）、来源、装量、是否本插件装的；能卸载。
- 详情弹层：安装命令现在是不能复制的纯文本，至少要能一键复制；再加正文预览（拉 `/body`）。

Host 半边新增的路由（现有前缀 `/api/dsh-skills-center`）：

| 路由 | 用途 |
|---|---|
| `GET /local?scope=project\|global` | 扫四个目录 |
| `GET /body?id=` | 拉正文（Blob 转发） |
| `POST /install` `{id, scope}` | 跑 skills CLI，返回 stdout 尾部 + 事后核对结果 |
| `POST /uninstall` `{name, scope}` | 跑 skills remove，事后核对 |

### 4.5 库存与激活这条旧路

现有另一套机制：正文落 `~/.dsh/skills-center/library/<source>/<slug>/SKILL.md`、`activation.json` 记录激活集合、`lib/provider.js` 以 rank 700 把"已激活且有正文"的技能暴露给宿主（`MAX_ACTIVE = 50`）。`library/` 里目前只有 1 个 SKILL.md。

两套"已安装"会让用户困惑（面板显示已装，`skills list` 里没有；或者反过来）。建议：

- **安装只有一个含义**：落到 4.1 的目录，DSH 原生可发现，`skills` CLI 能管；
- 库存 + 激活降级为「不进任何 agent 目录的试用/备用」（下载正文供面板预览），不再叫"安装"。

### 4.6 实现前必须实测的三件事

1. `npx skills add ... -a codex --copy` 在 Windows 上是否真的落到 `.agents/skills/`，且 DSH 能发现它。
2. 插件 Host 半边跑子进程的通道：优先用宿主提供的 command 服务（`cordis_inspect` 里能看到 `command` 服务），否则 `child_process.spawn`——注意 Node 在这个环境里用 `stdio: 'pipe'` 捕获子进程输出有已知的 EPERM 边界，退路是 `stdio: 'ignore'` + 退出码 + 事后扫目录判定。
3. 项目级安装的"项目"指哪个目录：插件进程的 cwd 未必是用户当前会话的工作目录。需要确认宿主能不能给出当前会话的 cwd；给不出就在面板上显示待装路径让用户确认。

---

## 5. 默认排序改为总安装量

面板与服务端的排序默认值都改成装量降序（`lib/catalog.js` 的 `SORTS` / `/list` 的 `sort` 默认值 / `lib/page.js` 榜单页）。

口径要写清楚，否则「总安装量」有歧义：目录里的 `installs` 是去重后主 id 的实际装量；`installs_merged` 是跨仓库副本合计，实测 7821 条里只有 902 条有值，而且**有值的每一条都与 `installs` 不相等**。建议：排序用 `installs`（可验、稳定），展示时若有 `installs_merged` 就注明「含 N 个副本」。

改默认排序的副作用要说在前面：S 分排序的前 20 名与装量排序的前 20 名**只重合 3 条**（S 分里有 curated 加权，能把装量 862 的条目推到第 100 位）。改完之后，榜单页和面板的"默认第一屏"会完全变样。

---

## 6. 上一轮分析的问题，并入本计划

| 编号 | 问题 | 并到哪 |
|---|---|---|
| P0-1 | 头部 624 名的 `stars` / `first_seen` 恒为空——`ENRICH_VERSION` 没跟着 `fetch.mjs` 新增的页面解析一起升，头部被永久跳过 | 阶段 1（第 2 项）|
| P0-2 | `official` 与 `curated` 完全重合（5527 = 5527） | 阶段 1（1.4）|
| P0-3 | `installs_merged` 88.5% 为空 | 阶段 1 / 第 5 节 |
| P0-4 | 同一 slug 跨仓库重复卡（391 组） | 阶段 1（聚类键加正文 hash）|
| P0-5 | 排序项没有覆盖条数提示，点了像坏了 | 阶段 1（排序项标可用条数，覆盖为 0 就置灰）|
| P1 | 星标按仓库级抓（7395 条 github 技能出自少数仓库） | 阶段 1（批量档）|
| P2 | 面板只读、`library/` 只有 1 个正文 | 阶段 2 + 3 |
| P3 | M3 召回钩子 | 阶段 4（宿主 `agent/pre-step` + `ctx.systemPrompt.section()` 已实测可用；只在 turn 1 命中时注入一行）|
| P4 | 空结果没有出口（本地 7821 条 vs 上游 93043 条） | 阶段 4（skills.sh 搜索链接，或宿主 `web.search` 兜底）|
| P5 | 文档漂移（README 说"三件事"列了四条；条数有 8420/7639/7821 三种说法；榜单页与面板各维护一套卡片渲染） | 阶段 4 |

---

## 7. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **1** | 收录标准 + 富集顺序 + `ENRICH_VERSION` 升版 + `official`/`curated` 合并 + 默认排序改装量 + 排序项覆盖提示 | 一轮采集后：目录每条都有 `description_en` 与 `body.length`；装量前 100 名的 `stars`/`first_seen` 非空；`npm test` 六套全绿 |
| **2** | 正文落 Blob + `/body` 路由 + 中文层流水线（扩到 2000） | 2000 条正文可在面板打开；中文卡 2000 条且全部过校验脚本 |
| **3** | `/local` `/install` `/uninstall` + 面板「本地」页签 + 项目级/全局选择 | 面板上装一个技能，`npx skills list` 和 DSH 技能目录都能看到；卸载后两处都消失 |
| **4** | 召回钩子（最小版）+ 空结果兜底 + 文档对齐 + 两套渲染合并 | 新会话首条消息命中时出现一行提示；文档里的条数与实际一致 |

阶段 1 和阶段 2 有依赖（正文存储要在收录标准生效前落好，否则那一轮抓到的正文又丢一次）。阶段 3 与 1、2 无依赖，可以并行。

---

## 8. 不建议做的

- **不追全站 93,050 条**：单轮列表上限 3000，铺到全站只会让"只有名字"的条目更多。
- **不自建安装器和包格式**：安装就是 skills CLI，正文存储只为预览与备用。
- **不把 Host 的 HTML 用 iframe 嵌进 slot**（已经踩过）。
- **不为"总安装量"改口径发明新指标**：只发 `installs` 和（有值时）`installs_merged`，并在界面注明含副本。

---

## 9. 需要拍板的三件事

1. **收录水位 N**：1000 / **2000**（建议）/ 5000。代价是采集轮数：1000 约 1 轮，2000 约 1.5–3 轮，5000 约 4–7 轮。
2. **安装落点**：只保留 `.agents/skills/`（DSH 原生可读、CLI 直装、卸载干净）；还是同时保留 `~/.dsh/skills-center/library/` + 激活那套（面板里能试用，但和 `skills list` 不同步）。
3. **"总安装量"口径**：按 `installs`（主 id 实装量）排序，还是按 `installs_merged`（跨副本合计，88.5% 为空）。
