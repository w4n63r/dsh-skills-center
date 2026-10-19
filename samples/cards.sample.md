# 技能卡片样例（12 张）

> 数据口径：12 个技能全部来自 skills.sh 真实数据。`安装量`、`8 周趋势`、`英文简介` 为实测值；
> `正文分析`（它到底做什么、依赖什么、哪里有坑）来自对源仓库 `SKILL.md` 原文的解析（12/12 克隆成功）。
> `curated 标记` 与 `审计状态` 需要 Vercel OIDC 才能取到，本样例未接入，故卡片里不写。

---

## 01 · 挑剔面试官：把方案问穿

`mattpocock/skills` · `grill-me`

**一句话**：给方案或设计来一场"不留情面的面试"，逼出你没想清楚的地方。

**什么时候用我**：写完方案/设计文档想自检；准备评审前预演被挑战；判断一个计划是不是"看着完整其实空心"。

**它到底给什么**：几乎什么都不给——正文只有 39 个字符：`Call the Skill tool with "grilling".`
它是一个**转发壳**，真正的面试流程在同仓库的 `grilling` 技能里。

**依赖/风险**：⚠️ 别单独装它。装了要一并装 `grilling`，否则调用后没有实际内容。

**指标**：安装 1,385,556（全站前列）· 8 周趋势 +19.3% · 来源 mattpocock/skills（GitHub 296K 星）

**安装**：`npx skills add mattpocock/skills --skill grill-me --skill grilling`

**召回钩子**：`方案/设计定稿前自检 → grill-me`

---

## 02 · 前卫视觉设计（反模板）

`anthropics/skills` · `frontend-design`

**一句话**：Anthropic 官方的"视觉设计总监"人格，专治 AI 生成的网页长得像模板。

**什么时候用我**：从零做一个界面；改造已有 UI 的审美方向；嫌生成结果"能用但很平庸"；需要排版、配色、栅格的明确主张。

**它到底给什么**：
- 角色设定是"以独特视觉识别著称的设计工作室主创"，客户已否决过所有套路方案
- 先**锚定主题**：brief 没说清产品是什么，就自己定并跟客户确认，再动手
- 设计流程四段：规划 → 对着 brief 复核 → 构建 → 自我批判
- 强调"克制"与"有理由的冒险"，反对默认色板与默认字体

**依赖/风险**：纯方法论，无外部依赖；不做代码，产出是方向与判断，需要你自己落地。

**指标**：安装 1,003,686 · 8 周趋势 **+105.1%**（翻倍增长）· 来源 anthropics/skills（Anthropic 官方）

**安装**：`npx skills add anthropics/skills --skill frontend-design`

**召回钩子**：`新建或改版 UI 的审美方向 → frontend-design`

---

## 03 · React / Next.js 性能规则库

`vercel-labs/agent-skills` · `vercel-react-best-practices`

**一句话**：Vercel 官方维护的 70 条性能规则，按影响面分 8 个优先级，写 React 时照着做。

**什么时候用我**：写新的 React 组件或 Next.js 页面；实现数据获取；排查请求瀑布、包体积、重渲染；接到"优化一下性能"这类任务。

**它到底给什么**：
- 8 类优先级表：消除请求瀑布（CRITICAL）、包体积（CRITICAL）、服务端性能（HIGH）、客户端取数（MEDIUM-HIGH）、重渲染（MEDIUM）…
- 每条规则给正反例，可按前缀检索
- 主文件只有 6.8k 字，76 个附属文件承载分类细则，按需翻

**依赖/风险**：纯文档、不联网；规则写在 RSC / App Router 语境里，纯客户端老项目部分条目用不上。

**指标**：安装 814,685 · 8 周趋势 -3.6% · 来源 vercel-labs（Vercel 官方）

**安装**：`npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices`

**召回钩子**：`改 React/Next.js 代码前 → vercel-react-best-practices`

---

## 04 · Postgres 最佳实践（Supabase 官方）

`supabase/agent-skills` · `supabase-postgres-best-practices`

**一句话**：Supabase 官方的 Postgres 规则集，覆盖建表、迁移、RLS、索引、向量检索、定时任务。

**什么时候用我**：**在任何 Postgres 上动手之前**——建表改列（含选类型）、schema 设计、迁移文件、RLS 策略及其测试、索引、触发器、DB 函数、pg_cron/pgmq 队列、pgvector 语义检索、pg_restore 恢复、数据导入。

**它到底给什么**：8 类按影响面排序的规则 + 使用说明；主文件 1.8k 字，细则在 15 个 references 文件里。定位是"跑在任何地方的 Postgres"，不限于 Supabase 托管。

