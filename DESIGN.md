# dsh-skills-center 设计

## 1. 定位与边界

**一句话**：把 skills.sh 上两万个技能变成一份可离线浏览、带中文判断、能按需唤醒的本地目录。

**与既有 `@michengai/dsh-skills-manager` 的分工**（必须先划清，否则重复造轮子）：

| 能力 | skills-manager 已有 | 本项目 |
|---|---|---|
| 在线搜索 skills.sh | 有（`/api/search`，仅 q 参数） | **不做** |
| 下载/安装技能 | 有（含 lockfile、仓库管理） | **不做**，调用它或 `npx skills add` |
| 全量目录（2 万条）+ 趋势 | 无 | **做** |
| 中文介绍/判断/该不该装 | 无 | **做** |
| 跨 owner fork 去重 | 无 | **做** |
| 库存 ↔ 激活分离、召回钩子 | 无（它管的是"装进来") | **做** |

结论：本项目是**目录层与判断层**，安装与在线搜索交给现有插件。

## 2. 三个痛点 → 三个机制

| 用户原话（m00142） | 机制 |
|---|---|
| "不知道它们存在" | 离线全量 `catalog.json` + 分类/榜单视图，无需联网即可翻 |
| "不一定想得起来用" | 每张卡生成 15 字以内的**召回钩子**，只把已激活技能的钩子注入系统提示 |
| "提前下载备用" | 库存层只落磁盘（`library/`），不进 skills 根，不占上下文 |

## 3. 数据链路

```
skills.sh /api/v1  ──(Vercel Cron + OIDC)──▶  catalog.json / zh.json / trend.json
                                                  │
                                                  ▼  首启拉一次，之后按 version 增量
                                        ~/.dsh/skills-center/
                                          catalog/   (只读缓存)
                                          zh/        (中文层，按 hash 缓存)
                                          library/   (已下载技能原文)
```

**采集端**（Vercel Serverless，拿得到 `VERCEL_OIDC_TOKEN`）：

| 步骤 | 请求 | 产物 |
|---|---|---|
| 1 | `GET /api/v1/skills?view=all-time&per_page=500` × ~17 页 | 全量 8420 条：id/source/slug/installs |
| 2 | `GET /api/v1/skills?view=hot` | 叠加 `installsYesterday` / `change` |
| 3 | `GET /api/v1/skills/curated` | 87 owner / 342 技能打 `curated` 标 |
| 4 | `GET /api/v1/skills/audit/{id}`（仅分层内约 1500 条） | 5 家审计 status/riskLevel |
| 5 | `GET /api/v1/skills/{id}`（同上 1500 条） | `hash`（SHA-256）+ `files[]`（取 SKILL.md 正文供中文生成） |

限流 600 req/min：8420+342+1500×2 ≈ 1.2 万请求，分 20 分钟发完，落在一次 Cron 内。

**产物 schema**（`catalog.json`，按 200 条分片避免单文件过大）：

