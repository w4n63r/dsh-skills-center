# dsh-skills-center 设计

## 1. 定位与边界

**一句话**：把 skills.sh 上的技能变成一份可离线浏览、带中文判断、能按需取用与安装的本地目录（按总安装量水位收录，2026-10-21 本轮 count **3879**）。

**与既有 `@michengai/dsh-skills-manager` 的分工**（必须先划清，否则重复造轮子）：

| 能力 | skills-manager 已有 | 本项目 |
|---|---|---|
| 在线搜索 skills.sh | 有（`/api/search`，仅 q 参数） | **不做** |
| 下载/安装技能 | 有（含 lockfile、仓库管理） | **不自建安装器**，调官方 `skills` CLI（§8.4） |
| 全量目录（按装量水位收录）+ 趋势 | 无 | **做** |
| 中文介绍/判断/该不该装 | 无 | **做** |
| 跨 owner fork 去重 | 无 | **做** |
| 本机已装盘点 + 召回钩子 | 部分（它管"装进来"） | **做**（扫描 `.agents/skills` + 按需装卸） |

结论：本项目是**目录层与判断层**，安装与在线搜索交给现有插件。

## 2. 三个痛点 → 三个机制

| 用户原话（m00142） | 机制 |
|---|---|
| "不知道它们存在" | 离线全量 `catalog.json` + 分类/榜单视图，无需联网即可翻 |
| "不一定想得起来用" | 最小版：把「技能中心」注册成运行时技能（宿主每步注入名字 + 描述）+ 一行静态系统提示；设想中的「每卡 15 字召回钩子」仍未做 |
| "提前下载备用" | 按需安装到 `.agents/skills/`（真装，DSH 立刻可用）；正文按 sha256 按需取用，不常驻上下文 |

## 3. 数据链路

```
skills.sh /api/v1  ──(Vercel Cron + OIDC)──▶  catalog 分支: catalog.json + catalog-meta.json
                                              bodies 分支: <sha256>.md（技能正文，内容寻址）
                                                  │
                                                  ▼  首启拉一次，之后按 version/meta 增量
                                        ~/.dsh/skills-center/
                                          catalog/   (只读缓存)
                                          bodies/    (按 sha256 缓存的技能正文)
                                          zh/        (中文层，按 hash 缓存)
                                          library/   (面板预览用的正文备份，不再是「安装」)
```

**采集端**（Vercel Serverless，拿得到 `VERCEL_OIDC_TOKEN`）：

| 步骤 | 请求 | 产物 |
|---|---|---|
| 1 | `GET /api/v1/skills?view=all-time&per_page=500` × 6 页（`LIMIT_RECORDS=3000`） | 列表级 3000 条：id/source/slug/installs（上游 `list_total` 93,036） |
| 2 | `GET /api/v1/skills?view=hot` | 叠加 `installsYesterday` / `change` |
| 3 | `GET /api/v1/skills/curated` | 87 owner / 342 技能打 `curated` 标 |
| 4 | `GET /api/v1/skills/audit/{id}`（仅分层内约 1500 条） | 5 家审计 status/riskLevel |
| 5 | `GET /api/v1/skills/{id}`（同上 1500 条） | `hash`（SHA-256）+ `files[]`（取 SKILL.md 正文供中文生成） |

限流 600 req/min：一轮预算 `MAX_REQUESTS=1500`（列表 6 + curated 1 + 每目标 detail/audit 两发），2026-10-21 实测用掉 1458，落在一次 Cron 内。

**产物 schema**（`catalog.json` 单文件，走 GitHub `catalog` 分支发布，不在函数里分片响应）：

```json
{
  "version": "full-2026-10-21T08-05-00-484Z",
  "count": 3879,
  "body_base": "https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies",
  "skills": [{
    "id": "vercel-labs/agent-skills/vercel-react-best-practices",
    "canonical": true,
    "aliases": ["someone/fork/vercel-react-best-practices"],
    "hash": "9f2c…",
    "body": { "length": 4213, "sha256": "…", "v": 1 },
    "installs": 814685,
    "installs_merged": 814685,
    "trend_pct": -3.6,
    "weekly": [102581, 121189, "…8 周"],
    "curated": false,
    "audit": { "pass": 4, "warn": 1, "risk": "low" },
    "gh_stars": 296100,
    "first_seen": "2026-03-13",
    "kind": "github",
    "flags": ["has_references", "needs_api_key"]
  }]
}
```

正文不进目录：全文按内容寻址存在 GitHub `bodies` 分支的 `<body_base>/<sha256>.md`，目录里只留 `body.length / body.sha256 / body.v`（`v` = 已入库的正文版本戳，当前 `1`）。

**中文层**（`zh/{hash前2位}/{hash}.json`，按内容 hash 缓存）：

```json
{ "hash": "9f2c…", "title": "React/Next.js 性能规则库", "verdict": "优先装",
  "body": "……（卡片正文）", "hook": "改 React/Next.js 代码前 → vercel-react-best-practices",
  "type": "编码规范", "deps": [], "warnings": [], "generated_at": "…", "model": "…" }
```

hash 变则重新生成——技能内容改了，旧中文自动失效，不需要人工维护。

## 4. 去重

同一份内容被多个 owner 转发是常态（`ai-video-generation` 至少 6 个 fork，合计 300 万安装）。

- 聚类键：**内容 `hash`**（`/api/v1/skills/{id}` 自带）；无 hash 的来源退化为 `(name, 正文首 200 字归一化)`。
  > **已知缺口（2026-10-21）**：同 slug 跳仓库的重复卡仍在（例：`ai-video-generation` 同时存在 101-skills 与 magentosh 两条）；正文 hash 缺失时聚类键退化成名字+正文片段，挡不住这类重复。
- 组内保留 `installs` 最大者为 `canonical`，其余进 `aliases`。
- 榜单只收 `canonical`；`installs_merged` = 组内求和，仅作展示（"整族 300 万次安装"）。
- 卡片上明确写出"另有 5 个 fork"——这本身就是判断信息。

## 5. 打分

```
S = 0.45·H + 0.20·T + 0.20·C + 0.15·A      # 内部字段叫 score.S（0–1）
评分 = round(S × 100)                       # 界面上只显示 0–100 的「评分」
```

> 命名：用户 2026-10-20 把界面上的「S 分」改成「评分」并要求百分制，把「审计」改成「第三方安全检查」、「使用注意事项」改成「注意事项」、详情里的 `id` 改成「唯一标识」。内部字段名（`score.S`、`audit`、`flags`）保持不变，只改展示层，避免动采集产物格式。

