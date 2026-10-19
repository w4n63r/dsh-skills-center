# dsh-skills-center

skills.sh 有八千多个技能，问题是**你不知道它们存在**，也想不起来用。这个插件做三件事：

1. **目录**：把全量技能离线落到本地，带中文介绍、用途、注意事项、安装量、8 周趋势、来源。
2. **判断**：按 `S = 0.45·H + 0.20·T + 0.20·C + 0.15·A` 排序（H 安装量取对数、T 增长率、C 官方/curated、A 审计通过率），并对"转发壳/废弃/需要付费 key"这类坑打标记。
3. **按需激活**：库存里有几十个技能只占磁盘；激活集合上限 50，只有激活的才进系统提示——避免把上下文塞满反而稀释技能选择。

不做的事：不做在线搜索和安装（那是 `@michengai/dsh-skills-manager` 和 `npx skills` 的活），不做排行榜站、评分评论、上传发布。

## 现在能跑什么

```bash
npm run check   # 确认插件入口可加载
npm test        # 假 ctx 冒烟：provider.list/get、三个工具、50 上限
```

数据是 12 条真实样例（`data/catalog.json`，来自 skills.sh 公开 API + 仓库 SKILL.md 实读），用来先把链路跑通。全量采集见 `DESIGN.md`。

## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：注册 provider、3 个工具、只读 Web API |
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
