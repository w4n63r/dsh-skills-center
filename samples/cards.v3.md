# 技能卡片 · 第三版（按指定字段）

字段固定为：名称 / 介绍 / 用途 / 使用注意事项 / 安装数 / 8 周趋势 / 来源。
按安装量降序排列。数据为 skills.sh 实测值，介绍与注意事项来自源仓库 `SKILL.md` 原文解析。

---

### 01 · grill-me（挑剔面试官）

**介绍** — 让模型反过来质问你，把方案里没想清楚的地方问出来。但正文只有 39 个字符：`Call the Skill tool with "grilling".` 真正的面试流程在同仓库的 `grilling` 技能里，这个只是转发壳。

**用途** — 方案或设计文档定稿前自检；评审前预演被挑刺；判断一份计划是不是看着完整其实空心。

**使用注意事项** — 单独装它等于装了个空壳，必须同时装 `grilling`，否则调用后没有任何内容。

**安装数** — 1,385,556
**8 周趋势** — -12.8%
**来源** — `mattpocock/skills`（个人仓库，GitHub 296K 星）

---

### 02 · agent-browser（浏览器自动化）

**介绍** — Vercel 的浏览器自动化 CLI 配套技能。CDP 驱 Chrome，用无障碍树快照加 `@eN` 元素引用来定位和点击，比截图配坐标那套稳。

**用途** — 打开网页、填表、点按钮、截图、抓页面数据、测 web 应用、登录站点、端到端探索测试。

**使用注意事项** — 主 `SKILL.md` 是发现桩，原文写明 `This file is a discovery stub, not the usage guide.`。真文档要从 CLI 取：

```
npm i -g agent-browser && agent-browser install
agent-browser skills get core      # 加 --full 取完整命令参考
```

好处是文档永远跟装的版本对齐，坏处是 CLI 没装好时这个技能是空的。

**安装数** — 1,093,187
**8 周趋势** — +57.9%
**来源** — `vercel-labs/agent-browser`（Vercel 官方）

---

### 03 · frontend-design（前卫视觉设计）

**介绍** — Anthropic 官方写来做视觉方向的技能，9077 字。核心要求是别让界面看起来像模板：先答清楚产品是什么、配色凭什么这么选，才准动代码；中间有自我批判环节，对着 brief 找自己在哪里回避了取舍。

**用途** — 从零做界面；改造已有 UI 的审美方向；嫌生成结果"能用但很平庸"。

**使用注意事项** — 只给方法论不给代码，落地靠自己。不写前端的人装了用不上。

**安装数** — 1,003,686
**8 周趋势** — +6.4%（八周净增 1,621 次，实际是平的）
**来源** — `anthropics/skills`（Anthropic 官方）

---

### 04 · hyperframes-animation（HyperFrames 动效库）

**介绍** — HyperFrames 的动效知识总库，19.7k 字主文件加 122 个附属文件：原子运动规则、多阶段场景蓝图、转场、7 种运行时适配器（GSAP 默认，另有 Lottie、Three.js、Anime.js、CSS keyframes、WAAPI、TypeGPU）。

**用途** — 挑几条原子规则组合、加载场景蓝图、查具体运行时 API、审计已有编排的动画地图。

**使用注意事项** — 强绑定 HyperFrames 产品，正文里还引用 `../hyperframes/` 的插件安装规则。不在这个项目里时，只有运动规则那层可复用，蓝图和脚本没有意义。

**安装数** — 943,724
**8 周趋势** — **+151.7%**（这批里涨幅最大：32,801 → 148,755）
**来源** — `heygen-com/hyperframes`（HeyGen 官方）

---

### 05 · design-mobile-apps（移动端界面设计）

**介绍** — 接 sleek.design 的 REST API 出移动端界面稿，再落成 React Native 或 HTML。8.3k 字基本都是端点用法：建项目、按 brief 生成屏幕、取 HTML 与渲染图、全部端点速查、错误形状。

**用途** — 快速出移动端方案；改已有 Sleek 项目；把设计稿落成 RN / HTML。

**使用注意事项** — 要 Sleek 的付费 API Key（`Authorization: Bearer $SLEEK_API_KEY`），只有设备启动和轮询是公开端点。没 key 整个技能不可用。

**安装数** — 897,218
**8 周趋势** — +70.0%
**来源** — `designed-by-ai/skills`（第三方服务商 sleek.design）

---

### 06 · vercel-react-best-practices（React 性能规则库）

**介绍** — Vercel 官方的 70 条性能规则，按影响面分 8 个优先级：消除请求瀑布和包体积是 CRITICAL，往下是服务端性能、客户端取数、重渲染。主文件 6.8k 字，76 个附属文件放分类细则。

**用途** — 写新组件或页面；实现数据获取；查请求瀑布、包体积、重渲染；接到"优化一下性能"这类任务。

**使用注意事项** — 纯文档不联网。规则写在 RSC / App Router 语境里，纯客户端老项目有些条目用不上。

**安装数** — 814,685
**8 周趋势** — +22.0%
**来源** — `vercel-labs/agent-skills`（Vercel 官方）

---

### 07 · ai-video-generation（AI 视频生成）