- **H 热度** = `log10(1+installs)` 归一化。必须取对数：头部 139 万与腰部 3 万差 46 倍，线性尺度会让榜单只剩前 20 个。
- **T 势能** = 8 周序列后半段/前半段的增长率，裁剪到 `[-50%, +200%]` 再归一化。趋势是唯一能反映"正在退场"的指标（`lark-drive` 总量 46 万但八周 −52%）。
- **C 官方性** = curated 或 owner 属厂商官方（anthropics / vercel-labs / microsoft / supabase / prisma / larksuite…）= 1，否则 0。
- **A 可信** = 第三方安全检查 pass 占比；无检查数据记中性 0.5，不给 0（否则非 GitHub 来源被系统性歧视）。界面上这一项叫「安全检查」，卡片徽标是「第三方安全检查 4/5」。

权重还没定死：0.45/0.20/0.20/0.15 是初值，等目录跑起来看榜单观感再调。

### 5.2 发布时间与近 30 天安装量（实测口径）

用户 2026-10-20 问「skill 的发布时间和更新时间能获取到吗」「除了总下载量，近 30 天的下载量能获取到吗」。
拿活页面逐项扫过之后的结论：

| 想要的东西 | 能不能拿到 | 依据 |
|---|---|---|
| **发布时间** | ✅ 能 | 技能页里有 `First Seen`：`<span>First Seen</span></div><div class="…">Jan 19, 2026</div>`。我们**本来就要抓这一页**（8 周趋势），所以零额外请求，顺手解析成 ISO 日期 |
| **更新时间** | ❌ 拿不到 | 页面与 `/api/v1` 都没有这个字段：实测扫 `\d{4}-\d{2}-\d{2}`、`Updated/Published/Created`、`N days ago` 全是 0 命中。不做假字段，面板里就不出现它 |
| **近 30 天安装量** | ⚠️ 可以算 | 上游只给总安装量，但页面 `aria-label="Weekly installs: …"` 有 **8 周周量**。最近 4 周求和 ≈ 28 天（`weeklySum(series, 4)`）。这是**我们的算法**，所以界面上写「近 30 天安装量」并附一句口径说明，不冒充上游字段 |
| GitHub 星标 | ✅ 有 | 页面有 `GitHub Stars`，但用户早已决定不用星标做维度，继续不用 |

- 解析实现：`collector/fetch.mjs` 的 `parseFirstSeen`（**不能用 `new Date('Jan 19, 2026')`**：它按本地时区解析，
  `toISOString()` 会退成 `2026-01-18`，实测踩过；改成月名映射拼字符串），`parseWeeklyInstalls` 照旧。
- 覆盖范围：只有**抓过页面详情**的条目才有这两个字段（2026-10-21 线上 stats：`with_trend` 4430 / `with_hash` 5492 / `with_audit` 5410，分母是每轮候选集的 stats 口径，不是目录 3879；`stars` 只覆盖 8 个仓库 93 条，`first_seen` 更少——页面抓取只对历史上抓过的那批生效，升 `ENRICH_VERSION` 只解决一部分）。面板不假装全覆盖：
  选了时间范围就把覆盖数写在下面（`有时间信息 N / M`），没时间的条目**不参与**时间筛选（宁可筛掉，也不当它是新的）。
- 排序：`installs4w`（近 4 周安装量）进 `SORTS`，由 `weekly_series` 现算，不落新的采集字段。

### 5.1 功能分类（`lib/categories.js`）

用户 2026-10-20 拿插件市场的截图问「分类能不能按技能属于的功能来分」。**skills.sh 没有分类字段**，
上游只给 id/slug/installs/hash/files，描述也就几百条有。所以只能自己分类，并且必须承认它是**推断**：

- **为什么用关键词规则而不是模型**：目录里三千多条中只有一部分有描述（其余只有 slug/name），送模型既贵又不稳；
  规则可复现、可单测、离线可跑。分类菜单里明写「按技能实际功能自动分类（关键词规则，不是 skills.sh 官方字段）」——
  不许把它说得像上游字段。
- **分类是多标签**：一条技能可能既属于「前端与界面」又属于「测试与质量」，取分数最高的前 3 个；
  一个都没命中才落到「其他」（改造前 7639 条目录实测 24.4%、约 1866 条；新目录 3879 条下的分类计数待核实）。
- **三条踩出来的经验**：
  1. **必须词边界匹配**，不能裸子串：`test` 会命中 `latest`/`contest`，`doc` 会命中 `docker`。测试里专门钉了这类反例。
  2. **词表里不许放泛词**：曾把 `skill` 放进 AI 分类，结果 `find-skills` 被归成「AI 与模型」。`agent`/`api`/`model` 同理。
  3. **连字符要归一**：slug 里是 `code-review-checklist`，词表写的是 "code review"，
     所以匹配前把 `-`/`_`/`/` 都换成空格，词表也一起归一（`react-native`、`ci/cd` 因此都能命中）。
- **字段权重**：slug/name 各 3 分，source（owner/repo）2 分——`anthropics/claude-for-legal/*` 这种正文为空也能靠 owner 兜底；
  中文名 2 分；中文介绍与英文描述各 1 分。
- **两阶段匹配**（性能）：先只扫短字段；一个分类都没命中才去读长文本，并截断 600 字。
  整目录实测 2.1s（改造前 7639 条口径；两阶段之前 3.8s）。插件 `apply()` 启动时空转一次预热缓存，
  免得到第一次点开面板才卡 2s。
- **计数按整个目录算**，不随关键词/筛选变化——菜单要稳定，否则点一下菜单就洗牌。
  「其他」固定排最后：它条数最多，但它是兜底桶不是分类，排第一会让菜单第一眼就是「其他」。
- **界面**：前 12 个分类铺成 chips（`全部 3,879` 带头）；长尾 + 「其他」不塞进下拉，而是由一个
  `更多分类（17）` chips **行内展开**成同样的胶囊，再点「收起」——用户 2026-10-20 看到原生下拉的展开层后明确说
  「不要使用这样的方式」，那种弹出菜单是操作系统的样式，与面板主题 token 完全两套观感。
  质量筛选（有中文卡/官方精选/有风险信号/已抓正文）降到第二行小号 chips；下面一行写口径与匹配数。
- **一条硬规则**：面板里**不使用原生 `<select>`**。排序与每页条数改用自绘 `Menu` 组件
  （按钮 + 绝对定位浮层 + 点外部/Esc 关闭），颜色、圆角、字号全部走宿主 token。
- **工具侧**：`skill_search` 的每行摘要带上「分类 前端/设计」，让 agent 按功能筛而不是只看名字。

## 5.4 目录分发：GitHub 为主、Blob 回退（2026-10-20）

**起因**：Vercel Blob 的公开读路径当天整体 404（所有对象都返回 16 字节的 `Store not found`，
而同一 store 的鉴权 API 正常：`vercel blob ls` 能列、`vercel blob put` 能传）。目录分发是插件的命脉，
不能挂在一个坏起来连状态页都不承认的服务上。

