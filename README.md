# dsh-skills-center

skills.sh 有八千多个技能，问题是**你不知道它们存在**，也想不起来用。这个插件做三件事：

1. **目录**：把全量技能离线落到本地，带中文介绍、用途、注意事项、安装量、8 周趋势、来源。
2. **判断**：按 `评分 = 0.45·热度 + 0.20·趋势 + 0.20·官方 + 0.15·安全检查` 排序（安装量取对数、增长率裁剪、官方 curated 标记、第三方安全检查通过率），界面上显示成 0–100 分，并对"转发壳/废弃/需要付费 key"这类坑打标记。
3. **按需激活**：库存里有几十个技能只占磁盘；激活集合上限 50，只有激活的才进系统提示——避免把上下文塞满反而稀释技能选择。
4. **跟着上游走**：模型可以通过 `skill_sync` 从远端拉一份新目录，换掉本地那份（先落 `.prev` 备份，失败就什么都不动）。没部署远端时它明确报错，退回本地目录继续用。

不做的事：不做在线搜索和安装（那是 `@michengai/dsh-skills-manager` 和 `npx skills` 的活），不做排行榜站、评分评论、上传发布。

## 现在能跑什么

```bash
npm run check   # 确认插件入口可加载
npm test        # 冒烟：provider.list/get、四个工具、50 上限、浏览接口、浏览器半边形状
```

数据分两层：仓库里带 12 条真实样例（`data/catalog.json`，来自 skills.sh 公开 API + 仓库 SKILL.md 实读）用于跑通链路；线上目录由 `api/collect.js` 每天采集一次，当前 7500+ 条，其中安装量前 300 条带中文卡片（介绍 / 用途 / 使用注意事项）。全量采集见 `DESIGN.md`。

## GUI 面板

装进 DSH 后，**左侧栏出现一个「技能中心」图标**，点开是主区的卡片墙（和插件市场同一套版式）：

- 顶部一行状态：`目录 7572 · 匹配 N · 版本 2026-10-20 03:00 · 已激活 n/50`；
- 工具条：搜索框（服务端搜全目录，不只这一屏）、排序下拉（评分 / 安装量 / 8 周趋势 / 名称）、升/降切换；
- **功能分类**：全部（带总数）+ 前 12 个功能分类铺成胶囊（AI 与模型 / GPU 与加速计算 / 部署与运维 / 设计与图像 / …），点一下按分类过滤；剩下的分类（含「其他」）由「更多分类（N）」**行内展开**成同样的胶囊，再点「收起」。面板里没有任何原生 `<select>`——排序与每页条数也是自绘菜单，避免弹出操作系统的下拉层。分类是**关键词规则推断**的，不是 skills.sh 字段（菜单下面一行如实写着），实测 75.6% 的条目能落到具体分类，其余 24.4% 在「其他」；
- 质量筛选（第二行小胶囊）：全部 / 有中文卡 / 官方精选 / 有风险信号 / 已抓正文；
- **排序是一个分组菜单**（排序字段 / 排序方向 / 发布时间范围三组，自绘浮层）：字段可选 评分 / 安装量 / **近 30 天安装量** / 8 周趋势 / 名称；方向 降序 / 升序；时间范围按**发布时间**（技能页的 First Seen）筛 全部时间 / 最近 30 天 / 90 天 / 1 年。上游没有「更新时间」这个字段，所以面板里没有它；「近 30 天安装量」是用页面上的 8 周周量的最近 4 周求和得到的（≈28 天），不是上游字段，界面上写明了口径；
- 卡片墙：每张卡是「中文名 + slug·来源 + 评分（0–100）+ 两行介绍 + 安装量与 8 周趋势 + 最多两个标签」；点卡片弹出详情——完整中文卡（介绍/用途/注意事项）、评分四维拆解、五家第三方安全检查逐条结论、首次收录时间、唯一标识（`来源/仓库/技能名`），GitHub 来源还会给出 `npx skills add <source> --skill <slug>` 这条自己跑的命令；
- 底部分页：`上一页 1 2 … N 下一页`，右侧「第 X / Y 页 · 每页 24/48/96/192」。整块内容限宽 1180px **居中**，两侧留白随窗口自适应；
- **右上角 `? 说明`**：一个弹层把评分算法（热度/趋势/官方/安全检查逐项）、第三方安全检查口径（五家 provider、pass/warn/fail、fail 计入分母）、卡片标签含义、数据更新频率一次讲清。卡片上的评分、第三方安全检查、风险标记也都带鼠标悬停提示；详情弹层里评分与检查结论下面各附一句口径说明（「pass 不等于安全」「评分不是 skills.sh 官方的分数」）。