**依赖/风险**：纯文档；RLS 与 pgvector 部分对有自己 DBA 的团队可能过细。

**指标**：安装 450,297 · 8 周趋势 **+96.1%** · 来源 supabase（Supabase 官方）

**安装**：`npx skills add supabase/agent-skills --skill supabase-postgres-best-practices`

**召回钩子**：`任何 Postgres schema/SQL 变更前 → supabase-postgres-best-practices`

---

## 05 · Prisma Postgres（已废弃占位）

`prisma/skills` · `prisma-postgres`

**一句话**：一个**空壳**——只为兼容旧调用名而存在，正文明确写着 "This compatibility entry contains no setup recipes."

**什么时候用我**：只有当用户或既有集成**显式**点名 `prisma-postgres` 时。其他情况一律改用 `prisma-postgres-setup`。

**它到底给什么**：369 字，全是"我是废弃的，请去装 `prisma-postgres-setup`"。

**依赖/风险**：⚠️ **不建议装**。安装量 36 万说明大量人在装一个没有内容的东西——这正是"目录必须标废弃状态"的理由。

**指标**：安装 362,998 · 8 周趋势 +35.1% · 来源 prisma/skills（Prisma 官方）

**安装**：`npx skills add prisma/skills --skill prisma-postgres-setup`（替代品）

**召回钩子**：`提到 prisma-postgres → 转 prisma-postgres-setup`

---

## 06 · Azure 合规与安全审计

`microsoft/azure-skills` · `azure-compliance`

**一句话**：用 azqr 跑 Azure 合规体检，外加 Key Vault 过期项检查。

**什么时候用我**：合规扫描、安全审计、跑 azqr 之前、Azure 最佳实践评估、Key Vault 证书/密钥过期排查、僵尸资源清理。

**它到底给什么**：
- 两块能力：全面资源合规评估（azqr）+ Key Vault 过期监控
- 通过 MCP 工具做订阅/资源组列举与 Key Vault 项检查
- 带评估工作流、优先级分级、错误处理、SDK 速查，17 个 references

**依赖/风险**：需要先 `az login` 且账号有读取资源与 Key Vault 元数据的权限；需要配好 MCP 工具，缺一则流程断。

**指标**：安装 558,194 · 8 周趋势 -7.2% · 来源 microsoft/azure-skills（微软官方）

**安装**：`npx skills add microsoft/azure-skills --skill azure-compliance`

**召回钩子**：`Azure 合规/安全体检/Key Vault 过期 → azure-compliance`

---

## 07 · 浏览器自动化 CLI

`vercel-labs/agent-browser` · `agent-browser`

**一句话**：给 AI 用的浏览器自动化 CLI，CDP 驱动 Chrome，用无障碍树快照 + `@eN` 元素引用做精准点击。

**什么时候用我**：打开网页、填表单、点按钮、截图、抓页面数据、测 web 应用、登录站点、端到端探索性测试。

**它到底给什么**：⚠️ 主 SKILL.md 是**发现桩**（discovery stub），不含真正用法。必须先执行 `agent-browser skills get core` 从 CLI 取与当前版本匹配的正文（加 `--full` 取完整命令参考）。另有专用技能分支与可观测性面板。

**依赖/风险**：需要 `npm i -g agent-browser && agent-browser install`；正文随 CLI 版本走，不跟着技能目录走——**卡片必须写明"内容不在本地"**，否则用户以为装了就有全部文档。

**指标**：安装 1,093,187 · 8 周趋势 -4.4% · 来源 vercel-labs（Vercel 官方）

**安装**：`npx skills add vercel-labs/agent-browser --skill agent-browser`

**召回钩子**：`任何真实浏览器交互 → agent-browser`（先 `skills get core`）

---

## 08 · HyperFrames 动效全库

`heygen-com/hyperframes` · `hyperframes-animation`

**一句话**：HyperFrames 的动效知识总库——原子运动规则、多阶段场景蓝图、转场、7 种运行时适配器。

**什么时候用我**：任何运动/动画任务：挑 2-4 条原子规则组合、加载场景蓝图、查具体运行时 API（GSAP 缓动 / Lottie / Three.js / Anime.js / CSS keyframes / WAAPI / TypeGPU）；审计已有编排的动画地图。

**它到底给什么**：19.7k 字主文件 + 122 个附属文件（blueprints / adapters / references）；GSAP 是默认运行时，其余六种可按目标平台切换；含关键约束与脚本。

**依赖/风险**：⚠️ 强绑定 HyperFrames 产品（内部还引用 `../hyperframes/` 插件安装规则）。不用于 HyperFrames 项目时，只有"运动规则"那一层可复用，蓝图与脚本无意义。