| | Vercel Blob（回退） | GitHub raw（主） |
|---|---|---|
| 可用性 | 当天全站 404 | CDN 全球节点，实测 200 |
| 带宽 | 免费 10GB/月 | 不计流量 |
| 原子性 | 覆盖写同一 key，实测有几秒 404 窗口 | commit 原子，读者只看到旧版或新版 |
| 条件请求 | 弱 ETag `W/"…"` | ETag 由内容推导，内容不变永远 304（实测 304 零字节） |
| 可回溯 | 保留 14 个快照 | 每天一个 commit，可 diff |

- **发布形态**：`catalog` 分支永远只有一个**无父提交**的 commit，包含 `catalog.json`（全量）
  与 `catalog-meta.json`（~230 字节：version/count/bytes/sha256/generated_at/published_at）。
  两个文件同一个 commit，避免「meta 说新了、catalog 还是旧的」；无父提交让仓库不会天天 +6MB。
  实现见 `collector/publish-github.mjs`（Git Data API：blob → tree → commit → 强推 ref）。
- **插件侧**：默认读 GitHub raw；同步第 0 步先取 meta 比 sha256，一样就返回 `meta_unchanged`、0 字节；
  不一样才下全量。主地址整条失败 → 依次试 `FALLBACK_CATALOG_URLS`（Vercel 入口），并把实际来源记进 meta。
  检查更新同样先比 meta（200 字节），HEAD + If-None-Match 只作为兜底。
- **实测**（2026-10-20）：首次同步 6,656,984B / 4.6s；第二次同步 229ms、**0 字节**；
  `checkForUpdate` 走 meta，`updateAvailable: false`。
- **手工兜底**：没有 token 时也能更新分发内容——`tmp/push-catalog-branch.ps1` 用 git 底层命令构造
  同样的单提交，再用 SSH 远端强推。
- **仍需一把 token**（细粒度、contents:write，存 Vercel 环境变量 `GH_TOKEN`）才能让每天的采集自动发布；
  没配时采集照常写 Blob，响应里把 GitHub 那步记成 `skipped`。

## 5.3 上游数据面盘点（2026-10-20 实测）

用户问「分析一下 API，看看都还能展示哪些东西」。这一节是**已经抓下来、但还没展示**的东西的清单，
每条都注了来源、成本、覆盖，写下来免得下次再翻一遍文档。

### 三个数据面

| 面 | 地址 | 鉴权 | 我们现在的用法 |
|---|---|---|---|
| JSON API | `https://skills.sh/api/v1/*` | Vercel OIDC（`Authorization: Bearer`） | 列表 6 页（3000 条）+ curated + 每个目标 2 个请求（detail + audit） |
| 技能页 HTML | `https://www.skills.sh/<source>/<slug>` | 无 | 抓 8 周周量与 First Seen |
| 站内页面 | `/topics` `/topic/<slug>` `/audits` `/hot` `/trending` `/agent/<name>` `/packs` | 无（`/packs` 要登录） | 没用 |

### 已经拿到、还没展示的

> 覆盖数原按改造前目录（7639/7715 条）统计；带 `with_*` 的来自 2026-10-21 线上 stats（`tmp/run-2026-10-21T08-05-38-896Z.json`），新目录（3879 条）下重算待核实。

| 能展示什么 | 来源 | 成本 | 覆盖（实测） |
|---|---|---|---|
| **审计风险筛选**：只看 High Risk / 有告警 / 未审 | 我们已存全量 `audit` | 0 新请求 | 2026-10-21 stats `with_audit` 5410 |
| **审计查的是什么**：`audit.audits[].categories`，实测出现过 14 个值——风险类：COMMAND_EXECUTION / DYNAMIC_EXECUTION / REMOTE_CODE_EXECUTION / EXTERNAL_DOWNLOADS / DATA_EXFILTRATION / CREDENTIALS_UNSAFE / PRIVILEGE_ESCALATION / PERSISTENCE / OBFUSCATION / PROMPT_INJECTION / INDIRECT_PROMPT_INJECTION / DYNAMIC_CONTEXT_INJECTION；非风险标记：SAFE / NO_CODE（展示时要排除） | 同上 | 0 | 1354 条审计带 categories |
| **风险等级筛选**：只看 `riskLevel` = HIGH / CRITICAL | 同上 | 0 | 实测分布：SAFE 2170 / LOW 1876 / MEDIUM 1211 / NONE 1173 / HIGH 116 / **CRITICAL 22** —— 需要人看一眼的只有 138 条 |
| **上游话题**：如 `Design & UI`（`/topic/design`） | 技能页标题下的徽章 | 0（同一页） | 只有 8 个话题：react / nextjs / design / mobile / agent-workflows / databases / testing / marketing，且**不是每个技能都有**（实测 prisma-postgres、xlsx 没有） |
| **相关技能**（Related skills，2–5 条） | 技能页底部区块 | 0（同一页） | 部分技能有 |
| **官方精选视图**：87 家厂商 × 342 个技能，按 `totalInstalls` 排序，带 `featuredSkill`/`featuredRepo`/`generatedAt` | `/api/v1/skills/curated` | 1 请求/天 | 全量 |
| **本周上升榜**（官方周榜，跨仓库合并展示） | `?view=trending` 或 `/trending` | 1–2 请求 | 全量 |
| **此刻最热**：最近一小时安装量与变化（`installsYesterday`/`change`） | `?view=hot` 或 `/hot` | 1–2 请求 | 全量；实测数值很小（个位数/小时），噪声大 |
| **按仓库浏览**：某个仓库的全部技能（不受全局截断限制） | `?source=owner/repo` | 1 请求/仓库 | 全量 |
| **文件树**：`files[]` 里每个 path（还有完整 contents） | detail 接口 | 0（已抓） | 2026-10-21 stats `with_hash` 5492 |
| **正文原文**（我们只存 4000 字摘录） | detail 的 `files[0].contents` | 要改存储 | 同上 |
| **在 skills.sh 打开**、`installUrl` | 列表项 `url`/`installUrl` | 0（已抓但没存进目录） | 全量 |
| **语义搜索兜底**：多词英文查询走上游 `searchType=semantic`（单词走 fuzzy） | `/api/v1/skills/search` | 1 请求/次查询 | 全量；中文查询上游大概不行，本地中文卡仍是主路 |

### 做不了的（别浪费时间）

- **Packs**：`/packs` 要 Vercel 登录，非公开数据。
- **每个技能兼容哪些 agent**：站上有 20 个 `/agent/<name>` 落地页（claude-code / cursor / codex / windsurf / zed…），
  但技能页里没有「兼容 agent」这个字段，那些链接只是导航。
