// 采集编排：目录段 → curated → 头部详情/审计 → buildCatalog。
//
// 这个文件被两处复用：
//   1. collector/run.mjs（CLI，本地/能力测试，可 --replay）
//   2. api/collect.js（Vercel 函数，cron 触发）
// 所以它不许有命令行/文件系统副作用：输入是 fetchImpl，输出是一份 catalog 对象 + 一份诚实的统计。
//
// 预算（Vercel Hobby 硬约束）：函数上限 60s，客户端限流 100ms/次 → 一次最多约 400–500 个上游请求。
// 目录段只要 ceil(total/500) 个请求（8420 条约 17 个），贵的是详情段：每个目标 2 个请求。
// 因此：先生成「候选 enrich 目标」的完整清单，再按剩余请求预算与剩余时间裁掉尾巴，
// 并把裁掉了多少写进 stats（truncated / truncated_reason），绝不让超时表现为「静默少了几百条」。

import { createClient, PER_PAGE } from './fetch.mjs';
import { buildCatalog, normalizeRecord, parseFrontmatter, ENRICH_VERSION } from './pipeline.mjs';

/** 默认值按 Hobby 安全值给：Pro（300s）用环境变量放开即可。 */
export const DEFAULTS = Object.freeze({
  view: 'all-time',
  // 目录规模：93043 条全量要 187 页（每页固定约 7s，与服务端查询成本绑定），一次跑不完。
  // 所以默认只收「按安装量降序的前 3000 条」（6 页）+ 全部 curated。要更宽就调这个数。
  limitRecords: 3000,
  listConcurrency: 6,
  enrich: 600, // 预算内最多给多少个「预聚类后的头部 + curated」抓详情（继承上一版的已抓项）
  concurrency: 8, // 详情/审计的并发；实测 8 路无 429，每个约 0.3–0.6s
  maxRequests: 1500, // 上游请求总数闸门（目录 6 + curated 1 + 详情/审计 1200 + 余量）
  maxRuntimeMs: 250000, // 采集段的时间闸门；函数上限 300s，留 ~50s 给上传与响应
  fetchTrend: true, // 每个目标多 1 个请求去抓页面 HTML，换「8 周趋势」这一维
});

const isoStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