**指标**：安装 943,724 · 8 周趋势 -5.4% · 来源 heygen-com（HeyGen 官方）

**安装**：`npx skills add heygen-com/hyperframes --skill hyperframes-animation`

**召回钩子**：`HyperFrames 项目里的动画/转场 → hyperframes-animation`

---

## 09 · tasteskill v2：网页设计判断力

`leonxlnx/taste-skill` · `design-taste-frontend`

**一句话**：专治"模型做出来的页面是它见过所有页面的平均值"——用抽签式方向选择 + 九步流程逼出**被决定过的**设计。

**什么时候用我**：做落地页/应用界面但不想再看到"居中大标题 + 三行副标 + 一排图标卡 + 淡渐变"；需要字体、版式、动线上有明确取舍。

**它到底给什么**：
- `scripts/draw.mjs` 从 20 个调研过的方向里抽 3 个，你选定一个承载主题的那一个，再抽配套字体组合
- 九步执行流：读 brief → 写论点 → 画方向 → 找到核心想法 → 写文案 → 构建（保持不动）→ 门禁 → 看 → 动
- 38 个附属文件，主文件 37.4k 字

**依赖/风险**：依赖 Node 跑 `scripts/draw.mjs`；frontmatter 的 description 是空 YAML 块，**目录里只能靠自己从正文提炼简介**——这正是需要中文卡片的原因。

**指标**：安装 634,387 · 8 周趋势 -9.3% · 来源 leonxlnx/taste-skill（个人仓库）

**安装**：`npx skills add leonxlnx/taste-skill --skill design-taste-frontend`

**召回钩子**：`网页视觉太套路/要设计方向 → design-taste-frontend`

---

## 10 · 设计移动端 App 界面（Sleek）

`designed-by-ai/skills` · `design-mobile-apps`

**一句话**：接 Sleek 的 REST API，用一句话 brief 生成移动端界面设计稿，并输出 React Native 或 HTML 实现。

**什么时候用我**：要快速出移动端 App 界面方案；要改已有 Sleek 项目；要把设计稿落成 RN / HTML。

**它到底给什么**：`https://sleek.design` 的 `/api/v1/*` 全量用法——建项目、按 brief 生成屏幕、取 HTML 与渲染图、用户镜头与评审镜头、全部端点速查、错误形状。

**依赖/风险**：⚠️ **要付费 API Key**：`Authorization: Bearer $SLEEK_API_KEY`（仅设备启动/轮询是公开端点）。没 key 时技能完全不可用。

**指标**：安装 897,218 · 8 周趋势 +22.6% · 来源 designed-by-ai（第三方服务商）

**安装**：`npx skills add designed-by-ai/skills --skill design-mobile-apps`

**召回钩子**：`Sleek 出移动端界面 → design-mobile-apps`（需 SLEEK_API_KEY）

---

## 11 · 飞书云空间（Drive）操作

`larksuite/cli` · `lark-drive`

**一句话**：飞书云盘/云空间的完整操作手册，靠 `lark-cli` 管理文件与文件夹。

**什么时候用我**：整理云盘目录；处理云空间资源 URL/token（判断链接类型、真实 token、标题）；上传下载、建文件夹、复制移动删除、查元数据、权限/评论/订阅、版本与密级标签；把本地 Word/Markdown/Excel/CSV/PPTX/.base 导入成 docx/sheet/bitable/slides。

**它到底给什么**：
- 先跑快速决策树（哪些归本技能、哪些要切走：内容编辑走 lark-doc、表内数据走 lark-sheets/lark-base、知识库走 lark-wiki）
- 两条硬规则：导入 bitable 必须走 `lark-cli drive +import --type bitable`（不要先切 lark-base）；复制在线文档必须走 `drive +copy`（不要导出再导入）
- 15.8k 字 + 61 个附属文件，覆盖 Token 处理、Wiki 链接特例、常见错误

**依赖/风险**：⚠️ 开始前**必须**先读 `../lark-shared/SKILL.md` 拿认证与权限；需要 `lark-cli` 与飞书应用凭证；只在飞书生态内可用。

**指标**：安装 467,230 · 8 周趋势 **-52.0%**（跌幅最大）· 来源 larksuite/cli（飞书官方）

**安装**：`npx skills add larksuite/cli --skill lark-drive`

**召回钩子**：`飞书云盘/云空间文件操作 → lark-drive`（先读 lark-shared）

---

## 12 · AI 视频生成（40+ 模型）

`101-skills/superpowers` · `ai-video-generation`