- **更新时间**：见 §5.2，上游确实没有。
- **GitHub Stars**：页面有，但用户早已决定不做这个维度。

### 如果要做，建议的顺序（按「价值/成本」）

1. **审计视图**：`High Risk / 有告警 / 未审` 三个筛选 + 详情里展开 `categories`（会执行命令、会下载外网文件、易被提示注入）。
   数据全在本地，零新请求，是「装之前先看一眼」最实用的东西。
2. **上游话题 + 相关技能**：都是技能页上的现成内容，抓页面时顺手解析，零额外请求；话题可以补进分类（当「官方话题」标签）。
3. **官方精选视图**：87 家厂商按总安装量排，带 featured skill —— 「做这个产品的人教你怎么用」。
4. **本周上升 / 此刻最热**：给目录加两个动态入口；`hot` 数值小，建议只做 `trending`。
5. 其余（按仓库浏览、文件树、语义搜索兜底）按需。

## 6. 库存 / 激活 / 召回 三层

**先说一句现状（2026-10-21 核实）**：DSH 核心**没有技能启用/停用的持久化存储**——`ctx.skills` 只有 `registerProvider / register / list / snapshot / get / collect`，全 asar 搜不到 activation 之类；唯一的开关是 SKILL.md frontmatter 的 `disable-model-invocation` / `user-invocable`。所以「装/不装」由**文件在不在技能根里**决定（见 §8.4），插件层的「激活集合」只是面板预览，不是安装。

| 层 | 位置 | 成本 | 谁能看见 |
|---|---|---|---|
| 安装（真正的） | `<项目>/.agents/skills/<slug>` / `~/.agents/skills/<slug>` | 磁盘 + 每次会话的 name/description | DSH 技能目录（宿主自带扫描根，rank 200 / 500） |
| 正文备份 | `~/.dsh/skills-center/library/<id>/SKILL.md` | 仅磁盘 | 只有本插件面板预览 |
| 激活（历史机制，降级保留） | `activation.json` + `ctx.skills.registerProvider`（rank 700） | — | DSH 技能目录（仅当同一条同时有正文备份） |
| 召回 | 注册运行时技能 `skills-center`（宿主每步把 name + description 拼进可用技能列表）+ 一段静态 `systemPrompt.section`（**最小版已实现**）；卡片 `hook` 一行的按需注入仍未做 | 一条技能名 + 一句描述 | DSH 技能目录 + 系统提示 |

- `library/` + `activation.json` + rank 700 provider 早于官方 skills CLI 存在，现在**只作为「面板预览用的正文备份」**，不再叫「安装」；对外安装一律走 §8.4 的 CLI 路径。
- 不往 `~/.agents/skills` 软链的理由仍然成立（不污染用户手工维护的根、provider 可按会话切换、50 上限可强制截断），但**这不是安装路径**——安装就是真的把目录放到技能根下。
- **上限策略**：激活数 > 50 时按 `S` 分排序，只注入前 50 的钩子，其余仅可检索。理由：全量注入会稀释指令注意力，反而加剧"想不起来用"。

## 7. 卡片文案规范（重要，来自实拍反馈）

**字段固定为 7 项，顺序不变**：`名称` / `介绍` / `用途` / `注意事项` / `安装数` / `8 周趋势` / `来源`。（用户 2026-10-20 把第 4 项从「使用注意事项」缩成「注意事项」；详情弹层里另有「评分」「第三方安全检查」「安装命令」「唯一标识」四块补充信息。）

字段固定不等于填表腔。第一版用"一句话 / 什么时候用我 / 它到底给什么 / 依赖风险"这套自造小标题，用户评审结论是**"满满的 AI 味"**。问题出在措辞而非结构，因此字段之外另有五条写法要求：

1. **结论可以直接下判断**：`装` / `别装` / `看情况` / `只在 X 项目里装`。禁止"建议根据实际需求评估"。
2. **只写能验证的事实**：数字、原文引用、路径、命令。**禁止复述英文 description**——那是搬运不是介绍。
3. **段落长度随信息量走**。两行能说完就两行。整齐划一是假味来源。
4. **允许带态度**："36 万人装了个空壳，八周还涨了 35%。"
5. **不升华**。删掉"这正是……的原因"这类总结句，让事实自己收尾。禁止"专治 / 逼出 / 无死角 / 一站式 / 深度赋能"。

`介绍` 回答"这是个什么东西、它实际交付了什么"；`使用注意事项` 只放会让人装错的坑（薄壳、转发壳、废弃、付费 key、外部 CLI、fork 重复、空 description）。**薄壳（正文 <500 字）、转发壳（正文指向别的技能）、废弃（正文含 deprecated/compatibility）必须显式标注**——这三类占头部安装量的比例不低，光看安装量会全部装错。

生成 prompt 里把 SKILL.md 正文与 `files[]` 清单一起给模型，要求先答"实际交付了什么"，再答"它要求什么前提"，最后才写判断。

## 8. 插件形态

包名 `dsh-skills-center`，cordis patch 挂载：

```yaml
# cordis.patch.yml
- insert:
    - id: skills-center
      name: 'dsh-skills-center'
```

```js
export const name = 'dsh-skills-center';
export const inject = ['tools', 'skills', 'webServer'];
export function apply(ctx, config) { /* … */ }
```

**工具清单**（刻意压到 4 个，避免工具列表膨胀）：

| 工具 | 用途 |
|---|---|
| `skill_search` | 在本地全量目录里检索（含中文名/中文简介），返回 `id + 中文一句话 + verdict + S` |
| `skill_card` | 取某技能完整中文卡片（含依赖、告警、fork 情况） |
| `skill_activate` | （历史机制，现降级为面板预览）把 `library/` 里的正文备份加入激活集合（受 50 上限约束） |
| `skill_sync` | 从远端快照拉新目录替换本地副本（`mode: 'replace'`），返回条数/快照时间/来源 |

**远端同步契约**（`lib/sync.js`）：

- 目录来源：`DSH_SKILLS_CENTER_CATALOG_URL` > 落盘 `meta.json` 里记录的 sourceUrl > 默认 `https://dsh-skills-center.vercel.app/api/catalog`。
- 落盘：`~/.dsh/skills-center/catalog/catalog.json` + `catalog.prev.json` + `meta.json`（sourceUrl、etag、fetchedAt、count、sha256）。读取顺序 prev → current → 内置 `data/catalog.json`，首次同步时 `prev` 不存在也不影响。
- 事务：先校验（JSON 可解析、`skills` 数组、条数 >0、字段扫描、≤64MB），再写 prev、再原子写 current（tmp + rename）。远端 304 时不落盘、不动缓存。
- 只有 `mode: 'replace'`，不做 merge——远端是 skill id 全集，合并会留下已下架的僵尸条目。
- 网络失败（fetch throw）时若本机有 `curl`，回退用 curl 再试一次，并把失败原因带上。