**介绍** — 通过 inference.sh 的 `belt` CLI 调 40 多个视频模型：Veo 3.1、Seedance 2.0、Wan 2.5、Grok Imagine、OmniHuman 等，覆盖文生视频、图生视频、参考图生视频、视频编辑、对口型、数字人、超分、拟音。6.6k 字单文件，给的是各模型 app id 和最小可用命令。

**用途** — 社媒视频、营销素材、讲解片、产品演示、数字人。

**使用注意事项** — 要 `belt` CLI 并 `belt login`（付费网关），正文顶部还要求再装 `belt-sh/cli` 技能。另外同一份内容至少 6 个 owner 在发（101-skills 80 万、magentosh 64 万、qu-skills 48 万…整族约 300 万），装之前先确认是不是同一个东西。

**安装数** — 801,414
**8 周趋势** — +76.1%（同一份内容在发的 6 个 owner 里它涨得最慢，另 5 个是 +148% 到 +621%）
**来源** — `101-skills/superpowers`（第三方聚合）

---

### 08 · design-taste-frontend（tasteskill v2）

**介绍** — 37.4k 字，讲怎么让页面别长成"模型见过所有页面的平均值"。做法是让 `scripts/draw.mjs` 从 20 个调研过的方向里抽 3 个，你选一个承载主题的，再抽配套字体组合；正文是九步流程加门禁。

**用途** — 做落地页或应用界面但不想再看到"居中大标题 + 三行副标 + 一排图标卡 + 淡渐变"；需要字体和版式上的明确取舍。

**使用注意事项** — 要 Node 跑 `scripts/draw.mjs`。frontmatter 的 description 是空 YAML 块，任何按描述检索的工具都捞不到它，只能靠正文识别。

**安装数** — 634,387
**8 周趋势** — +27.9%
**来源** — `leonxlnx/taste-skill`（个人仓库）

---

### 09 · azure-compliance（Azure 合规审计）

**介绍** — 微软官方的 Azure 合规体检技能，两块能力：azqr 全面资源评估 + Key Vault 过期项监控。3.5k 字加 17 个 references，含评估工作流、优先级分级、错误处理、SDK 速查。

**用途** — 合规扫描、安全审计、跑 azqr 之前、查 Key Vault 证书和密钥过期、清僵尸资源。

**使用注意事项** — 要先 `az login`，且账号有读资源配置和 Key Vault 元数据的权限。依赖 MCP 工具（azqr、订阅/资源组列举、Key Vault 项检查），缺一个流程就断。

**安装数** — 558,194
**8 周趋势** — -0.3%
**来源** — `microsoft/azure-skills`（微软官方）

---

### 10 · lark-drive（飞书云空间）

**介绍** — 飞书云盘的操作手册，靠 `lark-cli` 管文件和文件夹：上传下载、建目录、复制移动删除、元数据、权限评论订阅、版本、密级标签，也能把本地 Word/Markdown/Excel/CSV/PPTX 导成 docx/sheet/bitable/slides。15.8k 字加 61 个附属文件。

**用途** — 整理云盘目录；处理云空间 URL/token、判断链接类型和真实 token；批量导入文档。

**使用注意事项** — 开始前必须先读同仓库的 `../lark-shared/SKILL.md` 拿认证和权限处理，另需 `lark-cli` 与飞书应用凭证。正文有两条硬规则：导 bitable 必须走 `drive +import --type bitable`（别先切 `lark-base`）；复制在线文档必须走 `drive +copy`（别导出再导入）。

**安装数** — 467,230
**8 周趋势** — **-33.2%**（这批里跌幅最大，上首页前值得查原因）
**来源** — `larksuite/cli`（飞书官方）

---

### 11 · supabase-postgres-best-practices（Postgres 最佳实践）

**介绍** — Supabase 官方的 Postgres 规则集，8 类按影响面排序，覆盖建表选列类型、schema 设计、迁移、RLS 策略及其测试、索引、触发器、DB 函数、pg_cron/pgmq 队列、pgvector 语义检索、pg_restore 恢复。定位是跑在任何地方的 Postgres，不限于 Supabase 托管。1.8k 字加 15 个 references。

**用途** — 任何 Postgres 上动手之前都该先读：尤其写 RLS 策略、建索引、选列类型的时候。

**使用注意事项** — 纯文档。RLS 和 pgvector 部分对有自己 DBA 的团队偏细。

**安装数** — 450,297
**8 周趋势** — -6.2%
**来源** — `supabase/agent-skills`（Supabase 官方）

---

### 12 · prisma-postgres（废弃占位）

**介绍** — 空的。正文 369 字，没有一条 setup 步骤，原文写着 `This compatibility entry contains no setup recipes.` 它只为兼容旧调用名存在，把请求转到 `prisma-postgres-setup`。

**用途** — 只有用户或既有集成显式点名 `prisma-postgres` 时才需要；其他情况直接选 `prisma-postgres-setup`。

**使用注意事项** — 别装。要装的是：

```
npx skills add prisma/skills --skill prisma-postgres-setup
```

36 万安装、八周还在跌 3.2%，说明安装量单个指标不能用来做推荐。

**安装数** — 362,998
**8 周趋势** — -3.2%
**来源** — `prisma/skills`（Prisma 官方）