```json
{
  "version": "2026-10-19T08:00:00Z",
  "count": 8420,
  "skills": [{
    "id": "vercel-labs/agent-skills/vercel-react-best-practices",
    "canonical": true,
    "aliases": ["someone/fork/vercel-react-best-practices"],
    "hash": "9f2c…",
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

### 5.1 功能分类（`lib/categories.js`）

用户 2026-10-20 拿插件市场的截图问「分类能不能按技能属于的功能来分」。**skills.sh 没有分类字段**，
上游只给 id/slug/installs/hash/files，描述也就几百条有。所以只能自己分类，并且必须承认它是**推断**：

- **为什么用关键词规则而不是模型**：7600 多条里只有几百条有描述（其余只有 slug/name），送模型既贵又不稳；
  规则可复现、可单测、离线可跑。分类菜单里明写「按技能实际功能自动分类（关键词规则，不是 skills.sh 官方字段）」——
  不许把它说得像上游字段。
- **分类是多标签**：一条技能可能既属于「前端与界面」又属于「测试与质量」，取分数最高的前 3 个；
  一个都没命中才落到「其他」（实测 24.4%，约 1866 条）。
- **三条踩出来的经验**：
  1. **必须词边界匹配**，不能裸子串：`test` 会命中 `latest`/`contest`，`doc` 会命中 `docker`。测试里专门钉了这类反例。
  2. **词表里不许放泛词**：曾把 `skill` 放进 AI 分类，结果 `find-skills` 被归成「AI 与模型」。`agent`/`api`/`model` 同理。
  3. **连字符要归一**：slug 里是 `code-review-checklist`，词表写的是 "code review"，
     所以匹配前把 `-`/`_`/`/` 都换成空格，词表也一起归一（`react-native`、`ci/cd` 因此都能命中）。
- **字段权重**：slug/name 各 3 分，source（owner/repo）2 分——`anthropics/claude-for-legal/*` 这种正文为空也能靠 owner 兜底；
  中文名 2 分；中文介绍与英文描述各 1 分。
- **两阶段匹配**（性能）：先只扫短字段；一个分类都没命中才去读长文本，并截断 600 字。
  整目录 7639 条实测 2.1s（两阶段之前 3.8s）。插件 `apply()` 启动时空转一次预热缓存，
  免得到第一次点开面板才卡 2s。
- **计数按整个目录算**，不随关键词/筛选变化——菜单要稳定，否则点一下菜单就洗牌。
  「其他」固定排最后：它条数最多，但它是兜底桶不是分类，排第一会让菜单第一眼就是「其他」。
- **界面**：前 12 个分类铺成 chips（`全部 7,639` 带头），长尾 + 「其他」收进「更多分类」下拉；
  质量筛选（有中文卡/官方精选/有风险信号/已抓正文）降到第二行小号 chips；下面一行写口径与匹配数。
- **工具侧**：`skill_search` 的每行摘要带上「分类 前端/设计」，让 agent 按功能筛而不是只看名字。

## 6. 库存 / 激活 / 召回 三层

| 层 | 位置 | 成本 | 谁能看见 |
|---|---|---|---|
| 库存 | `~/.dsh/skills-center/library/<id>/` | 仅磁盘 | 无人（默认） |
| 激活 | **不复制文件**，由插件 `ctx.skills.registerProvider` 只暴露激活集合 | — | DSH 技能目录（name+description 进系统提示） |
| 召回 | 卡片里的 `hook` 一行 | 每条约 15 字 | 系统提示（仅激活项） |

**关键设计**：激活态由插件内存/配置文件管理，**不往 `~/.agents/skills` 软链**。理由：
1. 软链会污染用户手工维护的技能根，卸载插件后留下垃圾；
2. provider 可以按会话/按项目切换激活集合，软链做不到；
3. 30~50 个上限是硬约束（每个技能 name+description 都进系统提示），provider 层可以强制截断。

**上限策略**：激活数 > 50 时按 `S` 分排序，只注入前 50 的钩子，其余仅可检索。理由：全量注入会稀释指令注意力，反而加剧"想不起来用"。

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
| `skill_activate` | 把库存技能加入激活集合（受 50 上限约束），并落盘到 `library/` |
| `skill_sync` | 从远端快照拉新目录替换本地副本（`mode: 'replace'`），返回条数/快照时间/来源 |

**远端同步契约**（`lib/sync.js`）：

- 目录来源：`DSH_SKILLS_CENTER_CATALOG_URL` > 落盘 `meta.json` 里记录的 sourceUrl > 默认 `https://dsh-skills-center.vercel.app/api/catalog`。
- 落盘：`~/.dsh/skills-center/catalog/catalog.json` + `catalog.prev.json` + `meta.json`（sourceUrl、etag、fetchedAt、count、sha256）。读取顺序 prev → current → 内置 `data/catalog.json`，首次同步时 `prev` 不存在也不影响。
- 事务：先校验（JSON 可解析、`skills` 数组、条数 >0、字段扫描、≤64MB），再写 prev、再原子写 current（tmp + rename）。远端 304 时不落盘、不动缓存。
- 只有 `mode: 'replace'`，不做 merge——远端是 skill id 全集，合并会留下已下架的僵尸条目。
- 网络失败（fetch throw）时若本机有 `curl`，回退用 curl 再试一次，并把失败原因带上。

**Web API**：`ctx.webServer.register({kind:'prefix', path:'/api/dsh-skills-center'})`，供 GUI 浏览榜单与卡片。
路由：`/`（榜单页，`lib/page.js` 现场渲染，目录内联、无前端构建）、`/status`、`/search`、`/card`、`/sync`（仅 POST）。
**审批**：`ctx.on('tools/pre-execute')` 对 `skill_activate` 要求确认（会改变系统提示内容）。

## 8.1 采集端（`api/collect.js` + `collector/`）

- 触发：Vercel Cron `0 5 * * *`（Hobby 只允许每天一次）打 `GET /api/collect`；手动补跑用 POST，同一份 `run()`。必须先过 `CRON_SECRET`（缺失 503、错误 401、常量时间比较），否则就是一个谁都能触发烧额度的端点。
- OIDC：token 只在 handler 内从 `x-vercel-oidc-token` 头或 `getVercelOidcToken()` 取，**模块级不许读 `process.env.VERCEL_OIDC_TOKEN`**（有测试做回归守卫）；上游只认 `Authorization: Bearer`。
- 两段式：目录段（`LIMIT_RECORDS=3000` 条，按安装量降序 6 页并发 ≈ 8s）→ 富集段（每目标 detail + audit 两个请求，受 `MAX_REQUESTS`/`MAX_RUNTIME_MS` 双闸门裁剪）。**截断只降富集深度，不丢记录**：没富集的条目保留列表级数据（`score.A=0.5` 中性、无 hash/正文），并如实回 `truncated` + `skipped_budget/skipped_deadline`。
- **实测规模（2026-10-20 线上首次跑通）**：上游 `list_total` 是 **93,043** 条，目录段取前 3000 → 去重 fork 后 **7572** 条（`deduped` 1554）；富集名额一轮只有 497 个（`MAX_REQUESTS=1500` 减去列表 6 + curated 1，约 3 请求/条），每次靠 `previous` 目录继承上一轮已富集的结果（本轮 `inherited_enriched=1217`），覆盖率逐日爬升而不是一次到位。
- Hobby 的现实：60s 上限下富集 497 个头部要 ~120–200s，靠 `maxDuration` 与 `MAX_RUNTIME_MS` 兜住；想一轮覆盖 top 300 需要 Pro。
- 产物大小：7572 条 + 300 条中文卡 ≈ **4.3MB**，贴着 4.5MB 响应上限，所以 `catalog-latest.json` 只从 Blob 直出（`/api/catalog` 走 302 重定向，不在函数里转发字节），响应里会给一条 `payload … close to the 4.5MB limit` 警告。
- 上传：`validateCatalog()` 不过就一个字节都不写；过了先写 `catalog-<ISO>.json`（不可变快照）再写 `catalog-latest.json`（指针）。
- 失败一律非 2xx + `{ok:false, stage, error, elapsed_ms, stats}`，`stage ∈ config|auth|token|collect|validate|upload`。
- 富集顺序是 **detail → audit**，不能并发：detail 一 404 就 reject，而 audit 请求还在限流 sleep 里照样会发出去（白烧一次额度，且落地晚于 `collect()` 返回，让 `requests.used` 在 21/22 之间随机）。

## 8.2 中文卡片层（`data/zh.json`）

- 只精做**安装量前 300 条**（用户 2026-10-19 定），其余 7200+ 条卡片如实写「中文卡未覆盖」：有上游 `description_en` 就截断照抄，什么都没有就直说只有名称/装量/审计——不许拿占位符糊过去。
- 写入流程：`tools/zh_source.mjs` 切 6 片（每片 50 条，带全字段事实）→ 写手产出 `data/zh/part-N.json` → `tools/zh_validate.mjs` 单条校验 → `tools/zh_merge.mjs` 合并成 `data/zh.json`（跨片重复 id / 超长 / 禁用词直接失败，不落盘）。
- 校验口径：`name_zh` 2–10 字且禁止中英混排，`intro` 60–500、`usage` 20–300、`notes` ≤300；禁用词「专治 / 逼出 / 无死角 / 一站式 / 深度赋能 / 赋能 / 颠覆 / 神器 / 王炸 / 闭眼入 / 碾压 / 吊打」。
- 贴法是**按 id**（`collector/pipeline.mjs:189-190`）：fork 合并后 `hash` 会随正文变化，`id` 才是稳定身份；老数据按 hash 写的也认，两条路都查一遍。
- `data/zh.json` 是构建期 `import`，随函数打包；采集时贴到每条记录上（`name_zh` 拍平 + `zh: {intro,usage,notes}` 整块），一起进 Blob。

## 8.3 GUI 面板（浏览器半边）

用户 2026-10-20 反馈「重启后看不到技能中心」——插件此前只有工具和 HTTP 路由，没有任何 UI。补一个 client 半边，契约全部来自 `cordis-plugin-development` 技能与已装的 `dshmarket` / `dsh-skills-manager`：

- **模块形状**：`client/client.js` 手写、不编译，只调 `window.__ModuleLoader__.load({ id, factory })`，`id` **必须逐字等于包名** `dsh-skills-center`（宿主靠它对上 package.json 的 `dsh.client`）；`factory(require)` 只允许 `require('react')`。manifest 在 `package.json`：`exports["./client"]` + `dsh.client = {platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-theme"]}`（照抄 `dshmarket` 那三个**已证实在本 profile 能加载**的包名）。模块自己声明 `inject: ['slots','locale']`。
- **两个 slot 组成一个入口**：`sidebar.panellist`（list，root）注册 `{id:'skills-center', order, label, locale}` 只负责画图标；`main` 注册 `{key:'skills-center'}` 画画板。**`main.key` 必须等于 `sidebar.id`**，否则点了图标没有面板（`dshmarket` 用 `dsh-market` 这同一套）。注册包在 `ctx.slots.inject('sidebar.panellist', …)` 里，老宿主没有这个 slot 时整块不注册而不是抛错。
- **数据只走插件自己的只读 JSON**：`GET /api/dsh-skills-center/list?q=&limit=&offset=&zh=1&filter=&sort=S|installs|trend|name&dir=desc|asc`，返回 `{version,total,matched,offset,limit,sort,dir,filter,active,maxActive,rows[]}`。每行只带一张卡要用的字段（`id/slug/name/name_zh/source/source_kind/installs/installs_merged/trend_pct/S/score/verdict/flags/has_zh/description/official/curated/enriched/first_seen/audit/install_hint`）——整条记录连正文发过去，七千多行会撑到几 MB；`limit` 硬上限 500。点卡片再打 `GET /card?id=` 取整卡。
  - `filter` 取值：`zh`（有中文卡）/ `official`（official 或 curated）/ `risky`（有 flags，或审计里出现 warn/fail）/ `enriched`（抓过详情、有 hash）。
  - `install_hint` **只在 `source_kind === 'github'` 时给** `npx skills add <source> --skill <slug>`；域名来源（`open.feishu.cn` 这类）给 null——宁可什么都不显示，也不给一条跑不通的命令。
  - `audit` 折成计数 `{judged,pass,warn,fail}`：卡片上写「第三方安全检查 4/5」，详情弹层里才逐条列 provider 与 riskLevel。
- **版式**（用户 2026-10-20 拿插件市场截图连提两轮：先是「我想要的是类似这样的」，再是「内容两侧要有自适应留白，加载更多不合适」）：顶部状态行 + 工具条（搜索 / 排序下拉 / 升降切换）+ 筛选胶囊 + **卡片墙** + 底部分页。三条量化后的硬规则：
  - **内容栏限宽 1180px 并居中**（`.dsc-inner{margin:0 auto}`）：页头、卡片墙、底栏共用同一栏，两侧留白随窗口自适应。之前拉满整屏会排成 5 列，实测"像墙"。
  - 卡片最小 360px、间距 20/18 → 常见窗口下 3 列；卡片内边距 19/21、内部间距 13。
  - **底栏是分页不是「加载更多」**：`上一页 / 页码窗口（首末页 + 当前页 ±1，中间省略号）/ 下一页`，右侧「第 X / Y 页」与「每页 24/48/96/192」（默认 24，取数走 `offset=(page-1)*size`）。改条件时页码回到 1，换页后列表滚回顶部。
  - 数据侧就一条接口：`/list` 返回 `matched`（满足条件的总数）与 `total`（目录总条数），前端据此算总页数；每页 24 条时 7600 条约 319 页。
  - 点卡片弹出居中的详情弹层（Esc、点遮罩、点关闭都能关）。搜索/筛选/排序/页码变化时 200ms 防抖重拉，并用请求序号丢弃过期响应。
- **样式与文案**：颜色只用宿主主题 token（`--dsw-alias-*`），不写死色值；文案走 locale 服务（`ctx.locale.register(ns,'zh'|'en',dict)` + `bind(ns)`），注册失败时 `t()` 直读中文词典兜底，保证面板不会因为 locale 出问题就变一片 key。样式用 `<style>` 元素随组件挂载注入，类名带 `dsc-` 前缀。
- **说明入口（`? 说明`）**：用户问过「S 分是什么」「审计是什么」——这类问题不能只留在聊天记录里。页头放一个 `? 说明` 按钮打开弹层，按「总览 → S 分算法（H/T/C/A 逐项）→ 安装数/趋势口径 → 审计（五家 provider、pass/warn/fail、fail 计入分母、pass ≠ 安全）→ 卡片标签（官方/精选/中文卡/有正文 + 六个风险标记逐条解释）→ 数据更新频率」分节讲清。分节标题用 `.dsc-help-h`（13.5/600），正文 `max-width:62ch` 控制行宽；术语用 `.dsc-help-row` 的定义列表样式。另有两处内联口径：卡片 tooltip（S 分 / 审计 / 风险标记 / 装量 / 趋势）与详情弹层里结论下的 `.dsc-note`（「pass 不等于安全」「S 分是本插件合成的」）。
- **面板是只读的**：它不写激活集合、不下载正文。GUI 里「点一下就装」要等库存下载路径落地，否则按钮只会得到「库存里没有正文」（见 §6）。
- 测试：`tests/client.test.mjs` 用假 `__ModuleLoader__` + 假 react 跑模块形状、两个 slot 的 id/key、fetch → 卡片墙（`+6.4%`/`1,003,686`/标签）、以及点卡片 → 详情弹层（审计 provider、安装命令、关闭按钮）；`tests/smoke.mjs` 里对 `/list` 的筛选、升降、`install_hint` 与 `audit` 计数各有一条断言。

## 9. 不做

- 不做排行榜网站、评分评论、上传发布
- 不把第三方 SKILL.md 正文 vendor 进仓库（只存 hash + 元数据 + 来源 URL，规避 license）
- 不写自己的安装器
- 不在插件里直连 `/api/v1`（拿不到 OIDC）

## 10. 里程碑

- **M0 目录**：Vercel 采集函数 + `catalog.json` 分片，能拉全量 8420 条（含趋势/去重/打分）
- **M1 中文层**：**只精做 installs top 300**（用户 2026-10-19 定），其余条目留英文 description 占位、点开时再补；这样成本可控且头部质量高 —— **已完成**（300 条已随目录上线，见 §8.2）
- **M2 插件**：4 个工具（含远端同步）+ provider 激活 + GUI 榜单页 + GUI 面板（左侧栏入口，见 §8.3）——**已完成**
- **M3 召回**：钩子注入与 50 上限策略，实测"任务开始自动命中"

M1 依赖 M0 的 hash，M2 可先在本地样例数据上开发（`samples/digest2.json` 已有 12 条真实数据）。

## 11. 未决

1. ~~采集挂 Vercel Cron 还是 GitHub Action~~ → 已定 Vercel：`api/collect.js` 由 Vercel Cron 定时触发，OIDC 拿 `skills.sh` 鉴权，目录写 Vercel Blob，同一份文件既做快照又给插件当 CDN 拉取源。

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