**Web API**：`ctx.webServer.register({kind:'prefix', path:'/api/dsh-skills-center'})`，供 GUI 浏览榜单与卡片。
路由（`/api/dsh-skills-center` 前缀）：`GET /`（榜单页，`lib/page.js` 现场渲染，目录内联、无前端构建）、`GET /status`、`GET /search`、`GET /list`、`GET /card`、`GET /body?id=|?sha=`（技能正文）、`GET /local[?project=]`（本机已装技能 + 扫描根）、`POST /install`、`POST /uninstall`、`POST /sync`。
**审批**：`ctx.on('tools/pre-execute')` 对 `skill_activate` 要求确认（会改变系统提示内容）。

## 8.1 采集端（`api/collect.js` + `collector/`）

- 触发：Vercel Cron `0 5 * * *`（Hobby 只允许每天一次）打 `GET /api/collect`；手动补跑用 POST，同一份 `run()`。必须先过 `CRON_SECRET`（缺失 503、错误 401、常量时间比较），否则就是一个谁都能触发烧额度的端点。
- OIDC：token 只在 handler 内从 `x-vercel-oidc-token` 头或 `getVercelOidcToken()` 取，**模块级不许读 `process.env.VERCEL_OIDC_TOKEN`**（有测试做回归守卫）；上游只认 `Authorization: Bearer`。
- 两段式：目录段（`LIMIT_RECORDS=3000` 条，按安装量降序 6 页并发 ≈ 8s）→ 富集段（每目标 detail + audit 两个请求，受 `MAX_REQUESTS`/`MAX_RUNTIME_MS` 双闸门裁剪）。**截断只降富集深度，不丢记录**：没富集的条目保留列表级数据（`score.A=0.5` 中性、无 hash/正文），并如实回 `truncated` + `skipped_budget/skipped_deadline`。
- **实测规模（2026-10-21 线上）**：上游 `list_total` 是 **93,036** 条，目录段取前 3000（`LIMIT_RECORDS=3000`）→ 规划去重 **802** 条（`deduped`），经收录门禁后 **count 3879**；富集名额一轮 497 个（`MAX_REQUESTS=1500` 减列表 6 + curated 1，约 3 请求/条），本轮请求 1458 / 1500；每次靠 `previous` 目录继承上一轮已富集的结果（`inherited_enriched=5121`），覆盖率逐日爬升而不是一次到位。
- Hobby 的现实：60s 上限下富集 497 个头部要 ~120–200s，靠 `maxDuration` 与 `MAX_RUNTIME_MS` 兜住；想一轮覆盖 top 300 需要 Pro。
- **正文发布**（`ecc27d9`、`12f6ba7`）：正文先写远端再让目录声称已入库；GitHub `bodies` 分支为主（`collector/publish-github.mjs`，需 `GH_TOKEN` / `GH_REPO`），Vercel Blob 仅作可选回退；两条发布路径都失败才让采集接口 500。线上 store 被停用（`This store has been suspended.`）后已不依赖 Blob。
- 产物大小：本轮 `payload_bytes ≈ 7,655,253`（≈7.3MB），贴着 4.5MB 函数响应上限，所以目录只走「先传文件、再回 302」：`/api/catalog` 302 到仓库 `catalog` 分支的 raw 地址，不在函数里转发字节；响应会给一条 `payload … close to the 4.5MB limit` 警告。
- 上传：`validateCatalog()` 不过就一个字节都不写；过了先写不可变快照（Blob `catalog-<ISO>.json` / GitHub 单提交）再更新指针（`catalog-latest.json` / `catalog-meta.json`）。
- 失败一律非 2xx + `{ok:false, stage, error, elapsed_ms, stats}`，`stage ∈ config|auth|token|collect|validate|upload`。
- 富集顺序是 **detail → audit**，不能并发：detail 一 404 就 reject，而 audit 请求还在限流 sleep 里照样会发出去（白烧一次额度，且落地晚于 `collect()` 返回，让 `requests.used` 在 21/22 之间随机）。

## 8.2 中文卡片层（`data/zh.json`）

- **两层**：`tier: "hand"`（人工精写，300 条，`data/zh.json`，由 `data/zh/part-1..6.json` 各 50 条合并；缺 `tier` 时按 `hand`）/ `tier: "auto"`（机器生成层，目标覆盖目录全部条目，按批推进）。
- **进度（2026-10-21）**：hand 300 + auto 首批 25 = **325/3879**（auto 首批 25 条已合入 `data/zh/part-7.json`；`data/zh.json` 现 325 条、`tier` 计数 hand 300 + auto 25、`generated_at 2026-10-21T08:29:46Z`）。没覆盖的条目如实写「中文卡未覆盖」：有上游 `description_en` 就截断照抄，什么都没有就直说只有名称/装量/审计——不许拿占位符糊过去。
- **流水线**：`tools/zh_fetch_bodies.mjs`（正文抓到本地缓存当素材）→ `tools/zh_generate.mjs plan`（按批 25 条产出待写输入 `in-<from>-<to>.json`）→ 写手/模型回填 `out-<from>-<to>.json` → `check`（长度、禁用词、`tier`、**能力词必须在正文里出现**）→ `apply`（合并进 `data/zh/part-N.json`，幂等）→ `tools/zh_merge.mjs`（汇总进 `data/zh.json`，保留 `tier`）。
- 校验口径：`name_zh` 2–10 字且禁止中英混排，`intro` 60–500、`usage` 20–300、`notes` ≤300；禁用词「专治 / 逼出 / 无死角 / 一站式 / 深度赋能 / 赋能 / 颠覆 / 神器 / 王炸 / 闭眼入 / 碾压 / 吊打」；`tools/zh_validate.mjs` 另做 `tier` 与正文溯源校验。
- 贴法是**按 id**（`collector/pipeline.mjs:189-190`）：fork 合并后 `hash` 会随正文变化，`id` 才是稳定身份；老数据按 hash 写的也认，两条路都查一遍。
- `data/zh.json` 是构建期 `import`，随函数打包；采集时贴到每条记录上（`name_zh` 拍平 + `zh: {intro,usage,notes}` 整块），随目录进 `catalog` 分支。

## 8.3 GUI 面板（浏览器半边）

用户 2026-10-20 反馈「重启后看不到技能中心」——插件此前只有工具和 HTTP 路由，没有任何 UI。补一个 client 半边，契约全部来自 `cordis-plugin-development` 技能与已装的 `dshmarket` / `dsh-skills-manager`：

