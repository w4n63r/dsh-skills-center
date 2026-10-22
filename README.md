# dsh-skills-center

skills.sh 上有九万多个技能，问题是**你不知道它们存在**，日常也想不起来用。这个插件把可安装的那批变成一份可离线浏览、带中文判断、能直接装卸的目录；装进 DSH 后左侧栏多一个「技能中心」。

它做四件事：

1. **目录**：按**总安装量**降序收录前 2000 条（覆盖全站 95.9% 的安装量），每条都带正文指纹、安装量、8 周趋势、第三方安全检查结论与来源；水位外只保留 curated/精选例外。
2. **判断**：面板、`/list`、榜单页默认都按**总安装量**降序（`installs_merged ?? installs`，把同一份内容在各仓库的副本装量合并；有副本时标「含 N 个副本」）。另有可选的「综合分」`S = 0.45·热度 + 0.20·趋势 + 0.20·官方 + 0.15·安全检查`，显示成 0–100。两者差别很大：S 分前 20 与安装量前 20 只重合 3 条。
3. **中文层**：分两层——`tier: hand` 人工精写 300 条，`tier: auto` 机器生成层按批推进（首批 25 条）。卡片给中文介绍 / 用途 / 注意事项，且能力词必须在正文里找得到。
4. **安装与卸载**：不自建安装器，走官方 `npx skills@1.7.4 add …`，落到 DSH 原生扫描的 `.agents/skills/`，装完立刻能用（`/技能名` 可调），卸载就是删目录。

不做的事：不做在线搜索、不做排行榜站、不做评分评论与上传发布。

## 现在能跑什么

```bash
npm run check   # 确认插件入口可加载
npm test        # 14 套测试，见下
```

`npm test` 依次跑 14 套：`tests/smoke.mjs`、`tests/categories.test.mjs`、`tests/sync.test.mjs`、`tests/body.test.mjs`、`tests/installer.test.mjs`、`tests/install-routes.test.mjs`、`collector/publish-github.test.mjs`、`tests/client.test.mjs`、`collector/pipeline.test.mjs`、`collector/fetch.test.mjs`、`collector/replay.test.mjs`、`api/collect.test.mjs`、`tools/zh_source.test.mjs`、`tools/zh_validate.test.mjs`。

仓库里带 12 条真实样例（`data/catalog.json`，version `sample-2026-10-19`）用于离线跑通链路；线上目录由 `api/collect.js` 每天采集一次。

## 收录标准

一条技能要进目录，必须**同时**满足四条：

1. 采集端从 skills.sh 的 detail 接口拿到了 `SKILL.md` 正文（正文全文存对象存储，目录里只留指纹）；
2. 正文 ≥ 300 字符；
3. frontmatter 里有非空 `description`；
4. 有内容 hash。

**水位**：按总安装量降序取前 **2000** 条；水位外只保留 curated/精选例外。依据是这 2000 条覆盖全站 **95.9%** 的安装量。

**严格门禁是自动的**：水位内「正文已入库」覆盖率 ≥ **0.95** 才开严格过滤（`requireBody` 打开）；覆盖率不到就照旧全量收录，避免一轮采集把目录掏空。

**结果**：目录条数从改造前的 7800–8100 条下降到 **3879 条**（2026-10-21 采集一轮，version `full-2026-10-21T08-05-00-484Z`：水位内正文覆盖率 0.974，严格过滤已打开）。这是预期行为，不是数据丢失——留下的 3879 条每条都有正文与描述。水位外的条目没有正文，因此不在目录里。

## 数据从哪来

- **上游**：`skills.sh` 的 `/api/v1`（列表 / curated / detail / audit）与技能页 HTML（8 周周量、First Seen）。
- **采集**：Vercel Cron 每天 `0 5 * * *`（UTC）打 `GET /api/collect`，需要 `CRON_SECRET`；富集每轮受 `MAX_REQUESTS=1500` 预算裁剪，2026-10-21 那轮 `used=1458`。
- **正文**：按内容寻址存在 GitHub 的 `bodies` 分支——`https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies/<sha256>.md`。目录顶层有 `body_base`，每条技能有 `body: { length, sha256, v }`（`v` = 已入库的正文版本戳，当前 `1`）。
- **目录**：主分发走 GitHub `catalog` 分支的 `https://raw.githubusercontent.com/w4n63r/dsh-skills-center/catalog/catalog.json`（另有 ~230 字节的 `catalog-meta.json`）；`/api/catalog` 302 到它。目录已 10MB+（函数响应 4.5MB 是上限），所以只走「先传文件、再回 302」这条路。
- **Vercel Blob 是可选回退**，不是主存储（线上 store 曾被 Vercel 停用：`This store has been suspended.`）。两条路都失败，采集接口才返回 500。
- **插件本地**：目录缓存在 `~/.dsh/skills-center/catalog/`（`catalog.json` / `catalog.prev.json` / `meta.json`）；正文按 `sha256` 缓存在 `~/.dsh/skills-center/bodies/<sha256>.md`。

