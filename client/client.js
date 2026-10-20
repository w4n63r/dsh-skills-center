// dsh-skills-center 的浏览器半边。
//
// 左侧栏一个「技能中心」图标，点开是主区的一张卡片墙：搜索、筛选、排序、翻页，
// 点卡片弹出完整中文卡。数据全部来自宿主插件自己的只读 JSON 接口
// （/api/dsh-skills-center/list 与 /card），这里不读盘、不写状态、不碰别人的 DOM。
//
// 手写而不是编译：宿主浏览器模块表提供 react，模块只认 window.__ModuleLoader__.load
// 这一种形状（id 必须等于包名），见 cordis-plugin-development/references/ui-plugin.md。
window.__ModuleLoader__.load({
  id: 'dsh-skills-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const NAMESPACE = 'skills-center';
    const PANEL_ID = 'skills-center';
    const API = '/api/dsh-skills-center';
    const PAGE = 24;

    const ZH = {
      nav: '技能中心',
      title: '技能中心',
      search: '搜索技能名、中文介绍、来源…',
      sort: '排序',
      sortScore: '评分',
      sortInstalls: '安装量',
      sortTrend: '8 周趋势',
      sortName: '名称',
      desc: '降序',
      asc: '升序',
      filterAll: '全部',
      filterZh: '有中文卡',
      filterOfficial: '官方精选',
      filterRisky: '有风险信号',
      filterEnriched: '已抓正文',
      filterLabel: '筛选',
      moreCategories: '更多分类',
      fewerCategories: '收起',
      sortField: '排序字段',
      sortDir: '排序方向',
      dateRange: '发布时间范围',
      rangeAll: '全部时间',
      range30: '最近 30 天',
      range90: '最近 90 天',
      range365: '最近 1 年',
      sortInstalls4w: '近 30 天安装量',
      sortStars: '星标数',
      stars: '星标数',
      starsNote: '星标是仓库级指标：同一个仓库里的技能共用这个数。来自技能页的 GitHub Stars，只有抓过页面详情的条目才有。',
      tipStars: '星标数：这个技能所在 GitHub 仓库的星数（技能页上的 GitHub Stars）',
      installs4w: '近 30 天安装量',
      installs4wNote: '上游不给「近 30 天」，这一项是我们把技能页上的 8 周周量的最近 4 周加起来得到的（≈28 天）。',
      firstSeenNote: '来自技能页上的 First Seen；只有抓过页面详情的条目才有，上游没有「更新时间」。',
      dateCoverage: '有时间信息',
      updateAvailable: '有新版本',
      syncNow: '同步',
      syncing: '同步中…',
      syncFailed: '同步失败：',
      categoryHint: '按技能实际功能自动分类（关键词规则，不是 skills.sh 官方字段）；一条技能可能属于多个分类。',
      searchResults: '搜索结果',
      prev: '上一页',
      next: '下一页',
      page: '第',
      perPage: '每页',
      loading: '读取中…',
      empty: '没匹配到。换个词试试。',
      failed: '读取失败：',
      more: '加载更多',
      noMore: '已经到底了',
      catalog: '目录',
      matched: '匹配',
      showing: '已显示',
      active: '已激活',
      version: '版本',
      none: '无',
      intro: '介绍',
      usage: '用途',
      notes: '注意事项',
      installs: '安装数',
      trend: '8 周趋势',
      source: '来源',
      flags: '标记',
      score: '评分',
      audit: '第三方安全检查',
      auditNone: '没有第三方安全检查结论（不等于安全）',
      auditPass: '家通过',
      termHeat: '热度',
      termTrend: '趋势',
      termOfficial: '官方',
      termCheck: '安全检查',
      id: '唯一标识',
      idHint: '格式是「来源/仓库/技能名」，用来在 skills.sh 上定位这一条',
      installCmd: '自己装（在终端里跑）',
      close: '关闭',
      clickCard: '点卡片看详情',
      noIntro: '上游没给描述，这条目前只有名称、装量、审计结论',
      representative: '官方',
      curated: '精选',
      cardZh: '中文卡',
      enriched: '有正文',
      firstSeen: '首次收录',
      // 说明面板：用户问过「S 分是什么」「审计是什么」，这些解释要能自己看见，不能只留在聊天里
      help: '说明',
      helpTitle: '面板里的数字和标签是什么意思',
      helpIntro: '这个面板只做一件事：把 skills.sh 上几万个技能里值得看的挑出来，并把判断依据摊开。所有原始数字都来自上游，本插件只做汇总、去重和排序。',
      helpScoreTitle: '评分（默认排序依据，百分制 0–100）',
      helpScoreBody: '评分 = 0.45·热度 + 0.20·趋势 + 0.20·官方 + 0.15·安全检查，每项先算成 0～1 再加权，最后乘 100 取整，所以卡片上看的是 0～100 分。它不是 skills.sh 官方的分数，是本插件自己合成的排序分；权重目前是初值。',
      helpH: '热度 = 安装量取对数后归一化。头部 394 万与腰部 3 万差 100 倍，不取对数榜单就只剩前 20 名。',
      helpT: '趋势 = 8 周趋势裁剪到 −50% ～ +200% 再归一化。这是唯一能看出「正在退场」的指标；上游没给趋势时按 0% 算，会略低于中性。',
      helpC: '官方 = 官方或精选（curated）记 1，其余 0。',
      helpA: '安全检查 = 五家第三方检查里 pass 的比例。没有审计数据给中性 0.5，不给 0——否则非 GitHub 来源会被系统性歧视。',
      helpAuditTitle: '第三方安全检查',
      helpAuditBody: '不是我们审的，是 skills.sh 上五家第三方工具各扫一遍：Gen Agent Trust Hub、Socket、Snyk、Runlayer、ZeroLeaks。结论只有 pass / warn / fail，riskLevel 是它们自己的分级（SAFE / NONE / LOW / MEDIUM / HIGH / CRITICAL 都出现过）。卡片上的「第三方安全检查 4/5」= 5 家里 4 家 pass；fail 计入分母不剔除。pass 不等于安全，只等于这五家没报问题，fail 也可能是误报。',
      helpDataTitle: '安装数 / 8 周趋势',
      helpDataBody: '安装数是 skills.sh 接口快照；同一份内容被多个 owner 转发时会合并计算，卡片给的是合并后的量，详情里能看到本体量。8 周趋势 = 后四周周均 ÷ 前四周周均 − 1。星标数是 GitHub 仓库的星数（技能页上的 GitHub Stars），仓库级指标，同一仓库的技能共用。',
      helpTagsTitle: '卡片上的标签',
      helpTagsBody: '官方 / 精选 = skills.sh 的官方或 curated 标记。中文卡 = 这条有中文介绍（只做了安装量前 300 条）。有正文 = 抓到了 SKILL.md 正文。风险标记见下。',
      helpSourceTitle: '数据多久更新一次',
      helpSourceBody: '线上目录由 Vercel 定时任务每天采一次，面板顶部显示的版本就是那次快照的时间；中文卡随目录一起下发，所以换版本时中文内容也会一起更新。',
      tipScore: '评分：安装量 + 8 周趋势 + 官方身份 + 第三方安全检查 合成的百分制排序分（0–100），点右上「说明」看算法',
      tipAudit: '第三方安全检查：skills.sh 上五家工具（Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks）的结论；pass 不等于安全',
      tipFlags: '风险标记：deprecated 已废弃 / pointer 只是转发壳 / needs_api_key 要付费 key / needs_external_cli 要先装命令行工具 / thin_body 正文极短 / has_references 带引用文件',
      tipInstalls: '安装数：来自 skills.sh 接口快照；同一份内容被多个 owner 转发时合并计算',
      tipTrend: '8 周趋势：后四周周均 ÷ 前四周周均 − 1；上游没给趋势时显示 —',
      auditNote: '结论来自 skills.sh 的第三方安全检查，不是我们审的。pass 不等于安全，fail 也可能是误报。',
      scoreNote: '评分是本插件按「安装量 45% + 趋势 20% + 官方 20% + 安全检查 15%」合成的百分制分数，不是 skills.sh 官方的分数。',
      tipZh: '中文卡：这条有我们写的中文介绍，目前只覆盖安装量前 300 条',
      tipOfficial: '官方 / 精选：skills.sh 给的 official 或 curated 标记',
      tipEnriched: '有正文：已抓到 SKILL.md 正文（详情与风险标记靠它算出来）',
      flagDeprecated: '已废弃或只是兼容占位，别新装',
      flagPointer: '转发壳：正文让你去用另一个技能，单装没内容',
      flagNeedsApiKey: '要付费 API key 才能用',
      flagNeedsExternalCli: '要先在本机装好某个命令行工具',
      flagThinBody: '正文极短（不到 500 字），信息量有限',
      flagHasReferences: '带一堆引用文件，正文不是全部',
    };

    const EN = {
      nav: 'Skills Center',
      title: 'Skills Center',
      search: 'Search name, Chinese intro, or source…',
      sort: 'Sort',
      sortScore: 'Rating',
      sortInstalls: 'Installs',
      sortTrend: '8-week trend',
      sortName: 'Name',
      desc: 'Desc',
      asc: 'Asc',
      filterAll: 'All',
      filterZh: 'Chinese cards',
      filterOfficial: 'Official picks',
      filterRisky: 'Risk signals',
      filterEnriched: 'Has body',
      filterLabel: 'Filter',
      moreCategories: 'More categories',
      fewerCategories: 'Show less',
      sortField: 'Sort by',
      sortDir: 'Direction',
      dateRange: 'First seen',
      rangeAll: 'Any time',
      range30: 'Last 30 days',
      range90: 'Last 90 days',
      range365: 'Last year',
      sortInstalls4w: 'Installs (30d)',
      sortStars: 'GitHub stars',
      stars: 'GitHub stars',
      starsNote: 'Stars are per repository: every skill in the same repo shares the number. Taken from GitHub Stars on the skill page; only rows whose page we fetched have it.',
      tipStars: 'Stars of the GitHub repository this skill lives in (GitHub Stars on the skill page)',
      installs4w: 'Installs (30d)',
      installs4wNote: 'Upstream has no 30-day figure: this one sums the last four weekly points from the skill page (about 28 days).',
      firstSeenNote: 'Taken from First Seen on the skill page; only rows whose page we fetched have it. Upstream publishes no updated-at.',
      dateCoverage: 'with dates',
      updateAvailable: 'Update available',
      syncNow: 'Sync',
      syncing: 'Syncing…',
      syncFailed: 'Sync failed: ',
      categoryHint: 'Categories are inferred from what each skill does (keyword rules, not a skills.sh field). A skill can sit in several.',
      searchResults: 'Search results',
      prev: 'Prev',
      next: 'Next',
      page: 'Page',
      perPage: 'Per page',
      loading: 'Loading…',
      empty: 'No match.',
      failed: 'Failed: ',
      more: 'Load more',
      noMore: 'End of list',
      catalog: 'Catalog',
      matched: 'matched',
      showing: 'shown',
      active: 'active',
      version: 'version',
      none: 'none',
      intro: 'Intro',
      usage: 'Use for',
      notes: 'Caveats',
      installs: 'Installs',
      trend: '8-week trend',
      source: 'Source',
      flags: 'Flags',
      score: 'Rating',
      audit: 'Audit',
      auditNone: 'No audit verdict (not the same as safe)',
      auditPass: ' passed',
      termHeat: 'Heat',
      termTrend: 'Trend',
      termOfficial: 'Official',
      termCheck: 'Audit',
      id: 'Identifier',
      idHint: 'Format: source/repo/skill-name; it locates this row on skills.sh',
      installCmd: 'Install it yourself (run in a terminal)',
      close: 'Close',
      clickCard: 'Click a card for details',
      noIntro: 'Upstream gave no description; only name, installs and audits are known',
      representative: 'Official',
      curated: 'Curated',
      cardZh: 'Chinese card',
      enriched: 'Has body',
      firstSeen: 'First seen',
      help: 'Help',
      helpTitle: 'What the numbers and tags mean',
      helpIntro: 'This panel picks the skills worth looking at out of the tens of thousands on skills.sh and shows the evidence. Every raw number comes from upstream; this plugin only merges, dedupes and ranks.',
      helpScoreTitle: 'S score (default sort key)',
      helpScoreBody: 'S = 0.45·H + 0.20·T + 0.20·C + 0.15·A, each term in 0..1. It is not a skills.sh number: this plugin composes it from installs, 8-week trend, official status and audits. The weights are still a first pass.',
      helpH: 'H heat = installs, log-normalised. The head has 3.94M installs against 30k in the middle — a 100x spread that would leave only the top 20 on the list.',
      helpT: 'T momentum = 8-week trend clipped to -50%..+200%, then normalised. It is the only signal that shows a skill fading; when upstream has no trend we treat it as 0%, slightly below neutral.',
      helpC: 'C official = 1 for official or curated, otherwise 0.',
      helpA: 'A trust = share of pass verdicts among the five third-party audits. Missing audit data scores a neutral 0.5, never 0, or non-GitHub sources would be penalised systematically.',
      helpAuditTitle: 'Audits (third-party checks)',
      helpAuditBody: 'skills.sh runs five auditors on every skill: Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks. A verdict is pass / warn / fail, and riskLevel is their own scale (SAFE / NONE / LOW / MEDIUM / HIGH / CRITICAL all appear). "Audit 4/5" means four of five passed; fails stay in the denominator. Pass is not the same as safe — it only means none of the five flagged it, and a fail can be a false positive.',
      helpDataTitle: 'Installs / 8-week trend',
      helpDataBody: 'Installs come from a skills.sh API snapshot; when the same content is republished by several owners the counts are merged, and the card shows the merged figure while the detail shows the canonical one. 8-week trend = average of the last four weeks divided by the previous four, minus 1. Stars are the GitHub repository\u2019s count (GitHub Stars on the skill page) and are shared by every skill in that repository.',
      helpTagsTitle: 'Tags on a card',
      helpTagsBody: 'Official / Curated = skills.sh markers. Chinese card = we wrote a Chinese intro (top 300 by installs only). Has body = the SKILL.md body was fetched. Risk flags are listed below.',
      helpSourceTitle: 'How fresh is the data',
      helpSourceBody: 'A Vercel cron collects the catalog once a day; the version in the panel header is that snapshot time. Chinese cards ship with the catalog, so they update together.',
      tipScore: 'S score: installs + 8-week trend + official status + audits, composed by this plugin. See Help for the formula.',
      tipAudit: 'Audit: verdicts from five third-party tools on skills.sh (Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks). Pass is not the same as safe.',
      tipFlags: 'Risk flags: deprecated / pointer (forwarding shell) / needs_api_key / needs_external_cli / thin_body / has_references',
      tipInstalls: 'Installs: a skills.sh API snapshot; republished copies by several owners are merged',
      tipTrend: '8-week trend: last four weeks vs the previous four, minus 1; — when upstream has none',
      auditNote: 'Verdicts come from third-party audits on skills.sh, not from us. Pass is not safe; a fail can be a false positive.',
      scoreNote: 'The S score is this plugin\u2019s own ranking (installs + trend + official + audits), not a skills.sh number.',
      tipZh: 'Chinese card: we wrote a Chinese intro for this one (top 300 by installs)',
      tipOfficial: 'Official / Curated: the marker skills.sh publishes',
      tipEnriched: 'Has body: the SKILL.md body was fetched (risk flags and detail depend on it)',
      flagDeprecated: 'Deprecated or a compatibility placeholder — do not install it fresh',
      flagPointer: 'Forwarding shell: the body tells you to use another skill',
      flagNeedsApiKey: 'Needs a paid API key to work',
      flagNeedsExternalCli: 'Needs a command-line tool installed locally first',
      flagThinBody: 'Body is under 500 characters — little to read',
      flagHasReferences: 'Ships a pile of reference files; the body is not the whole story',
    };

    // 词典由 apply 里的 locale 服务注册；这里留一个直读中文的兜底，
    // 保证 locale 拿不到时面板不会变成一片 key。
    let translate = () => '';
    const t = (key) => {
      const value = translate(key);
      return value && value !== key ? value : ZH[key] || key;
    };

    const STYLE = `.dsc-root{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;
color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.dsc-top{padding:24px 38px 0;flex:0 0 auto}
.dsc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsc-meta{margin-top:7px}
.dsc-title{margin:0;font-size:17px;font-weight:600;letter-spacing:.2px}
.dsc-meta{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;letter-spacing:.1px}
.dsc-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}
.dsc-search{flex:1 1 320px;min-width:220px;display:flex;align-items:center;gap:9px;height:38px;padding:0 13px;
border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);
color:var(--dsw-alias-label-secondary)}
.dsc-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dsc-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);
font:inherit;font-size:13.5px}
.dsc-btn{height:38px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;
cursor:pointer;white-space:nowrap;transition:border-color .12s,background .12s}
.dsc-btn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsc-btn[disabled]{opacity:.5;cursor:default}
.dsc-head-actions{display:flex;align-items:center;gap:8px}
.dsc-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:500}
.dsc-hint-error{color:var(--dsw-alias-state-error-primary)}
.dsc-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center}
.dsc-chips-sub{margin-top:10px;gap:6px}
.dsc-chip-label{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin-right:2px}
.dsc-chip-sm{height:26px;padding:0 11px;font-size:12.5px}
.dsc-chip-ghost{border-style:dashed}
.dsc-hint{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsc-chip{height:30px;padding:0 15px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;
background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;
transition:border-color .12s,color .12s,background .12s}
.dsc-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsc-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);
background:var(--dsw-alias-bg-layer-2);font-weight:500}
.dsc-rule{height:1px;background:var(--dsw-alias-border-l1);margin-top:18px}
.dsc-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:0 38px 34px}
.dsc-inner{max-width:1180px;margin:0 auto}
.dsc-section{display:flex;align-items:baseline;gap:10px;margin:26px 0 18px}
.dsc-section h3{margin:0;font-size:15.5px;font-weight:600}
.dsc-section span{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:20px 18px}
.dsc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);
padding:19px 21px 17px;display:flex;flex-direction:column;gap:13px;cursor:pointer;
transition:border-color .14s,box-shadow .14s,background .14s}
.dsc-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
box-shadow:0 6px 18px rgba(15,17,21,.07)}
.dsc-card-top{display:flex;align-items:flex-start;gap:12px}
.dsc-card-name{flex:1 1 auto;min-width:0}
.dsc-card-name strong{display:block;font-size:15.5px;font-weight:600;line-height:1.45;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-sub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}
.dsc-pill{flex:0 0 auto;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsc-desc{margin:0;font-size:13.5px;line-height:1.75;color:var(--dsw-alias-label-primary);opacity:.82;
display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsc-desc.dsc-muted{font-style:italic}
.dsc-facts{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:13px;
color:var(--dsw-alias-label-secondary)}
.dsc-facts b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dsc-facts i{font-style:normal;color:var(--dsw-alias-border-l2)}
.dsc-tags{display:flex;gap:7px;flex-wrap:wrap}
.dsc-tag{padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;font-size:12px;
color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsc-tag.dsc-brand{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.dsc-tag.dsc-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsc-tag.dsc-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsc-tag.dsc-good{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsc-up{color:var(--dsw-alias-state-success-primary)}
.dsc-down{color:var(--dsw-alias-state-error-primary)}
.dsc-foot{flex:0 0 auto;padding:18px 38px 22px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsc-foot-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dsc-pager{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsc-page{min-width:32px;height:32px;padding:0 9px;border:1px solid transparent;border-radius:8px;
background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;
font-variant-numeric:tabular-nums}
.dsc-page:hover{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.dsc-page[data-on="true"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.dsc-page[disabled]{opacity:.4;cursor:default}
.dsc-page-info{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsc-menu{position:relative}
.dsc-menu-btn{display:inline-flex;align-items:center;gap:6px}
.dsc-menu-btn-sm{height:32px;padding:0 11px;font-size:12.5px}
.dsc-caret{font-size:10px;color:var(--dsw-alias-label-secondary);position:relative;top:-1px}
.dsc-menu-group{padding:9px 12px 5px;color:var(--dsw-alias-label-secondary);font-size:12px;letter-spacing:.2px}
.dsc-menu-sep{height:1px;background:var(--dsw-alias-border-l2);margin:8px 2px}
.dsc-menu-item{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsc-menu-check{color:var(--dsw-alias-brand-primary);font-size:12px}
.dsc-menu-list{position:absolute;z-index:30;top:calc(100% + 6px);right:0;min-width:100%;padding:6px;
border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-overlay);
box-shadow:0 12px 30px rgba(15,17,21,.16);display:flex;flex-direction:column;gap:2px}
.dsc-menu-item{padding:7px 12px;border:0;border-radius:7px;background:transparent;
color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap}
.dsc-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsc-menu-item[data-on="true"]{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.dsc-empty{padding:34px 2px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsc-overlay{position:fixed;inset:0;z-index:40;background:rgba(15,17,21,.42);display:flex;
align-items:center;justify-content:center;padding:36px}
.dsc-modal{width:min(760px,100%);max-height:100%;overflow:auto;border-radius:15px;
border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);
box-shadow:0 24px 60px rgba(15,17,21,.28)}
.dsc-modal-head{position:sticky;top:0;display:flex;align-items:flex-start;gap:14px;padding:18px 22px;
border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay)}
.dsc-modal-head h3{margin:0;font-size:16px;line-height:1.45}
.dsc-modal-body{padding:18px 22px 22px;display:flex;flex-direction:column;gap:16px}
.dsc-field{display:flex;flex-direction:column;gap:5px}
.dsc-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-text{margin:0;font-size:13.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.dsc-code{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;
white-space:pre-wrap;word-break:break-all}
.dsc-note{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dsc-help-section{display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsc-help-section:first-child{padding-top:0;border-top:0}
.dsc-help-h{margin:0;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsc-help-p{margin:0;font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary);max-width:62ch}
.dsc-help-row{display:flex;gap:12px;align-items:baseline;font-size:13px;line-height:1.75}
.dsc-help-row b{flex:0 0 auto;min-width:104px;color:var(--dsw-alias-label-primary);font-weight:600}
.dsc-help-row span{color:var(--dsw-alias-label-secondary);max-width:56ch}
.dsc-audit{display:flex;flex-direction:column;gap:7px}
.dsc-audit-row{display:flex;gap:10px;align-items:baseline;font-size:13px}
.dsc-audit-row span:first-child{flex:0 0 auto;min-width:150px;color:var(--dsw-alias-label-secondary)}
`;

    const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
    /** 页码窗口：首页、末页、当前页与左右各一页，中间用省略号——目录三百多页，全铺放不下。 */
    function pageNumbers(current, total) {
      const wanted = new Set([1, total, current, current - 1, current + 1]);
      if (current <= 3) [2, 3, 4].forEach((n) => wanted.add(n));
      if (current >= total - 2) [total - 1, total - 2, total - 3].forEach((n) => wanted.add(n));
      const list = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
      const out = [];
      let prev = 0;
      for (const n of list) {
        if (prev && n - prev > 1) out.push('…');
        out.push(n);
        prev = n;
      }
      return out;
    }

    /** full-2026-10-20T03-00-49-872Z → 2026-10-20 03:00；看不懂的快照串不该占页头。 */
    const fmtVersion = (v) => {
      const raw = String(v || '').replace(/^(full|dir)-/, '');
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(raw);
      return m ? `${m[1]} ${m[2]}:${m[3]}` : raw || t('none');
    };
    const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
    /** 星标用 K/M 紧凑写法（182.2K），和 GitHub、插件市场一致；数字大时比 182,200 好读。 */
    const fmtStars = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      const value = Number(n);
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return String(value);
    };
    const trendClass = (v) => (v == null ? '' : v > 0 ? 'dsc-up' : v < 0 ? 'dsc-down' : '');

    function field(label, value) {
      if (!value) return null;
      return h(
        'div',
        { className: 'dsc-field' },
        h('span', { className: 'dsc-label' }, label),
        h('p', { className: 'dsc-text' }, value),
      );
    }

    /** 风险标记 → 一句解释；卡片 tooltip、详情弹层、说明弹层都用同一份，避免三处说不一样。 */
    const FLAG_KEYS = {
      deprecated: 'flagDeprecated',
      pointer: 'flagPointer',
      needs_api_key: 'flagNeedsApiKey',
      needs_external_cli: 'flagNeedsExternalCli',
      thin_body: 'flagThinBody',
      has_references: 'flagHasReferences',
    };
    const explainFlag = (flag) => t(FLAG_KEYS[flag] || flag);

    /** 「说明」弹层：S 分、审计、标签、数据口径一次讲清，省得每次都要人解释。 */
    function Help({ onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      });

      const section = (title, body, rows) =>
        h(
          'div',
          { className: 'dsc-help-section' },
          h('h4', { className: 'dsc-help-h' }, title),
          h('p', { className: 'dsc-help-p' }, body),
          rows || null,
        );
      const rows = (list) =>
        h(
          'div',
          { className: 'dsc-audit' },
          list.map(([name, body]) => h('div', { className: 'dsc-help-row', key: name }, h('b', null, name), h('span', null, body))),
        );

      return h(
        'div',
        { className: 'dsc-overlay', onClick: onClose },
        h(
          'div',
          { className: 'dsc-modal', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'dsc-modal-head' },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('h3', null, t('helpTitle'))),
            h('button', { type: 'button', className: 'dsc-btn', onClick: onClose }, t('close')),
          ),
          h(
            'div',
            { className: 'dsc-modal-body' },
            h('div', { className: 'dsc-help-section' }, h('p', { className: 'dsc-help-p' }, t('helpIntro'))),
            section(
              t('helpScoreTitle'),
              t('helpScoreBody'),
              rows([
                [t('termHeat'), t('helpH')],
                [t('termTrend'), t('helpT')],
                [t('termOfficial'), t('helpC')],
                [t('termCheck'), t('helpA')],
              ]),
            ),
            section(t('helpDataTitle'), t('helpDataBody')),
            section(t('helpAuditTitle'), t('helpAuditBody')),
            section(
              t('helpTagsTitle'),
              t('helpTagsBody'),
              rows(Object.keys(FLAG_KEYS).map((flag) => [flag, explainFlag(flag)])),
            ),
            section(t('helpSourceTitle'), t('helpSourceBody')),
          ),
        ),
      );
    }

    /**
     * 自绘下拉菜单。不用原生 <select>：那个展开层是操作系统的 UI，明暗主题、圆角、字号
     * 都不受宿主 token 控制，和面板放一起像两个程序。
     */
    function Menu({ label, sections, compact, title }) {
      const [open, setOpen] = useState(false);
      const box = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (box.current && !box.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      });

      // 按钮上显示第一组（排序字段）的当前值，和截图一致
      const head = sections[0];
      const current = head.options.find((option) => option.value === head.value);

      return h(
        'div',
        { className: 'dsc-menu', ref: box },
        h(
          'button',
          {
            type: 'button',
            className: compact ? 'dsc-btn dsc-menu-btn dsc-menu-btn-sm' : 'dsc-btn dsc-menu-btn',
            onClick: () => setOpen(!open),
            'aria-expanded': open ? 'true' : 'false',
            title: title || label,
          },
          h('span', null, current ? current.label : label),
          h('span', { className: 'dsc-caret' }, '▾'),
        ),
        open
          ? h(
              'div',
              { className: 'dsc-menu-list' },
              sections.flatMap((section, index) => [
                index ? h('div', { key: `sep-${section.label}`, className: 'dsc-menu-sep' }) : null,
                h('div', { key: `group-${section.label}`, className: 'dsc-menu-group' }, section.label),
                ...section.options.map((option) =>
                  h(
                    'button',
                    {
                      key: `${section.label}-${option.value}`,
                      type: 'button',
                      className: 'dsc-menu-item',
                      'data-on': option.value === section.value ? 'true' : 'false',
                      onClick: () => {
                        section.onChange(option.value);
                        setOpen(false);
                      },
                    },
                    option.label,
                    option.value === section.value ? h('span', { className: 'dsc-menu-check' }, '✓') : null,
                  ),
                ),
              ]),
            )
          : null,
      );
    }
    function SearchIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.6, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M10.6 10.6 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      );
    }

    /** 一张技能卡：中文名 + 来源 + 两行介绍 + 装量/趋势 + 最多两个标签。 */
    function Card({ row, onOpen }) {
      const tags = [];
      if (row.official) tags.push(['dsc-brand', t('representative'), t('tipOfficial')]);
      else if (row.curated) tags.push(['dsc-brand', t('curated'), t('tipOfficial')]);
      const audit = row.audit;
      if (audit) {
        // 「4/5 通过」既可能是 4 pass + 1 warn，也可能是 4 pass + 1 fail，
        // 用颜色区分只会让人误读，所以一律中性；只有真的出现 fail 才单独标红。
        tags.push([
          audit.fail ? 'dsc-bad' : '',
          audit.fail
            ? `${t('audit')} ${audit.pass}/${audit.judged}（${audit.fail} fail）`
            : `${t('audit')} ${audit.pass}/${audit.judged}`,
          t('tipAudit'),
        ]);
      }
      // 标签只留最该看见的两类（身份 + 审计结论），其余风险压成一个计数：
      // 卡片上铺六七个胶囊正是上一版显得拥挤的原因。
      const flags = row.flags || [];
      if (flags.length) {
        const text = flags.length === 1 ? flags[0] : `${flags[0]} +${flags.length - 1}`;
        tags.push(['dsc-warn', text, flags.map((flag) => `${flag}：${explainFlag(flag)}`).join('\n')]);
      }
      if (row.has_zh) tags.push(['dsc-good', t('cardZh'), t('tipZh')]);

      return h(
        'div',
        { className: 'dsc-card', onClick: () => onOpen(row), role: 'button', tabIndex: 0 },
        h(
          'div',
          { className: 'dsc-card-top' },
          h(
            'div',
            { className: 'dsc-card-name' },
            h('strong', null, row.name_zh || row.slug || row.id),
            h('div', { className: 'dsc-sub' }, `${row.slug || row.id}${row.source ? ` · ${row.source}` : ''}`),
          ),
          h(
            'span',
            { className: 'dsc-pill', title: t('tipScore') },
            `${t('score')} ${row.S == null ? '—' : Math.round(Number(row.S) * 100)}`,
          ),
        ),
        h(
          'p',
          { className: row.has_zh || row.description ? 'dsc-desc' : 'dsc-desc dsc-muted' },
          row.description || t('noIntro'),
        ),
        h(
          'div',
          { className: 'dsc-facts' },
          h('span', { title: t('tipInstalls') }, `${t('installs')} `, h('b', null, fmtInt(row.installs))),
          h('i', null, '·'),
          h(
            'span',
            { className: trendClass(row.trend_pct), title: t('tipTrend') },
            `${t('trend')} ${fmtPct(row.trend_pct)}`,
          ),
          // 星标是仓库级指标，没抓过页面的条目没有 → 没有就不占位（不写「0」）
          row.stars == null
            ? null
            : [
                h('i', { key: 'star-sep' }, '·'),
                h('span', { key: 'stars', title: t('tipStars') }, `★ ${fmtStars(row.stars)}`),
              ],
        ),
        tags.length
          ? h(
              'div',
              { className: 'dsc-tags' },
              tags.map(([cls, text, tip], index) =>
                h('span', { key: `${text}-${index}`, className: `dsc-tag ${cls}`.trim(), title: tip || undefined }, text),
              ),
            )
          : null,
      );
    }

    /** 详情弹层：完整中文卡 + 审计明细 + 安装命令。 */
    function Detail({ state, onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      });

      const skill = state.skill || {};
      const row = state.row || {};
      const zh = skill.zh || {};
      const score = skill.score || row.score || {};
      const title = row.name_zh || skill.name_zh || zh.name_zh || row.slug || state.id;

      return h(
        'div',
        { className: 'dsc-overlay', onClick: onClose },
        h(
          'div',
          { className: 'dsc-modal', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'dsc-modal-head' },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('h3', null, title),
              h('div', { className: 'dsc-sub' }, `${row.verdict || ''}　${skill.id || state.id || ''}`),
            ),
            h('button', { type: 'button', className: 'dsc-btn', onClick: onClose }, t('close')),
          ),
          h(
            'div',
            { className: 'dsc-modal-body' },
            state.status === 'loading' ? h('div', { className: 'dsc-empty' }, t('loading')) : null,
            state.status === 'error' ? h('div', { className: 'dsc-empty' }, t('failed') + (state.error || '')) : null,
            field(t('intro'), zh.intro || skill.intro_zh || skill.description_en || t('noIntro')),
            field(t('usage'), zh.usage),
            field(t('notes'), zh.notes),
            field(t('installs'), fmtInt(skill.installs ?? row.installs)),
            (() => {
              const stars = skill.stars ?? row.stars;
              if (stars == null) return null;
              return h(
                'div',
                { className: 'dsc-field' },
                h('span', { className: 'dsc-label' }, t('stars')),
                h('p', { className: 'dsc-text' }, `${fmtInt(stars)}（★ ${fmtStars(stars)}）`),
                h('p', { className: 'dsc-note' }, t('starsNote')),
              );
            })(),
            (() => {
              const four = skill.installs_4w ?? row.installs_4w;
              if (four == null) return null;
              return h(
                'div',
                { className: 'dsc-field' },
                h('span', { className: 'dsc-label' }, t('installs4w')),
                h('p', { className: 'dsc-text' }, fmtInt(four)),
                h('p', { className: 'dsc-note' }, t('installs4wNote')),
              );
            })(),
            field(t('trend'), fmtPct(skill.trend_pct ?? row.trend_pct)),
            field(t('source'), skill.source),
            score.S == null
              ? null
              : h(
                  'div',
                  { className: 'dsc-field' },
                  h('span', { className: 'dsc-label' }, t('score')),
                  h(
                    'p',
                    { className: 'dsc-text' },
                    [
                      `${Math.round(Number(score.S) * 100)} 分`,
                      `${t('termHeat')} ${Math.round(Number(score.H) * 100)}`,
                      `${t('termTrend')} ${Math.round(Number(score.T) * 100)}`,
                      `${t('termOfficial')} ${Math.round(Number(score.C) * 100)}`,
                      `${t('termCheck')} ${Math.round(Number(score.A) * 100)}`,
                    ].join(' · '),
                  ),
                  h('p', { className: 'dsc-note' }, t('scoreNote')),
                ),
            (() => {
              const seen = skill.first_seen || row.first_seen;
              if (!seen) return null;
              return h(
                'div',
                { className: 'dsc-field' },
                h('span', { className: 'dsc-label' }, t('firstSeen')),
                h('p', { className: 'dsc-text' }, seen),
                h('p', { className: 'dsc-note' }, t('firstSeenNote')),
              );
            })(),
            (skill.flags || row.flags || []).length
              ? h(
                  'div',
                  { className: 'dsc-field' },
                  h('span', { className: 'dsc-label' }, t('flags')),
                  h(
                    'div',
                    { className: 'dsc-audit' },
                    (skill.flags || row.flags || []).map((flag) =>
                      h(
                        'div',
                        { className: 'dsc-audit-row', key: flag },
                        h('span', null, flag),
                        h('span', null, explainFlag(flag)),
                      ),
                    ),
                  ),
                )
              : null,
            (() => {
              const audits = skill.audit?.audits || [];
              if (!audits.length) return field(t('audit'), t('auditNone'));
              return h(
                'div',
                { className: 'dsc-field' },
                h('span', { className: 'dsc-label' }, t('audit')),
                h(
                  'div',
                  { className: 'dsc-audit' },
                  audits.map((item, index) =>
                    h(
                      'div',
                      { className: 'dsc-audit-row', key: `${item.provider}-${index}` },
                      h('span', null, item.provider || item.slug || '—'),
                      h(
                        'span',
                        {
                          className:
                            item.status === 'fail' ? 'dsc-down' : item.status === 'warn' ? 'dsc-up' : '',
                        },
                        `${item.status || '—'}${item.riskLevel ? ` / ${item.riskLevel}` : ''}`,
                      ),
                    ),
                  ),
                ),
                // 审计是最容易被误读的一栏：pass 常被当成「安全」，这里把口径写在结论旁边
                h('p', { className: 'dsc-note' }, t('auditNote')),
              );
            })(),
            row.install_hint
              ? h(
                  'div',
                  { className: 'dsc-field' },
                  h('span', { className: 'dsc-label' }, t('installCmd')),
                  h('pre', { className: 'dsc-code' }, row.install_hint),
                )
              : null,
            h(
              'div',
              { className: 'dsc-field' },
              h('span', { className: 'dsc-label' }, t('id')),
              h('p', { className: 'dsc-text' }, skill.id || row.id || '—'),
              h('p', { className: 'dsc-note' }, t('idHint')),
            ),
          ),
        ),
      );
    }

    function Panel() {
      const [state, setState] = useState({
        status: 'loading',
        rows: [],
        matched: 0,
        total: 0,
        version: null,
        active: [],
        maxActive: 0,
        categories: [],
        classified: 0,
        dated: 0,
        remote: null,
        error: '',
      });
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState('S');
      const [dir, setDir] = useState('desc');
      const [filter, setFilter] = useState('');
      const [category, setCategory] = useState('');
      const [showAllCategories, setShowAllCategories] = useState(false);
      const [since, setSince] = useState(0);
      const [syncing, setSyncing] = useState(false);
      const [syncError, setSyncError] = useState('');
      // 同步成功后靠它触发一次重新取数（改 deps 比手动调 load 更稳）
      const [refreshKey, setRefreshKey] = useState(0);
      const [page, setPage] = useState(1);
      const [pageSize, setPageSize] = useState(PAGE);
      const [detail, setDetail] = useState({ status: 'idle', id: '', skill: null, row: null });
      const [help, setHelp] = useState(false);
      const requestId = useRef(0);
      const scroller = useRef(null);

      /** 按页取数：翻页与改条件走同一条路，永远是「替换」而不是「追加」。 */
      const load = async (targetPage, size) => {
        const token = requestId.current + 1;
        requestId.current = token;
        setState((prev) => ({ ...prev, status: 'loading', error: '' }));
        const params = new URLSearchParams({
          limit: String(size),
          offset: String((targetPage - 1) * size),
          sort,
          dir,
        });
        if (query.trim()) params.set('q', query.trim());
        if (filter) params.set('filter', filter);
        if (category) params.set('category', category);
        if (since) params.set('since', String(since));
        try {
          const response = await fetch(`${API}/list?${params.toString()}`, {
            headers: { accept: 'application/json' },
          });
          const body = await response.json();
          if (requestId.current !== token) return; // 有更新的请求在路上，这一份丢弃
          // 这里必须用函数式 setState：分类计数要沿用上一份（响应没带 categories 时不能清空）
          setState((prev) => ({
            status: 'ready',
            rows: Array.isArray(body.rows) ? body.rows : [],
            matched: body.matched || 0,
            total: body.total || 0,
            version: body.version || null,
            active: Array.isArray(body.active) ? body.active : prev.active,
            maxActive: body.maxActive || prev.maxActive,
            categories: Array.isArray(body.categories) ? body.categories : prev.categories,
            classified: body.classified || prev.classified,
            dated: body.dated ?? prev.dated,
            remote: body.remote || prev.remote,
            error: '',
          }));
        } catch (error) {
          if (requestId.current !== token) return;
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: String(error && error.message ? error.message : error),
          }));
        }
      };

      // 条件或页码一变就重拉（防抖 200ms，打字期间不打接口）。
      useEffect(() => {
        const timer = setTimeout(() => load(page, pageSize), 200);
        return () => clearTimeout(timer);
      }, [query, sort, dir, filter, category, since, page, pageSize, refreshKey]);

      // 换页后把列表滚回顶部，否则翻到下一页还停在上一页的滚动位置。
      useEffect(() => {
        if (scroller.current) scroller.current.scrollTop = 0;
      }, [page]);

      // 切面板/卸载时把未完成的响应标记作废，避免回过头的 setState。
      useEffect(() => () => {
        requestId.current += 1;
      }, []);

  /** 同步远端目录：宿主那边是 POST /sync；成功后让 effect 重新拉一次数据。 */
      const doSync = async () => {
        setSyncing(true);
        setSyncError('');
        try {
          const response = await fetch(`${API}/sync`, { method: 'POST', headers: { accept: 'application/json' } });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.ok === false) throw new Error(body.reason || body.error || `http_${response.status}`);
        } catch (error) {
          setSyncError(String(error && error.message ? error.message : error));
        }
        setSyncing(false);
        setRefreshKey((n) => n + 1);
      };

      const openDetail = async (row) => {
        setDetail({ status: 'loading', id: row.id, skill: null, row });
        try {
          const response = await fetch(`${API}/card?id=${encodeURIComponent(row.id)}`, {
            headers: { accept: 'application/json' },
          });
          const skill = await response.json();
          setDetail({ status: 'ready', id: row.id, skill, row });
        } catch (error) {
          setDetail({ status: 'error', id: row.id, skill: null, row, error: String(error) });
        }
      };

      const filters = [
        ['', t('filterAll')],
        ['zh', t('filterZh')],
        ['official', t('filterOfficial')],
        ['risky', t('filterRisky')],
        ['enriched', t('filterEnriched')],
      ];
      const sorts = [
        ['S', t('sortScore')],
        ['installs', t('sortInstalls')],
        ['installs4w', t('sortInstalls4w')],
        ['stars', t('sortStars')],
        ['trend', t('sortTrend')],
        ['name', t('sortName')],
      ];
      // 时间范围按「发布时间（First Seen）」筛；没抓过页面详情的条目没有这个日期
      const ranges = [
        [0, t('rangeAll')],
        [30, t('range30')],
        [90, t('range90')],
        [365, t('range365')],
      ];
      const pageSizes = [24, 48, 96, 192];

      const meta = [
        `${t('catalog')} ${fmtInt(state.total)}`,
        state.matched ? `${t('matched')} ${fmtInt(state.matched)}` : '',
        `${t('version')} ${state.version ? fmtVersion(state.version) : t('none')}`,
        `${t('active')} ${state.active.length}${state.maxActive ? `/${state.maxActive}` : ''}`,
      ]
        .filter(Boolean)
        .join(' · ');

      const activeFilterLabel = (filters.find(([value]) => value === filter) || ['', t('filterAll')])[1];
      const sectionTitle = query.trim() ? `${t('searchResults')}·${query.trim()}` : activeFilterLabel;

      // 分类菜单：按条数取前 12 个铺成 chips，其余收进「更多分类」下拉——
      // 28 个分类全铺会占掉半屏，而长尾分类本来就少人点。
      // 服务端已把「其他」排到最后：chips 只铺真分类，兜底桶和其他长尾一起进下拉
      const allCategories = state.categories.filter((c) => c.count > 0 && c.key !== 'other');
      const topCategories = allCategories.slice(0, 12);
      const restCategories = [
        ...allCategories.slice(12),
        ...state.categories.filter((c) => c.key === 'other' && c.count > 0),
      ];

      const totalPages = Math.max(1, Math.ceil(state.matched / pageSize));
      const currentPage = Math.min(Math.max(1, page), totalPages);
      const jump = (next) => setPage(Math.min(Math.max(1, next), totalPages));

      return h(
        'div',
        { className: 'dsc-root' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dsc-top' },
          h(
            'div',
            { className: 'dsc-inner' },
            h(
              'div',
              { className: 'dsc-head' },
              h('h2', { className: 'dsc-title' }, t('title')),
              // 「S 分是什么」「审计是什么」这类问题要能在界面里自己找到答案
              h(
                'div',
                { className: 'dsc-head-actions' },
                // 远端有新版才出现：宿主每 6 小时 HEAD 一次，不下载正文
                state.remote?.updateAvailable
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsc-btn dsc-btn-primary',
                        disabled: syncing,
                        onClick: doSync,
                        title: `${t('updateAvailable')} · ${t('syncNow')}`,
                      },
                      syncing ? t('syncing') : `${t('updateAvailable')} · ${t('syncNow')}`,
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'dsc-btn', onClick: () => setHelp(true) },
                  `? ${t('help')}`,
                ),
              ),
            ),
            h('div', { className: 'dsc-meta' }, meta),
          h(
            'div',
            { className: 'dsc-tools' },
            h(
              'label',
              { className: 'dsc-search' },
              h(SearchIcon),
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search'),
                spellCheck: false,
                onChange: (event) => {
                  setQuery(event.target.value);
                  setPage(1);
                },
              }),
            ),
            // 一个浮层里三组：排序字段 / 排序方向 / 发布时间范围（方向不再单独占一个按钮）
            h(Menu, {
              label: t('sortField'),
              title: t('sort'),
              sections: [
                {
                  label: t('sortField'),
                  value: sort,
                  options: sorts.map(([value, label]) => ({ value, label })),
                  onChange: (next) => {
                    setSort(next);
                    setPage(1);
                  },
                },
                {
                  label: t('sortDir'),
                  value: dir,
                  options: [
                    { value: 'desc', label: t('desc') },
                    { value: 'asc', label: t('asc') },
                  ],
                  onChange: (next) => {
                    setDir(next);
                    setPage(1);
                  },
                },
                {
                  label: t('dateRange'),
                  value: String(since),
                  options: ranges.map(([value, label]) => ({ value: String(value), label })),
                  onChange: (next) => {
                    setSince(Number(next));
                    setPage(1);
                  },
                },
              ],
            }),
          ),
          h(
            'div',
            { className: 'dsc-chips' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsc-chip',
                'data-on': category ? 'false' : 'true',
                onClick: () => {
                  setCategory('');
                  setPage(1);
                },
              },
              `${t('filterAll')} ${fmtInt(state.total)}`,
            ),
            topCategories.map((item) =>
              h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  className: 'dsc-chip',
                  'data-on': category === item.key ? 'true' : 'false',
                  title: `${item.label} ${fmtInt(item.count)}`,
                  onClick: () => {
                    setCategory(category === item.key ? '' : item.key);
                    setPage(1);
                  },
                },
                item.label,
              ),
            ),
            // 不用原生下拉：那个弹出菜单是操作系统的样式，和面板完全不搭。
            // 改成行内展开——点一下把剩余分类铺成同样的小胶囊，再点收起。
            restCategories.length
              ? [
                  showAllCategories
                    ? restCategories.map((item) =>
                        h(
                          'button',
                          {
                            key: item.key,
                            type: 'button',
                            className: 'dsc-chip dsc-chip-sm',
                            'data-on': category === item.key ? 'true' : 'false',
                            title: `${item.label} ${fmtInt(item.count)}`,
                            onClick: () => {
                              setCategory(category === item.key ? '' : item.key);
                              setPage(1);
                            },
                          },
                          item.label,
                        ),
                      )
                    : null,
                  h(
                    'button',
                    {
                      key: 'toggle-categories',
                      type: 'button',
                      className: 'dsc-chip dsc-chip-sm dsc-chip-ghost',
                      onClick: () => setShowAllCategories(!showAllCategories),
                    },
                    showAllCategories ? t('fewerCategories') : `${t('moreCategories')}（${restCategories.length}）`,
                  ),
                ]
              : null,
          ),
          h(
            'div',
            { className: 'dsc-chips dsc-chips-sub' },
            h('span', { className: 'dsc-chip-label' }, t('filterLabel')),
            filters.map(([value, label]) =>
              h(
                'button',
                {
                  key: value || 'all',
                  type: 'button',
                  className: 'dsc-chip dsc-chip-sm',
                  'data-on': filter === value ? 'true' : 'false',
                  onClick: () => {
                    setFilter(value);
                    setPage(1);
                  },
                },
                label,
              ),
            ),
          ),
          h('div', { className: 'dsc-hint' }, `${t('categoryHint')} ${t('matched')} ${fmtInt(state.matched)}`),
          syncError ? h('div', { className: 'dsc-hint dsc-hint-error' }, `${t('syncFailed')}${syncError}`) : null,
          since
            ? h(
                'div',
                { className: 'dsc-hint' },
                `${t('dateRange')}：${t('dateCoverage')} ${fmtInt(state.dated)} / ${fmtInt(state.total)} · ${t('firstSeenNote')}`,
              )
            : null,
            h('div', { className: 'dsc-rule' }),
          ),
        ),
        h(
          'div',
          { className: 'dsc-scroll', ref: scroller },
          // 内容限宽并居中：两侧留白随窗口自适应；拉满整屏会让卡片排到五列，读起来像墙。
          h(
            'div',
            { className: 'dsc-inner' },
            h(
              'div',
              { className: 'dsc-section' },
              h('h3', null, sectionTitle),
              h('span', null, `${t('matched')} ${fmtInt(state.matched)}`),
            ),
            state.status === 'loading'
              ? h('div', { className: 'dsc-empty' }, t('loading'))
              : state.rows.length
                ? h(
                    'div',
                    { className: 'dsc-grid' },
                    state.rows.map((row) => h(Card, { key: row.id, row, onOpen: openDetail })),
                  )
                : h('div', { className: 'dsc-empty' }, state.status === 'error' ? t('failed') + state.error : t('empty')),
          ),
        ),
        h(
          'div',
          { className: 'dsc-foot' },
          h(
            'div',
            { className: 'dsc-inner dsc-foot-inner' },
            h(
              'div',
              { className: 'dsc-pager' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-page',
                  disabled: currentPage <= 1,
                  onClick: () => jump(currentPage - 1),
                },
                t('prev'),
              ),
              pageNumbers(currentPage, totalPages).map((item, index) =>
                item === '…'
                  ? h('span', { key: `gap-${index}`, className: 'dsc-page-info' }, '…')
                  : h(
                      'button',
                      {
                        key: `page-${item}`,
                        type: 'button',
                        className: 'dsc-page',
                        'data-on': item === currentPage ? 'true' : 'false',
                        onClick: () => jump(item),
                      },
                      String(item),
                    ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-page',
                  disabled: currentPage >= totalPages,
                  onClick: () => jump(currentPage + 1),
                },
                t('next'),
              ),
            ),
            h(
              'div',
              { className: 'dsc-page-info' },
              h('span', null, `${t('page')} ${currentPage} / ${totalPages}`),
              h(Menu, {
                label: t('perPage'),
                title: t('perPage'),
                compact: true,
                sections: [
                  {
                    label: t('perPage'),
                    value: String(pageSize),
                    options: pageSizes.map((size) => ({ value: String(size), label: `${t('perPage')} ${size}` })),
                    onChange: (next) => {
                      setPageSize(Number(next));
                      setPage(1);
                    },
                  },
                ],
              }),
              state.error ? h('span', null, t('failed') + state.error) : null,
            ),
          ),
        ),
        detail.status === 'idle' ? null : h(Detail, { state: detail, onClose: () => setDetail({ status: 'idle', id: '', skill: null, row: null }) }),
        help ? h(Help, { onClose: () => setHelp(false) }) : null,
      );
    }

    // 侧栏图标：一个「目录 + 列表」的方框，尺寸与选中态都由宿主给。
    function Icon(owner) {
      const size = (owner && owner.size) || 16;
      const active = Boolean(owner && owner.active);
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 1.6, y: 2.2, width: 5.6, height: 5.6, rx: 1.3, stroke: color, strokeWidth: 1.3 }),
        h('rect', { x: 1.6, y: 8.9, width: 5.6, height: 4.9, rx: 1.3, stroke: color, strokeWidth: 1.3 }),
        h('path', {
          d: 'M10.4 4.4h4M10.4 7.3h4M10.4 11.4h2.4',
          stroke: color,
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    function apply(ctx) {
      // 词典注册失败不能连带面板一起消失：locale 缺失时 t() 直读中文兜底。
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, 'zh', ZH), 'skills-center: locale zh');
      } catch (error) {
        void error;
      }
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, 'en', EN), 'skills-center: locale en');
      } catch (error) {
        void error;
      }
      translate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NAMESPACE) : () => '';

      // 侧栏那一行是 id，主区那一格是同一个 id 的 key——宿主靠这个 id 把图标和面板对上。
      ctx.slots.inject('sidebar.panellist', () => {
        const offRow = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 2,
            label: () => t('nav'),
            locale: NAMESPACE,
            inject: () => ({ t }),
          },
          Icon,
        );
        const offPanel = ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NAMESPACE, inject: () => ({ t }) },
          Panel,
        );
        return () => {
          if (typeof offPanel === 'function') offPanel();
          if (typeof offRow === 'function') offRow();
        };
      });
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