- **模块形状**：`client/client.js` 手写、不编译，只调 `window.__ModuleLoader__.load({ id, factory })`，`id` **必须逐字等于包名** `dsh-skills-center`（宿主靠它对上 package.json 的 `dsh.client`）；`factory(require)` 只允许 `require('react')`。manifest 在 `package.json`：`exports["./client"]` + `dsh.client = {platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-theme"]}`（照抄 `dshmarket` 那三个**已证实在本 profile 能加载**的包名）。模块自己声明 `inject: ['slots','locale']`。
- **两个 slot 组成一个入口**：`sidebar.panellist`（list，root）注册 `{id:'skills-center', order, label, locale}` 只负责画图标；`main` 注册 `{key:'skills-center'}` 画画板。**`main.key` 必须等于 `sidebar.id`**，否则点了图标没有面板（`dshmarket` 用 `dsh-market` 这同一套）。注册包在 `ctx.slots.inject('sidebar.panellist', …)` 里，老宿主没有这个 slot 时整块不注册而不是抛错。
- **数据只走插件自己的只读 JSON**：`GET /api/dsh-skills-center/list?q=&limit=&offset=&zh=1&filter=&sort=installs|S|trend|name&dir=desc|asc`（默认 `installs`，取数口径 `installs_merged ?? installs`），返回 `{version,total,matched,offset,limit,sort,dir,filter,active,maxActive,rows[]}`。每行只带一张卡要用的字段（`id/slug/name/name_zh/source/source_kind/installs/installs_merged/trend_pct/S/score/verdict/flags/has_zh/description/official/curated/enriched/first_seen/audit/install_hint`）——整条记录连正文发过去，七千多行会撑到几 MB；`limit` 硬上限 500。点卡片再打 `GET /card?id=` 取整卡。
  - `filter` 取值：`zh`（有中文卡）/ `official`（official 或 curated）/ `risky`（有 flags，或审计里出现 warn/fail）/ `enriched`（抓过详情、有 hash）。
  - `install_hint` **只在 `source_kind === 'github'` 时给** `npx skills add <source> --skill <slug>`；域名来源（`open.feishu.cn` 这类）给 null——宁可什么都不显示，也不给一条跑不通的命令。
  - `audit` 折成计数 `{judged,pass,warn,fail}`：卡片上写「第三方安全检查 4/5」，详情弹层里才逐条列 provider 与 riskLevel。
- **版式**（用户 2026-10-20 拿插件市场截图连提两轮：先是「我想要的是类似这样的」，再是「内容两侧要有自适应留白，加载更多不合适」）：顶部状态行 + 工具条（搜索 / 排序下拉 / 升降切换）+ 筛选胶囊 + **卡片墙** + 底部分页。三条量化后的硬规则：
  - **内容栏限宽 1180px 并居中**（`.dsc-inner{margin:0 auto}`）：页头、卡片墙、底栏共用同一栏，两侧留白随窗口自适应。之前拉满整屏会排成 5 列，实测"像墙"。
  - 卡片最小 360px、间距 20/18 → 常见窗口下 3 列；卡片内边距 19/21、内部间距 13。
  - **底栏是分页不是「加载更多」**：`上一页 / 页码窗口（首末页 + 当前页 ±1，中间省略号）/ 下一页`，右侧「第 X / Y 页」与「每页 24/48/96/192」（默认 24，取数走 `offset=(page-1)*size`）。改条件时页码回到 1，换页后列表滚回顶部。
  - 数据侧就一条接口：`/list` 返回 `matched`（满足条件的总数）与 `total`（目录总条数），前端据此算总页数；每页 24 条时 3879 条约 162 页。
  - 点卡片弹出居中的详情弹层（Esc、点遮罩、点关闭都能关）。搜索/筛选/排序/页码变化时 200ms 防抖重拉，并用请求序号丢弃过期响应。
- **样式与文案**：颜色只用宿主主题 token（`--dsw-alias-*`），不写死色值；文案走 locale 服务（`ctx.locale.register(ns,'zh'|'en',dict)` + `bind(ns)`），注册失败时 `t()` 直读中文词典兜底，保证面板不会因为 locale 出问题就变一片 key。样式用 `<style>` 元素随组件挂载注入，类名带 `dsc-` 前缀。
- **说明入口（`? 说明`）**：用户问过「S 分是什么」「审计是什么」——这类问题不能只留在聊天记录里。页头放一个 `? 说明` 按钮打开弹层，按「总览 → S 分算法（H/T/C/A 逐项）→ 安装数/趋势口径 → 审计（五家 provider、pass/warn/fail、fail 计入分母、pass ≠ 安全）→ 卡片标签（官方/精选/中文卡/有正文 + 六个风险标记逐条解释）→ 数据更新频率」分节讲清。分节标题用 `.dsc-help-h`（13.5/600），正文 `max-width:62ch` 控制行宽；术语用 `.dsc-help-row` 的定义列表样式。另有两处内联口径：卡片 tooltip（S 分 / 审计 / 风险标记 / 装量 / 趋势）与详情弹层里结论下的 `.dsc-note`（「pass 不等于安全」「S 分是本插件合成的」）。
- **面板目前只读**：它不写激活集合、不下载正文；`/local` `/install` `/uninstall` 三个路由已在宿主侧实现（§8.4，`tests/install-routes.test.mjs` 端到端），但 `client/client.js` 的「本地」视图与安装/卸载按钮还没接到 Panel 上，GUI 里还没有「点一下就装」。装/卸请用 §8.4 的命令或在 Web API 上调用。
- 测试：`tests/client.test.mjs` 用假 `__ModuleLoader__` + 假 react 跑模块形状、两个 slot 的 id/key、fetch → 卡片墙（`+6.4%`/`1,003,686`/标签）、以及点卡片 → 详情弹层（审计 provider、安装命令、关闭按钮）；`tests/smoke.mjs` 里对 `/list` 的筛选、升降、`install_hint` 与 `audit` 计数各有一条断言。

## 8.4 本地管理与安装/卸载（`lib/installer.js` + 四个路由）

**安装走官方 skills CLI**，不自建安装器（§9 仍然成立）：

```
npx skills@1.7.4 add <owner/repo> --skill <slug> -a codex --copy [-g] -y
```

**落点表**（`rootDescriptors`，与 DSH 扫描根一致）：

| rootId | 路径 | rank | 本插件可写 |
|---|---|---|---|
| `project-dsh` | `<project>/.dsh/skills` | 100 | 否 |
| `project-agents` | `<project>/.agents/skills` | 200 | **是**（项目级安装落点） |
| `user-dsh` | `~/.dsh/skills` | 400 | 否 |
| `user-agents` | `~/.agents/skills` | 500 | **是**（全局安装落点） |