/** 预聚类：详情还没抓，先用 slug|name 归并同名技能，避免 fork 挤占头部名额。 */
export function preCluster(records) {
  const byKey = new Map();
  for (const rec of records) {
    const key = `${rec.slug}|${(rec.name || '').toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rec);
  }
  const clusters = [...byKey.values()].map((members) => {
    members.sort((a, b) => b.installs - a.installs || a.id.localeCompare(b.id));
    return { lead: members[0], members, merged: members.reduce((s, m) => s + m.installs, 0) };
  });
  clusters.sort((a, b) => b.merged - a.merged || a.lead.id.localeCompare(b.lead.id));
  return clusters;
}

/** detail + audit 的返回揉成一条记录；字段名对不上就留空，绝不瞎猜。 */
export function mergeDetail(record, detail, audit, page = null) {
  const files = Array.isArray(detail?.files) ? detail.files : [];
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path || '')) || files[0];
  const body = typeof skillMd?.contents === 'string' ? skillMd.contents : null;
  // detail 没有 description 字段（实测只有 id/source/slug/installs/hash/files），
  // 唯一的说明来源就是 SKILL.md 的 frontmatter。
  const meta = parseFrontmatter(body);
  return {
    ...record,
    // hash 只在这里出现：列表项没有 hash（实测），所以去重的强身份只有抓过 detail 的记录才有
    hash: detail?.hash || record.hash || null,
    // 这一版抓取逻辑的版本号：空描述≠没抓过，只有版本号能区分「抓过但没描述」和「旧逻辑抓的」
    enrich_v: ENRICH_VERSION,
    // 说明的唯一真实来源是 SKILL.md frontmatter（detail 顶层没有 description 字段，实测只有
    // id/source/slug/installs/hash/files）；拿不到就保持 null，不编。
    description: meta?.description || detail?.description || record.description || null,
    bodyLength: body ? body.length : null,
    body_excerpt: body ? body.slice(0, 4000) : null,
    file_count: files.length || null,
    audit: audit?.audits?.length ? audit : record.audit,
    // 趋势只存在于页面 HTML（见 fetch.mjs 的 page()）；detail 里没有这个字段。
    weeklyInstalls: page?.weekly_series || detail?.weeklyInstalls || record.weekly_series || null,
    // 发布时间也来自同一页 HTML 的 First Seen（不加请求）；上游没有「更新时间」这种字段。
    firstSeen: page?.first_seen || detail?.firstSeen || record.first_seen || null,
    curated: Boolean(record.curated),
    official: Boolean(record.official),
  };
}

/** curated 与头部交替取，避免「curated 太多把 top installs 全挤掉」（反之亦然）。 */
function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * 跑一次采集。
 * @returns {Promise<{catalog: object, stats: object}>}
 *   catalog 形状即 data/catalog.json；stats 是给响应体/日志的如实账单（含被截断的原因）。
 */
export async function collect({
  fetchImpl = globalThis.fetch,
  token = null,
  view = DEFAULTS.view,
  limitRecords = DEFAULTS.limitRecords,
  listConcurrency = DEFAULTS.listConcurrency,
  enrich = DEFAULTS.enrich,
  concurrency = DEFAULTS.concurrency,
  maxRequests = DEFAULTS.maxRequests,
  maxRuntimeMs = DEFAULTS.maxRuntimeMs,
  fetchTrend = DEFAULTS.fetchTrend,
  zh = {}, // 中文层：{ [id]: {name_zh, intro, usage, notes} }，由 api/collect.js 注入
  stage = 'all', // 'all' | 'list'
  previous = null, // 上一版目录的 skills[]：抓过 detail/audit 的条目直接继承，不再重复花请求
  refreshEnrich = false, // true = 无视上一版，全部重抓（内容可能变了，但要花满 600 个请求）
  now = Date.now,
  log = () => {},
} = {}) {
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const truncatedReasons = [];

  // 请求计数闸门：预算算错时宁可抛，也不要闷头把额度烧掉
  let requests = 0;
  class BudgetExceeded extends Error {
    constructor() {
      super(`request budget exceeded: >${maxRequests} upstream calls`);
      this.name = 'BudgetExceeded';
    }
  }
  const countedFetch = async (url, init) => {
    requests += 1;
    if (requests > maxRequests) throw new BudgetExceeded();
    return fetchImpl(url, init);
  };

  const client = createClient({ token, fetchImpl: countedFetch });

  // ---- 目录段：按安装量降序取前 limitRecords 条（并发分页，见 client.listPages）----
  const maxPages = Math.max(1, Math.ceil(limitRecords / PER_PAGE));
  let listTotal = null;
  log(`listing ${view} … (≤${maxPages} pages / ${limitRecords} records)`);
  const listed = await client.listPages({
    view,
    maxPages,
    concurrency: listConcurrency,
    onPage: (p) => {
      if (Number.isFinite(p.total)) listTotal = p.total;
      log(`  page ${p.page}: +${p.got} (${p.accumulated}${p.total ? `/${p.total}` : ''})`);
    },
  });
  const listRaw = listed.items;
  const listRequests = client.stats.calls;
  if (listed.failed.length) truncatedReasons.push(`list_pages_failed:${listed.failed.join(',')}`);
  // 「目录只收头部」是产品决策，但必须让下游看得见这个截断，否则会误以为这是全量
  if (Number.isFinite(listTotal) && listRaw.length < listTotal) {
    truncatedReasons.push(`list_cap:${listRaw.length}/${listTotal}`);
  }
  log(`list: ${listRaw.length}/${listTotal ?? '?'} records (${listRequests} requests, ${listed.pages} pages)`);

  // ---- curated：摊平后与列表合并（curated 端点按 owner 分组，client 已摊平）----
  log('fetching curated …');
  const curatedRaw = await client.curated();
  const curatedRequests = client.stats.calls - listRequests;
  log(`curated: ${curatedRaw.length} records (${curatedRequests} request)`);

  const curatedIds = new Set(curatedRaw.map((r) => r.id));
  const records = [];
  const seenIds = new Set();
  for (const raw of [...listRaw, ...curatedRaw]) {
    const rec = normalizeRecord(raw);
    if (!rec || seenIds.has(rec.id)) continue;
    seenIds.add(rec.id);
    if (curatedIds.has(rec.id)) {
      rec.curated = true;
      rec.official = true; // curated 端点 = 官方精选（flattenCurated 已置位，列表项重叠时补上）
    }
    records.push(rec);
  }
  const dupIds = listRaw.length + curatedRaw.length - records.length;

  // ---- 继承上一版的富集结果 ----
  // 详情/审计每个目标 2 个请求，一次 cron 跑不完 300 个；而描述、hash、审计结论变化很慢，
  // 所以「每次 cron 只看新的头部」比「每次全量重抓」现实得多。继承是显式的，命中多少条写进 stats。
  const priors = new Map();
  for (const skill of Array.isArray(previous) ? previous : []) {
    if (skill && typeof skill.id === 'string') priors.set(skill.id, skill);
  }
  let inherited = 0;
  if (!refreshEnrich && priors.size) {
    for (const rec of records) {
      const prev = priors.get(rec.id);
      if (!prev) continue;
      if (!rec.hash && prev.hash) rec.hash = prev.hash;
      if (!rec.description_en && prev.description_en) rec.description_en = prev.description_en;
      if (!rec.audit && prev.audit) rec.audit = prev.audit;
      if (!rec.first_seen && prev.first_seen) rec.first_seen = prev.first_seen;
      if (!rec.weekly_series && Array.isArray(prev.weekly_series)) rec.weekly_series = prev.weekly_series;
      if (rec.trend_pct == null && prev.trend_pct != null) rec.trend_pct = prev.trend_pct;
      if (prev.hash) inherited += 1;
      if (Number.isFinite(prev.enrich_v)) rec.enrich_v = prev.enrich_v;
    }
    log(`inherited ${inherited} enriched records from previous catalog (${priors.size} known ids)`);
  }

  log(`records: ${records.length} normalized (${dupIds} duplicate ids dropped, ${curatedIds.size} curated)`);

  const directoryVersion = `dir-${isoStamp()}`;
  const catalogStage = buildCatalog(records, { version: directoryVersion, generatedAt: new Date().toISOString(), zh });
  log(`directory stage: ${catalogStage.count} entries after dedupe (${catalogStage.deduped} merged)`);

  const baseStats = () => ({
    view,
    stage,
    // 目录只收头部：limit_records 是产品决策，list_total 是上游真实规模，两个都写出来
    limit_records: limitRecords,
    list_total: listTotal,
    list_pages: listed.pages,
    list_failed_pages: listed.failed,
    list_records: listRaw.length,
    inherited_enriched: inherited,
    curated_records: curatedRaw.length,
    records: records.length,
    directory: { count: catalogStage.count, deduped: catalogStage.deduped, raw_count: catalogStage.raw_count },
    requests: { list: listRequests, curated: curatedRequests, enrich: 0, used: requests, max: maxRequests },
    enrich_targets: { desired: 0, selected: 0, completed: 0, failed: 0, skipped_budget: 0, skipped_deadline: 0 },
    max_runtime_ms: maxRuntimeMs,
    elapsed_ms: elapsed(),
    truncated: truncatedReasons.length > 0,
    truncated_reasons: truncatedReasons,
  });

  if (stage === 'list') {
    return { catalog: catalogStage, stats: baseStats() };
  }

  // ---- 详情段：候选清单先算全，再按预算/时间裁尾 ----
  const clusters = preCluster(records);
  const clusterOf = new Map();
  for (const cluster of clusters) for (const member of cluster.members) clusterOf.set(member.id, cluster);

  const curatedRecords = records.filter((r) => r.curated);
  const headRecords = clusters.slice(0, Math.max(0, enrich)).map((c) => c.lead);
  const candidates = [];
  const queued = new Set();
  let alreadyEnriched = 0;
  for (const rec of interleave(curatedRecords, headRecords)) {
    if (queued.has(rec.id)) continue;
    queued.add(rec.id);
    // 上一版已经抓过 detail（有 hash）的就不再花 2 个请求；refreshEnrich 时全部重抓
    // 只有「已经按当前逻辑抓过」的才跳过；旧版本的 hash 不算数
    if (rec.enrich_v === ENRICH_VERSION && !refreshEnrich) {
      alreadyEnriched += 1;
      continue;
    }
    candidates.push(rec);
  }
  if (alreadyEnriched > 0) log(`enrich: ${alreadyEnriched} head targets already enriched → skipped`);

  const remaining = Math.max(0, maxRequests - requests);
  const costPerTarget = fetchTrend ? 3 : 2; // detail + audit（+ 页面 HTML 拿趋势）
  const affordable = Math.floor(remaining / costPerTarget);
  const selected = candidates.slice(0, Math.min(candidates.length, affordable));
  const skippedBudget = candidates.length - selected.length;
  if (skippedBudget > 0) truncatedReasons.push(`enrich_budget:${skippedBudget}`);
  log(
    `enrich: ${selected.length}/${candidates.length} targets → ≤${selected.length * 2} requests ` +
      `(budget ${remaining} left; concurrency ${concurrency}, ~${Math.ceil((selected.length * 2 * 400) / (concurrency * 1000))}s at ~0.4s/call)`,
  );

  const enriched = new Map();
  let failed = 0;
  let skippedDeadline = 0;
  await mapLimitBudget(selected, concurrency, async (rec) => {
    if (elapsed() > maxRuntimeMs) {
      skippedDeadline += 1;
      return; // 到点了就不再发新请求；剩下的保持列表级数据
    }
    // 先 detail 再 audit：detail 是唯一带 hash / 正文的来源，拿不到就没有合并的基础。
    // 反过来 Promise.all 并发发两个请求的话，detail 一 404 立刻 reject，而 audit 那个请求
    // 还在限流的 sleep 里、照样会发出去 —— 白烧一次额度，而且会在 collect() 返回之后才落地，
    // 让 requests.used 在 21/22 之间随机（实测约 1/60 的复现率）。
    const detail = await client.detail(rec.id);
    const audit = await client.audit(rec.id).catch(() => null); // 审计缺数据/404 不该拖垮整个目标
    // 趋势是可选维度：页面抓失败（改版/限流）就当没有，不影响这条记录落地
    const page = fetchTrend ? await client.page(rec.id).catch(() => null) : null;
    enriched.set(rec.id, mergeDetail(rec, detail, audit, page));
  }, () => (failed += 1));
  if (skippedDeadline > 0) truncatedReasons.push(`enrich_deadline:${skippedDeadline}`);

  // hash 回填：预聚类里同一个 lead 抓到 hash 后，同簇成员（没抓过 detail 的 fork）继承它，
  // 否则 dedupe 会把「有 hash 的 lead」和「没 hash 的 fork」拆成两条，installs_merged 直接丢。
  for (const [id, rec] of enriched) {
    if (!rec?.hash) continue;
    const cluster = clusterOf.get(id);
    if (!cluster) continue;
    for (const member of cluster.members) if (!member.hash) member.hash = rec.hash;
  }

  log(
    `enrich done: ${enriched.size}/${selected.length} ids (${failed} failed, ${skippedDeadline} skipped on deadline; ` +
      `the rest keep list-level data)`,
  );

  const finalRecords = records.map((rec) => enriched.get(rec.id) || rec);
  const catalog = buildCatalog(finalRecords, {
    zh,
    version: `full-${isoStamp()}`,
    generatedAt: new Date().toISOString(),
  });

  const stats = {
    ...baseStats(),
    requests: { list: listRequests, curated: curatedRequests, enrich: requests - listRequests - curatedRequests, used: requests, max: maxRequests },
    enrich_targets: {
      desired: candidates.length,
      already_enriched: alreadyEnriched,
      selected: selected.length,
      completed: enriched.size,
      failed,
      skipped_budget: skippedBudget,
      skipped_deadline: skippedDeadline,
    },
    // 只对账不判定：正文覆盖了多少条，是判断「头部是否真的做完了」的唯一实测口径
    with_body: finalRecords.filter((r) => r.bodyLength).length,
    with_hash: finalRecords.filter((r) => r.hash).length,
    with_audit: finalRecords.filter((r) => r.audit).length,
    // 趋势查得到多少条：这一维只来自页面 HTML，抓不到就是没有（不拿 installs 假装趋势）
    with_trend: finalRecords.filter((r) => r.trend_pct != null).length,
    flagged: catalog.skills.filter((s) => s.flags?.length).length,
    truncated: truncatedReasons.length > 0,
    truncated_reasons: truncatedReasons,
    elapsed_ms: elapsed(),
  };
  log(
    `catalog: ${catalog.count} entries, ${catalog.deduped} merged, ${stats.with_body} with body, ` +
      `${stats.flagged} flagged, ${requests} requests, ${stats.elapsed_ms}ms`,
  );
  return { catalog, stats };
}

/** 带 deadline 的 mapLimit：worker 自己负责「到点就提前返回」，失败计数由 onFail 收集。 */
export async function mapLimitBudget(items, limit, worker, onFail) {
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index], index);
      } catch {
        onFail?.(items[index], index);
      }
    }
  });
  await Promise.all(runners);
  return items;
}