### 远端同步

`skill_sync` 默认读 GitHub raw；先用 `catalog-meta.json` 比 sha256，一样就**一个字节都不下**，不一样才拉全量。可用 `DSH_SKILLS_CENTER_CATALOG_URL` 覆盖地址（也接受本地路径 / `file://`），主地址整条链失败时回退 Vercel 入口。

## 安装与卸载

项目和全局都走同一条规则：**项目根 = 从当前目录向上找最近的含 `.git` 的祖先**（与 DSH 判定规则一致）。Web 路由拿不到会话目录，所以 `/local` 返回宿主给的默认目录，并允许用 `?project=<绝对路径>` 覆盖（面板上也可改）。

| 作用域 | 命令 | 落点 | DSH rank |
|---|---|---|---|
| 项目级 | `npx skills@1.7.4 add <owner/repo> --skill <slug> -a codex --copy -y` | `<项目>/.agents/skills/<slug>` | 200 |
| 全局 | 上面这条再带 `-g` | `~/.agents/skills/<slug>` | 500 |

这两个目录正是 DSH 扫描的技能根，所以装完立刻能用、`/技能名` 能调。

卸载：`npx skills@1.7.4 remove <slug> -a codex [-g] -y`。判定**按作用域**——项目级卸载不会因为全局还有同名而报失败，但会在响应里列出 `stillInstalledElsewhere`；判据只看目录还在不在，不看 CLI 退出码。

**关于「停用」**：DSH 核心没有技能启用/停用存储（`ctx.skills` 只有 `registerProvider/register/list/snapshot/get/collect`，全 asar 搜不到 activation 之类持久化），唯一的开关是 `SKILL.md` frontmatter 里的 `disable-model-invocation` / `user-invocable`。插件早期那套 `~/.dsh/skills-center/library/` + `activation.json` + rank 700 provider 已降级为**面板预览用的正文备份**，不再叫「安装」。

## 工具

- `skill_search` — 本地目录检索（含中文名/中文简介）
- `skill_card` — 单个技能完整卡片
- `skill_activate` — 开/关早期的库存激活集合（受 50 上限约束；与「安装」无关）
- `skill_sync` — 从远端拉新目录替换本地副本；返回条数、快照时间、来源 URL

## GUI 面板

装进 DSH 后，**左侧栏出现一个「技能中心」图标**，点开是主区的卡片墙：

- 顶部状态行：`目录 3879 · 匹配 N · 版本 … · 已激活 n/50`；
- 工具条：搜索（服务端搜全目录）、排序分组菜单（排序字段 / 方向 / 发布时间范围，自绘浮层，面板里没有任何原生 `<select>`）；
- 默认排序是**总安装量**降序；可选「综合分」、近 30 天安装量、8 周趋势、星标、名称；
- **功能分类**：前 12 个分类铺成胶囊，其余由「更多分类（N）」行内展开。分类是关键词规则**推断**的，不是 skills.sh 字段（菜单下面如实写着），实测约 75.6% 能落到具体分类（改造前 7639 条目录口径；新目录 3879 条下待核实）；
- 卡片墙 + 底部分页（`上一页 / 页码 / 下一页`，每页 24/48/96/192）；点卡片弹出详情（完整中文卡、评分四维、五家第三方安全检查逐条结论、正文预览入口、安装命令）；
- 右上角 `? 说明`：把评分算法、第三方安全检查口径、卡片标签、数据更新频率一次讲清。

面板的「本地」视图与安装按钮，字符串和组件已经在 `client/client.js` 里写好，但当前渲染的面板只接了目录视图，**尚未接线**——所以现在装卸以 HTTP 路由为准（见下）。这是待核实/待接线的一步，不要照旧文档说「面板上就能装」。

修改 `client/client.js` 或 `package.json` 的 `dsh.client` 后需要**刷新页面**，图标还不出现就重启 GUI（`dsh.client` 是启动期扫描的）；`lib/` 这半边是热加载的，改完不用重启。

## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：注册 provider、4 个工具、Web API（`/`、`/status`、`/search`、`/list`、`/card`、`/body`、`/local`、`/install`、`/uninstall`、`/sync`） |
| `lib/page.js` | 只读中文榜单页（`GET /api/dsh-skills-center/`） |
| `lib/catalog.js` | 目录加载、检索、打分、排序、卡片渲染、正文缓存 |
| `lib/installer.js` | 技能根枚举 / 本地清单 / argv 构造 / 装卸内核（子进程由调用方注入） |
| `lib/sync.js` | 远端目录同步（meta 比对、校验、原子替换、curl 回退） |
| `lib/categories.js` | 关键词规则的功能分类 |
| `lib/provider.js` / `lib/activation.js` | 早期的库存 + 激活 provider（rank 700，已降级为预览/备用） |
| `client/client.js` | 浏览器半边：左侧栏图标 + 主区面板（无构建，只 require react） |
| `collector/` | 采集纯逻辑与发布（pipeline / fetch / collect / publish-github） |
| `api/collect.js` | Vercel 采集函数（Cron 触发） |
| `api/catalog.js` | `/api/catalog` → 302 到目录文件 |
| `data/catalog.json` | 12 条真实样例（离线回退目录；线上以 GitHub `catalog` 分支为准） |
| `data/zh.json` `data/zh/part-*.json` | 中文层（人工 300 条 + 机器层分片） |
| `tools/` | 采样、构建与中文层流水线脚本 |
| `DESIGN.md` | 设计文档：实现层、接口形状、硬约束 |