`MANAGED_SCOPE = { project: 'project-agents', global: 'user-agents' }`。装完 DSH 立刻能用（这两条本来就是扫描根）、`/技能名` 可调、卸载就是删目录。项目根 = `findProjectRoot(cwd)`，从当前目录向上找最近的含 `.git` 的祖先（找不到就返回 `cwd` 本身）。

**`lib/installer.js` 接口**（子进程与 fs 由调用方注入，便于离线单测）：

| 导出 | 签名（要点） | 返回 |
|---|---|---|
| `rootDescriptors` | `({ projectDir, home })` | `[{ id, scope, dir, rank, managed, label }]` |
| `listInstalled` | `({ projectDir, home, fsImpl })` | `{ ok, roots, skills }`（判据是 `<root>/<slug>/SKILL.md` 存在，不看退出码） |
| `installArgs` | `({ source, slug, scope })` | argv：`['-y','skills@1.7.4','add',source,'--skill',slug,'-a','codex','--copy','-y']`（global 在末尾 `-y` 前插 `-g`） |
| `uninstallArgs` | `({ name, scope })` | 同形的 `remove` argv |
| `installSkill` | `({ id, source, slug, scope, projectDir, spawn, fsImpl, log })` | `{ ok, stage, exitCode, stdout, stderr, dir, rootId, scope }`（`stage ∈ parse\|spawn\|verify`） |
| `uninstallSkill` | `({ name, scope, projectDir, spawn, fsImpl })` | `{ ok, scope, removed[], stillInstalledElsewhere[], exitCode, stdout, stderr }` |
| `findProjectRoot` | `(cwd, fsImpl)` | 绝对路径 |

**四个路由的请求/响应形状**：

| 路由 | 请求 | 成功响应 | 失败 |
|---|---|---|---|
| `GET /body?id=<catalogId>` 或 `?sha=<sha256>` | — | `200 text/markdown`；命中本地缓存带 `x-body-via: cache`，远端取回 `remote`；缓存路径 `~/.dsh/skills-center/bodies/<sha256>.md` | 404 找不到技能/正文 |
| `GET /local[?project=<绝对路径>]` | — | `200 {ok, project, projectSource:'host'\|'query', roots[], skills[]}` | — |
| `POST /install` | `{ id, scope:'project'\|'global', project? }` | `200 {ok, scope, dir, rootId, exitCode, stdout, stderr, id, name, installs_total, project}` | `502 {ok:false, error, code?}` |
| `POST /uninstall` | `{ name, scope, project? }`（`name` 必须匹配 `^[a-z0-9][a-z0-9-]*$`） | `200 {ok, scope, removed[], stillInstalledElsewhere[], name}` | `502 {ok:false, error}` |

- **卸载按作用域判定**：项目级卸载不会因为全局还有同名而报失败，但会在响应里列出 `stillInstalledElsewhere`。
- 成功安装/卸载后都会调 `ctx.skills?.invalidateCache?.()`，让宿主立刻重扫（缓存键是 `{cwd, scopes, revision}`，见 §12.1）。
- **Web 路由拿不到会话目录**：`/local` 优先用宿主给的默认目录（`projectSource:'host'`），带 `?project=` 时用用户改的绝对路径（`projectSource:'query'`），面板显示默认目录并允许改。

**严格门禁的判定公式**（`collector/collect.mjs` 的 `bodyGateStats`，默认 `waterline = 2000`）：

```
head        = 按 (installs_merged ?? installs) 降序取前 2000
head_stored = head 里 body_length && body_sha256 && body_v 都有的条数
coverage    = round(head_stored / head_total, 3)
strict      = coverage >= 0.95          →  buildCatalog({ requireBody: strict })
```

水位内「正文已入库」覆盖率 ≥0.95 才开严格过滤（`requireBody`）；不到就照旧全量收录，避免一轮采集把目录掏空。2026-10-21 线上：`head_total 2000 / head_with_body 1948 / head_stored 1948 / coverage 0.974 / strict true`，`buildCatalog` 因此丢掉 `no_body 4426 / thin_body 10 / no_description 24`，目录从改造前 7800–8100 落到 **3879**。硬门槛四条见 PLAN.md §1.1（有正文、正文 ≥300 字符、有非空 `description`、有内容 hash）。

## 9. 不做

- 不做排行榜网站、评分评论、上传发布
- 不把第三方 SKILL.md 正文 vendor 进仓库（只存 hash + 元数据 + 来源 URL，规避 license）
- 不写自己的安装器
- 不在插件里直连 `/api/v1`（拿不到 OIDC）

## 10. 里程碑

- **M0 目录**：Vercel 采集函数 + `catalog.json`，能按装量水位收录全量目录（2026-10-21 本轮 count 3879）——**已完成**；目录与正文分发走 GitHub `catalog` / `bodies` 分支（§5.4、§8.1）
- **M1 中文层**：**两层**——hand 300 条（用户 2026-10-19 定 installs top 300）+ auto 机器生成层向全目录推进；当前 625/3960（auto 325），扩容是数据活（§8.2）——**hand 已完成，auto 进行中**
- **M2 插件**：4 个工具（含远端同步）+ provider 激活 + GUI 榜单页 + GUI 面板（左侧栏入口，见 §8.3）——**已完成**
- **M3 召回**：最小版已实现——`lib/index.js` 用 `ctx.skills.register()` 注册运行时技能 `skills-center`（宿主每步把 name + description 拼进可用技能列表，模型第一步就能看到），外加静态 `ctx.systemPrompt.section`；`agent/pre-step` 强版本（按首条消息命中后注入一行）与「每卡 15 字钩子 / 只注入已激活项」仍是设计——**最小版已完成**

M1 依赖 M0 的 hash，M2 可先在本地样例数据上开发（`samples/digest2.json` 已有 12 条真实数据）。

## 11. 未决

1. ~~采集挂 Vercel Cron 还是 GitHub Action~~ → 已定 Vercel：`api/collect.js` 由 Vercel Cron 定时触发，OIDC 拿 `skills.sh` 鉴权；目录与正文发布到 GitHub（`catalog` / `bodies` 分支），同一份文件既做快照又给插件当拉取源；Vercel Blob 降为可选回退（线上 store 已被停用）。

## 12. 已验证的插件契约

原"`registerProvider` 签名未验证"一项已由已安装的 `@michengai/dsh-skills-manager` 源码实证（它消费同一套 host API）：

```js
// ~/.dsh/profiles/desktop/node_modules/@michengai/dsh-skills-manager/lib/index.js:233 / :312
ctx.skills.registerProvider((control) => ({ name, list(options), get(candidate, options) }))
// control = { invalidate(), signal }；工厂同步返回 provider；registerProvider 返回 dispose
```