**一句话**：通过 inference.sh 的 `belt` CLI 调 Veo 3.1、Seedance 2.0、Wan 2.5、Grok Imagine、OmniHuman 等 40+ 模型出视频。

**什么时候用我**：文生视频、图生视频、参考图生视频、视频编辑、对口型、数字人、视频超分、拟音；做社媒视频、营销素材、讲解片、产品演示。

**它到底给什么**：各模型的 app id 与参数、六类任务的最小可用命令、批量浏览全部视频 app、示例合集；6.6k 字单文件。

**依赖/风险**：⚠️ 需要 `belt` CLI 并 `belt login`（inference.sh 付费网关）；正文顶部还要求安装 `belt-sh/cli` 技能。
⚠️ **fork 重复**：同一技能至少 6 个 owner 在发（101-skills 801,414 / magentosh 642K / qu-skills 484K / skills-shell 339K / its-a-skill-issue 333K / bankai-skills 318K）——**目录必须合并去重，否则榜单被同一份内容刷榜**。

**指标**：安装 801,414 · 8 周趋势 **+209.6%**（本轮最高）· 来源 101-skills/superpowers（第三方聚合）

**安装**：`npx skills add 101-skills/superpowers --skill ai-video-generation`

**召回钩子**：`生成/编辑视频、数字人、对口型 → ai-video-generation`（需 belt CLI）

---

# 排序视图（同一批数据，卡片之外的另一种入口）

| # | 技能 | 类型 | 安装量 | 8 周趋势 | 来源性质 | 建议 |
|---|---|---|---|---|---|---|
| 1 | grill-me | 思考辅助 | 1,385,556 | +19.3% | 个人（296K 星） | 装，但连 `grilling` 一起 |
| 2 | agent-browser | 自动化工具 | 1,093,187 | -4.4% | Vercel 官方 | 装（正文在 CLI 里） |
| 3 | frontend-design | 设计 | 1,003,686 | **+105.1%** | Anthropic 官方 | 优先装 |
| 4 | hyperframes-animation | 动效/视频 | 943,724 | -5.4% | HeyGen 官方 | 只在 HyperFrames 项目装 |
| 5 | design-mobile-apps | 设计 | 897,218 | +22.6% | 三方服务 | 有 Sleek key 才装 |
| 6 | vercel-react-best-practices | 编码规范 | 814,685 | -3.6% | Vercel 官方 | 优先装 |
| 7 | ai-video-generation | 视频生成 | 801,414 | **+209.6%** | 第三方聚合 | 观望（6 个 fork 重复） |
| 8 | taste-skill | 设计 | 634,387 | -9.3% | 个人 | 装（与 #3 互补） |
| 9 | azure-compliance | 云合规 | 558,194 | -7.2% | 微软官方 | 用 Azure 才装 |
| 10 | lark-drive | SaaS 操作 | 467,230 | **-52.0%** | 飞书官方 | 用飞书才装，注意已过峰 |
| 11 | supabase-postgres-best-practices | 数据库 | 450,297 | **+96.1%** | Supabase 官方 | 优先装 |
| 12 | prisma-postgres | 数据库 | 362,998 | +35.1% | Prisma 官方 | **别装**，是废弃壳 |

---

# 我从这 12 张卡片里看到的：目录必须表达的五件事

1. **"薄壳"必须标出来**。`grill-me` 39 字、`agent-browser` 是发现桩、`prisma-postgres` 是废弃占位。三个都是百万级安装量、下载量排前列，光看安装量会全部装错。卡片的价值不在翻译英文简介，而在**告诉你装它到底拿到了什么**。
2. **依赖必须前置**。12 个里有 4 个需要外部前提（Azure 登录+MCP、Sleek 付费 key、belt 付费登录、lark-cli+共享认证文件、Node 跑 draw.mjs）。不给依赖信息，用户装完就是"报了错不知道找谁"。
3. **同质内容要合并**。`ai-video-generation` 六个 fork 分散了 300 万安装量。`taste-skill` 与 `frontend-design` 是真互补（一个给方向、一个给判断力），但得被告知二者关系，否则会被当重复项二选一。
4. **趋势比总量更该上首页**。`lark-drive` 总量 46 万但八周掉了 52%，`frontend-design` 与 `supabase-postgres` 都在翻倍。总量榜会把衰退中的技能摆在前面。
5. **告警要写进卡片**：空 description（taste-skill）、正文指向不存在/未安装的兄弟技能（grill-me、hyperframes 引用 `../hyperframes/`）、非 GitHub 来源无趋势无审计（这批里没抽到，但已知 uizze.sh / open.feishu.cn 如此）。