## 装到 DSH

**别用 `dsh plugin --profile desktop add`**——当前 desktop profile 里的 `dsh-ops@0.3.0` 依赖了 npmmirror 上不存在的 `@dsh-ops/bash-win32-x64@0.2.1`，任何 `pnpm add` 都会在重解析依赖树时撞上它（`ERR_PNPM_NO_MATCHING_VERSION`），与本项目无关。手工挂三步：

1. `~/.dsh/profiles/<name>/package.json`：`dependencies` 加 `"dsh-skills-center": "link:D:/dsh-skills-center"`，`dsh.profile.bundles` 追加 `"dsh-skills-center"`；
2. 在 `~/.dsh/profiles/<name>/node_modules/` 建 junction 指向本仓库（用 node 建，bash 里 `mklink /J` 的引号会出错）：
   ```js
   require('fs').symlinkSync('D:\\dsh-skills-center',
     require('path').join(process.env.USERPROFILE, '.dsh/profiles/desktop/node_modules/dsh-skills-center'), 'junction')
   ```
3. 重启该 profile。

`package.json` 的 `dsh.bundle.patch` 会让 DSH 自动读本包的 `cordis.patch.yml`，插入 `skills-center` 组件——与已装的 `@michengai/dsh-skills-manager`、`dsh-ops` 同形。这一步已在临时 profile 上验证过：`--dump-config` 出现 `- id: skills-center`，真启动后 `/api/dsh-skills-center/status` 正常返回。

## 中文卡片层

目录里 3879 条不可能逐条手写，所以分两层：

- `tier: hand` —— 人工精写，300 条，落在 `data/zh.json`（由 `data/zh/part-1..6.json` 合并生成，缺 `tier` 时按 `hand` 处理）；
- `tier: auto` —— 机器生成层，目标是覆盖目录里全部条目，正在按批推进：目前 325 条已全部合并进 `data/zh.json`（hand 300 + auto 25，auto 落在 `data/zh/part-7.json`；`generated_at 2026-10-21T08:29:46Z`）。**不要**写成「已全量覆盖 2000 条」。

流水线：

```bash
node tools/zh_fetch_bodies.mjs                 # 把正文抓到本地缓存当素材
node tools/zh_generate.mjs plan  --catalog <catalog.json> --from 0 --count 50 --batch 25 --out tmp/zh-batches
node tools/zh_generate.mjs check --input tmp/zh-batches/in-0-25.json --written tmp/zh-batches/out-0-25.json
node tools/zh_generate.mjs apply --input tmp/zh-batches/in-0-25.json --written tmp/zh-batches/out-0-25.json --part data/zh/part-7.json
node tools/zh_merge.mjs                        # 汇总进 data/zh.json，保留 tier
```

- `plan` 按总安装量降序挑素材、跳过已有中文卡的条目，正文取前 1200 字符；
- `check` 校验长度、禁用词、`tier`，以及**能力词必须在正文里出现**；`apply` 合并进分片且幂等；
- `tools/zh_source.mjs` 支持 `--offset/--limit` 分页；`tools/zh_validate.mjs` 加了 `tier` 与正文溯源校验。

`data/zh.json` 与 `data/zh/part-*.json` 由脚本生成，别手工改。

## 已知未完成

- **M3 召回（「任务开始时就命中」）**：最小版已做——宿主每步都会把「技能中心」当运行时技能列进可用技能（名字 + 描述），另有一段静态系统提示要求先调 `skill_search`、不得凭空声称技能存在。按首条用户消息检索后再注入一行（`agent/pre-step`）的强版本明确不做：那要替宿主构造消息，风险大于收益。
- **中文层扩容**：625/3960；这是数据活，不是代码活（`tools/zh_generate.mjs plan/check/apply` + `tools/zh_merge.mjs`，一批 25 条）。
- **同名不同作者 = 两条技能**（用户 2026-10-22 定的规则，不是缺陷）：只有聚类键一致（内容同一份）才会并成一条并标「含 N 个副本」。实测 3961 条里 198 组同名不同内容（多出 338 条，例：`frontend-design` 9 条、`code-review` 16 条），另有 120 条带副本共 234 个副本。
- **星标与发布时间覆盖很低**：`stars` 只覆盖 8 个仓库 / 93 条，`first_seen` 更少；页面抓取只对历史上抓过的那批生效，升 `ENRICH_VERSION` 只解决一部分。
