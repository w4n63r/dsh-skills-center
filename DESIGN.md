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
S = 0.45·H + 0.20·T + 0.20·C + 0.15·A
```

- **H 热度** = `log10(1+installs)` 归一化。必须取对数：头部 139 万与腰部 3 万差 46 倍，线性尺度会让榜单只剩前 20 个。
- **T 势能** = 8 周序列后半段/前半段的增长率，裁剪到 `[-50%, +200%]` 再归一化。趋势是唯一能反映"正在退场"的指标（`lark-drive` 总量 46 万但八周 −52%）。
- **C 官方性** = curated 或 owner 属厂商官方（anthropics / vercel-labs / microsoft / supabase / prisma / larksuite…）= 1，否则 0。
- **A 可信** = 审计 pass 占比；无审计数据记中性 0.5，不给 0（否则非 GitHub 来源被系统性歧视）。

权重还没定死：0.45/0.20/0.20/0.15 是初值，等目录跑起来看榜单观感再调。

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

**字段固定为 7 项，顺序不变**：`名称` / `介绍` / `用途` / `使用注意事项` / `安装数` / `8 周趋势` / `来源`。

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

**工具清单**（刻意只有 3 个，避免工具列表膨胀）：

| 工具 | 用途 |
|---|---|
| `skill_search` | 在本地全量目录里检索（含中文名/中文简介），返回 `id + 中文一句话 + verdict + S` |
| `skill_card` | 取某技能完整中文卡片（含依赖、告警、fork 情况） |
| `skill_activate` | 把库存技能加入激活集合（受 50 上限约束），并落盘到 `library/` |

**Web API**：`ctx.webServer.register({kind:'prefix', path:'/api/dsh-skills-center'})`，供 GUI 浏览榜单与卡片。
**审批**：`ctx.on('tools/pre-execute')` 对 `skill_activate` 要求确认（会改变系统提示内容）。

## 9. 不做

- 不做排行榜网站、评分评论、上传发布
- 不把第三方 SKILL.md 正文 vendor 进仓库（只存 hash + 元数据 + 来源 URL，规避 license）
- 不写自己的安装器
- 不在插件里直连 `/api/v1`（拿不到 OIDC）

## 10. 里程碑

- **M0 目录**：Vercel 采集函数 + `catalog.json` 分片，能拉全量 8420 条（含趋势/去重/打分）
- **M1 中文层**：分层 1500 条批量生成中文卡片，落 `zh/`，本地样例已可用
- **M2 插件**：3 个工具 + provider 激活 + GUI 榜单页
- **M3 召回**：钩子注入与 50 上限策略，实测"任务开始自动命中"

M1 依赖 M0 的 hash，M2 可先在本地样例数据上开发（`samples/digest2.json` 已有 12 条真实数据）。

## 11. 未决

1. 采集挂 Vercel Cron 还是 GitHub Action——用户有 Vercel 账号，倾向 Vercel（能顺带托管 `catalog.json` 供插件 CDN 拉取）。
2. 中文生成成本：1500 条 × 平均 8k 字正文，需分批与限流；是否用便宜模型先跑、只对 top 200 用强模型精修。

## 12. 已验证的插件契约（M2 开工前）

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

**`rank` 的方向性**（`lib/core.js:2748` 佐证）：`overlayRank = Math.min(...) - 1`——越小的 rank 越优先，用来"覆盖"别的来源；skills-manager 自己的技能根占 100~450。故本插件用 `DEFAULT_RANK = 500`：激活的技能默认**不会**盖住用户自己手写/已装的同名技能，想让它优先可用 `config.rank` 调低。