面板是**只读**的：它只从插件自己的 `/api/dsh-skills-center/list` 与 `/card` 取数据，不写任何状态。要装、要激活还是走工具（`skill_activate`）——GUI 里点一下就能装是下一步的事，得先有「下载正文到库存」的路径，否则按钮按下去只会得到一句「库存里没有正文」。

浏览器半边是手写的 `client/client.js`（无构建、只 `require('react')`、走宿主主题 token 与 locale 服务），manifest 见 `package.json` 的 `dsh.client`。改了它之后刷新页面，图标还不出现就重启 GUI（`dsh.client` 是启动期扫描的）。


## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：注册 provider、4 个工具、只读 Web API（`status`/`search`/`list`/`card`/榜单页） |
| `lib/page.js` | 只读中文榜单页（`GET /api/dsh-skills-center/`） |
| `client/client.js` | 浏览器半边：左侧栏图标 + 主区面板（无构建，只 require react） |
| `lib/provider.js` | 只把「已激活且库存有正文」的技能暴露给 DSH |
| `lib/catalog.js` | 目录加载、检索、打分、卡片渲染 |
| `lib/activation.js` | 激活集合读写（原子写、50 上限） |
| `lib/paths.js` | 所有落盘位置（`~/.dsh/skills-center/`） |
| `data/catalog.json` | 目录数据 |
| `tools/` | 采样与数据构建脚本 |
| `samples/` | 卡片样例与原始采样输出 |
| `DESIGN.md` | 设计文档：边界、采集、去重、打分、激活、里程碑 |

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


技能正文的库存目录是 `~/.dsh/skills-center/library/<来源>/<slug>/SKILL.md`：**只有这里存在正文的技能才会被 provider 暴露**，否则 `skill_activate` 会明确告警而不是假装成功。

## 工具

- `skill_search` — 本地目录检索，返回 `id + 中文一句话 + 判断 + 安装数 + S`
- `skill_card` — 单个技能完整卡片
- `skill_activate` — 开/关激活（受 50 上限约束）
- `skill_sync` — 从远端拉新目录替换本地副本；返回条数、快照时间、来源 URL

## 远端目录同步

同步地址默认走 **GitHub raw**（`https://raw.githubusercontent.com/w4n63r/dsh-skills-center/catalog/catalog.json`），可用环境变量 `DSH_SKILLS_CENTER_CATALOG_URL` 覆盖；GitHub 整条链失败时自动回退到 Vercel 入口。同步先取 ~230 字节的 `catalog-meta.json` 比 sha256，一样就**一个字节都不下**（6.6MB 的目录只有真变了才下载）。没有配置或远端没部署时同步会直接失败并说明原因，本地目录不受影响。

落盘位置在 `~/.dsh/skills-center/catalog/`：`catalog.json`（当前）、`catalog.prev.json`（上一次，回滚用）、`meta.json`（来源 URL、ETag、拉取时间、条数）。

## 中文卡片层

目录里 7500+ 条不可能逐条写中文，所以只精做**安装量前 300 条**，其余条目卡片如实写「中文卡未覆盖」，有上游英文描述就照抄，没有就直说没有——不编、不占位。

| 环节 | 文件 | 干什么 |
|---|---|---|
| 挑条目 | `tools/zh_source.mjs` | 从同步下来的目录里按安装量取前 300，切 6 片喂给写手，每片带全字段事实（描述、装量、趋势、第三方安全检查） |
| 校验 | `tools/zh_validate.mjs` | 单条硬校验：字段长度、禁用词、占位符、中英混排 |
| 合并 | `tools/zh_merge.mjs` | 6 片并成 `data/zh.json`，跨片重复 id、超长、禁用词直接失败不落盘 |
| 采集 | `api/collect.js` | 构建时把 `data/zh.json` import 进来，按 id 贴到每条记录上，随目录写进 Blob |

```bash
node tools/zh_merge.mjs        # 合并 + 校验，输出 data/zh.json（当前 300 条）
```

分片原文留在 `data/zh/part-1..6.json`（`data/zh.json` 由它们生成，别手工改）。