- candidate 形状（同包 `lib/core.js:2725 listProviderCandidates`）：`{ name, description, invocation:{modelInvocable,userInvocable}, provider, source, rank, locator, resourceBase:{kind:'directory',path}, path, metadata }`
- get 返回 skill 形状（`lib/core.js:2785 getProviderSkill`）= candidate 字段 + `content`
- 工具注册：`ctx.effect(() => ctx.tools.register({ name, description, parameters, output:{schema, render}, execute, presentCall }), label)`
- **结论：provider 方案成立，不需要软链 `~/.agents/skills`。**

因此 M0 骨架可直接在本机跑通：`lib/provider.js` 的 `createProvider()` 同步返回工厂，`list/get` 内部异步读 `library/`，未激活或库存无正文的技能不对外声称可用。

**`rank` 的梯子**（越小越优先，同层内比较，`dsh-skill:519-521`）：project `.dsh` 100 / project `.agents` 200 / runtime 250 / custom dirs 300 / user `.dsh` 400 / user `.agents` 500 / bundled 600（`dsh-skill-filesystem:20-24`、`dsh-skill:21-23`）。本插件取 **`DEFAULT_RANK = 700`**：比所有原生根都靠后，激活的技能默认**不会**盖住用户自己写的同名技能；想让它优先就用 `config.rank` 调低。

## 12.1 一方源码（app.asar）里读到的硬约束

第二条独立证据：直接解析 `D:\dsh\resources\app.asar` 拿到 `@deepseek-ai/dsh-skill`（技能注册表）、`dsh-tools`、`dsh-tool-skill`（catalog 注入）、`dsh-skill-filesystem`（唯一的前置元数据解析者）——`~/.dsh/profiles/node_modules/@deepseek-ai/*` 全是死软链，asar 可用 `dataStart = 8 + u32(4)`、header JSON 在 `16..16+u32(12)` 解出。

- **工厂必须同步**（`dsh-skill:147-183`）：`provider = create(control)` 之后立刻读 `provider.name`，全程没有 `await`。返 Promise ⇒ `name === undefined` ⇒ 注册在 `undefined` 名下，随后被 `"provider.list is not a function"`（`:354`）跳过，什么都不暴露。
- **候选不合格会 throw**（`dsh-skill:452-464`）：`name` 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`:17`）；`description` 非空；`source` 字符串；`rank` 有限数字；`provider` **逐字等于**注册名；`invocation` 若给出必须是 `{modelInvocable:boolean,userInvocable:boolean}`。而 `validateCandidate` 的调用点（`:360`）**在包 `provider.list` 的 try 之外**（`:349-355`）——一个坏候选会让**所有** provider 的目录当场消失。`locator` 完全不校验，只原样回传。
- **`get()` 收到的是 `list()` 返回的那个对象本身**（`:256`）。返回的 definition 会再过一次 `validateDefinition`（`:471-490`），其中 `content` 必须是字符串；**host 从不剥 frontmatter**（YAML 只在 `dsh-skill-filesystem:673` 解析），所以 provider 必须自己剥。`definition.name !== candidate.name` 时静默判定"技能不存在"并清缓存（`:259-262`）。
- **`resourceBase` 决定相对路径怎么解析**（`:71-80`）：丢了就退化成"资源由 provider 托管"，技能里的 `../lark-shared/SKILL.md` 这类引用会失效。
- **缓存**：collectCache 以 `{cwd, scopes, revision}` 为键、上限 128（`:18`、`:395-401`）；`invalidate()` 直接 `revision += 1` + 清缓存（`:153-156`、`:376-380`），无防抖。→ **`invalidate()` 是库存文件变动后唯一能生效的路径。**
- **没有技能数量上限**：唯一的截断是 catalog 注入时的 `catalogDescriptionMaxLength = 500`（`dsh-tool-skill:768`、截断在 `:1087-1090`），且 catalog 每次 digest 变化都**全量重发**（`:946-963`）。→ 每个激活技能的 description 都是持续成本，`MAX_ACTIVE = 50` 是我们自己的闸门而非 host 约束；中文 `intro` 要压在 500 字内，否则被截成 `...`。
- **工具注册只强校验两件事**（`dsh-tools:2974-2983`）：`output.render` 是函数、`output.schema` 在受支持的 JSON Schema 子集内。`parameters` 不校验但必须留在子集里，否则模型侧签名类型退化成 `unknown`（`:1768-1774`）。`execute` 的返回值按 `output.schema` 校验后，`render` 必须给出无损投影（`:3637-3648`）。

**据此做的加固（`lib/provider.js`）**：slug 一律过 `toSkillName()` 收敛成 kebab（`Bad_Slug`→`bad-slug`、`x y`→`x-y`）；收敛不出或 `description` 为空直接丢；归一后重名只留第一条；`list()` 整体 try、**绝不抛**；`get()` 原样返回 `candidate.name` 并保留 `resourceBase`。`tests/smoke.mjs` 里照抄了 host 两个校验器逐条断言，并用一份畸形目录（大写+下划线+空格+空 description+归一撞名）验证坏数据拖不垮目录。

## 13. 装进 profile 的实测（2026-10-19）

`dsh plugin --profile desktop add D:\dsh-skills-center` **会失败**，且与本源无关：

```
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @dsh-ops/bash-win32-x64@0.2.1
... This error happened while installing the dependencies of dsh-ops@0.3.0
```

即 desktop profile 里既有的 `dsh-ops@0.3.0` 依赖一个在 npmmirror 上不存在的可选平台包（镜像上只有 `0.0.0-stage`）。任何 `pnpm add` 都会重解析整棵依赖树，因此撞上它。`--dump-config` 也拒绝了 desktop（`error: profile "desktop" is managed exclusively by the Electron application`）。

**绕开办法（已验证，三步，无需 pnpm）**：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加 `"dsh-skills-center": "link:D:/dsh-skills-center"`，并把 `"dsh-skills-center"` 追加到 `dsh.profile.bundles`；
2. 在 `~/.dsh/profiles/desktop/node_modules/` 里建 junction 指向仓库：`fs.symlinkSync('D:\\dsh-skills-center', link, 'junction')`（bash 里调 `mklink /J` 因引号转义会失败，用 node 建）；
3. 重启 GUI。

**已验证的事实**（在临时 `scratch` profile 上做完整链路，做完即删）：`--dump-config` 里出现 `# == dsh-skills-center` / `- id: skills-center / name: dsh-skills-center`；真的 boot 起来后 `GET /api/dsh-skills-center/status` 返回 `{"version":"sample-2026-10-19","count":12,...,"catalogFile":"D:\\dsh-skills-center\\data\\catalog.json"}`，说明插件在真实 DSH 进程里 apply 成功、catalog 读的是仓库内数据；写入 `activation.json` 后同一接口的 `active` 立即反映 → 状态是文件驱动的实时读，不需要重启。



