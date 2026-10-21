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

import { createHash } from 'node:crypto';

import { createClient, PER_PAGE } from './fetch.mjs';
import { buildCatalog, dedupe, normalizeRecord, parseFrontmatter, ENRICH_VERSION, BODY_VERSION } from './pipeline.mjs';

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
  // curated 在候选里只占水位外的小额豁免名额。为什么：curated 有 5527 条、装量中位数只有 49，
  // 和头部 1:1 交替会让每轮预算约一半花在长尾上（实测装量前 2000 名里只有 335 条 curated）。
  curatedQuota: 50,
  // 正文水位的规模：按合并后装量取前 N 条，看这批的正文覆盖率（见 bodyGateStats）
  bodyWaterline: 2000,
  // 收录过滤的开关：null = 按 body_gate 自动（覆盖率 ≥ 95% 才开），true/false = 强制覆盖。
  // 默认自动且现在一定算 false：只有 480/7821 条有正文，强制开会让目录先掉到 480 条。
  requireBody: null,
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
    // 正文全文的 sha256：正文按这个指纹落 Blob（本地不能现抓 detail，只能消费已落盘的正文），
    // 也是「内容变没变」的判据。拿不到正文就给 null，不编。
    body_sha256: body ? createHash('sha256').update(body).digest('hex') : null,
    body_excerpt: body ? body.slice(0, 4000) : null,
    // 正文全文只活到「上传 Blob」为止：目录里只留 length/sha256/v，全文一个字节都不进 catalog。
    body_text: body || null,
    // 正文入库版本：抓到了才算这一版抓的（上传失败时会被清掉，下一轮重抓）
    body_v: body ? BODY_VERSION : null,
    file_count: files.length || null,
    audit: audit?.audits?.length ? audit : record.audit,
    // 趋势只存在于页面 HTML（见 fetch.mjs 的 page()）；detail 里没有这个字段。
    weeklyInstalls: page?.weekly_series || detail?.weeklyInstalls || record.weekly_series || null,
    // 发布时间也来自同一页 HTML 的 First Seen（不加请求）；上游没有「更新时间」这种字段。
    firstSeen: page?.first_seen || detail?.firstSeen || record.first_seen || null,
    // GitHub Stars 同样来自技能页（仓库级指标，同一仓库的技能共用这个数）
    stars: page?.stars ?? detail?.stars ?? record.stars ?? null,
    curated: Boolean(record.curated),
    official: Boolean(record.official),
  };
}

/** curated 与头部交替取，避免「curated 太多把 top installs 全挤掉」（反之亦然）。
 * 候选顺序改成「头部优先 + curated 小额豁免」后暂无调用方，先留着，要回退时能直接换回去。 */
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
 * 正文水位门禁：按「合并后装量」（installs_merged ?? installs）降序取前 waterline 条，
 * 数其中有多少条已经有正文（body_length 与 body_sha256 都在才算），覆盖率 ≥ 95% 记为 strict。
 * 为什么按合并后装量：收录水位是按装量定的，门禁必须量同一批记录，否则 fork 会把头部名额算错。
 */
export function bodyGateStats(records, waterline = 2000) {
  const limit = Math.max(0, Math.floor(Number(waterline) || 0));
  const merged = dedupe(records.map(normalizeRecord).filter(Boolean));
  const ranked = [...merged].sort(
    (a, b) => (b.installs_merged ?? b.installs) - (a.installs_merged ?? a.installs) || a.id.localeCompare(b.id),
  );
  const head = ranked.slice(0, limit);
  const headWithBody = head.filter((r) => r.body_length && r.body_sha256).length;
  // 严格模式看的是「正文已入库」（body_v 有值 = 抓过、也传过 Blob）。只看 length/sha256 会把
  // 「抓完就把正文丢掉」的旧记录算成已覆盖，于是在一半正文根本不存在的目录上开了严格过滤。
  const headStored = head.filter((r) => r.body_length && r.body_sha256 && r.body_v).length;
  const coverage = head.length ? Math.round((headStored / head.length) * 1000) / 1000 : 0;
  return {
    waterline: limit,
    head_total: head.length,
    head_with_body: headWithBody,
    head_stored: headStored,
    coverage,
    strict: coverage >= 0.95,
  };
}

/** 收录过滤的开关：null = 按门禁自动，true/false = 强制。 */
function resolveRequireBody(option, gate) {
  if (option === true || option === false) return option;
  return gate.strict;
}

/** 覆盖率账本：每条口径各有多少条，dropped_* 直接来自 buildCatalog 的 dropped。 */
export function coverageStats(records, catalog) {
  const rows = Array.isArray(records) ? records : [];
  const count = (fn) => rows.filter(fn).length;
  const dropped = catalog?.dropped || { no_body: 0, thin_body: 0, no_description: 0 };
  return {
    // 记录可能还没归一化（bodyLength）也可能已经归一化（body_length），两个形状都要认
    with_body: count((r) => r.body_length ?? r.bodyLength),
    with_body_sha256: count((r) => r.body_sha256),
    with_body_stored: count((r) => r.body_v),
    with_hash: count((r) => r.hash),
    with_audit: count((r) => r.audit),
    with_trend: count((r) => r.trend_pct != null),
    flagged: (catalog?.skills || []).filter((s) => s.flags?.length).length,
    dropped_no_body: dropped.no_body,
    dropped_thin_body: dropped.thin_body,
    dropped_no_description: dropped.no_description,
  };
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
  curatedQuota = DEFAULTS.curatedQuota, // curated 在水位外最多豁免多少条（不与头部重复）
  bodyWaterline = DEFAULTS.bodyWaterline, // 门禁量的是「装量前多少条」
  requireBody = DEFAULTS.requireBody, // null = 自动（按门禁），true/false 强制
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
      // 正文元数据也要继承：enrich_v 已是最新版的条目整轮不碰 detail，只能从上一版目录补数据。
      // 不继承的话下一轮 buildCatalog 会以为它们没有正文：门禁算不出来，目录里的 body 会凭空消失。
      if (rec.body_length == null && Number.isFinite(prev.body?.length)) rec.body_length = prev.body.length;
      if (!rec.body_sha256 && prev.body?.sha256) rec.body_sha256 = prev.body.sha256;
      // 入库版本也要继承：不然上一轮已经传过 Blob 的正文，这一轮会被当成没入库而重抓一遍
      if (Number.isFinite(prev.body?.v)) rec.body_v = prev.body.v;
      if (prev.hash) inherited += 1;
      if (Number.isFinite(prev.enrich_v)) rec.enrich_v = prev.enrich_v;
    }
    log(`inherited ${inherited} enriched records from previous catalog (${priors.size} known ids)`);
  }

  log(`records: ${records.length} normalized (${dupIds} duplicate ids dropped, ${curatedIds.size} curated)`);

  // 正文水位门禁先按目录段算一份（detail 还没抓）：stage=list 直接返回这份目录，门禁必须能约束它。
  const directoryGate = bodyGateStats(records, bodyWaterline);
  const directoryStrict = resolveRequireBody(requireBody, directoryGate);
  log(
    `body gate (directory): ${directoryGate.head_with_body}/${directoryGate.head_total} of the top ` +
      `${directoryGate.waterline} have body (coverage ${directoryGate.coverage}) → requireBody ${directoryStrict ? 'on' : 'off'}`,
  );

  const directoryVersion = `dir-${isoStamp()}`;
  const catalogStage = buildCatalog(records, {
    version: directoryVersion,
    generatedAt: new Date().toISOString(),
    zh,
    requireBody: directoryStrict,
  });
  log(`directory stage: ${catalogStage.count} entries after dedupe (${catalogStage.deduped} merged)`);
  if (directoryStrict) log(`directory stage dropped ${JSON.stringify(catalogStage.dropped)}`);

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
    // 覆盖率与门禁：stage=list 时这是目录段的实测值；stage=all 会在最终 stats 里按富集后的结果重算覆盖
    coverage: coverageStats(records, catalogStage),
    body_gate: directoryGate,
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

  // 候选顺序：装量降序的头部优先（preCluster 已经排好），curated 只作为水位外的小额豁免。
  // 为什么不再 interleave：curated 有 5527 条、装量中位数只有 49，1:1 交替会让每轮预算的一半
  // 花在长尾上（实测装量前 2000 名里只有 792 条抓过 detail，另一半预算基本白花）。
  const curatedRecords = records.filter((r) => r.curated);
  const headQuota = Math.max(0, enrich - curatedQuota);
  // 候选不是「前 headQuota 个簇」，而是「沿着装量顺序凑够 headQuota 个真正要抓的」：
  // 前排的熟面孔不能一直占名额，否则富集视野永远停在同一个排名上。
  const candidates = [];
  const queued = new Set();
  let alreadyEnriched = 0;
  const queue = (rec) => {
    if (!rec || queued.has(rec.id)) return false;
    queued.add(rec.id);
    // 跳过要同时满足两件：抓过 detail（enrich_v）且正文已入库（body_v >= BODY_VERSION）。
    // 只看 enrich_v 会让「抓完就把正文丢了」的记录永远不再抓，覆盖率再也涨不上去。
    const fresh = rec.enrich_v === ENRICH_VERSION && Number(rec.body_v) >= BODY_VERSION;
    if (fresh && !refreshEnrich) {
      alreadyEnriched += 1;
      return false;
    }
    candidates.push(rec);
    return true;
  };
  for (const cluster of clusters) {
    if (candidates.length >= headQuota) break;
    queue(cluster.lead);
  }
  // curated 豁免：已在头部里的不重复占名额，最多再补 curatedQuota 条
  let curatedExtra = 0;
  for (const rec of curatedRecords) {
    if (curatedExtra >= curatedQuota) break;
    if (queue(rec)) curatedExtra += 1;


  }
  if (alreadyEnriched > 0) log(`enrich: ${alreadyEnriched} head targets already enriched → skipped`);

  const remaining = Math.max(0, maxRequests - requests);
  const costPerTarget = fetchTrend ? 3 : 2; // detail + audit（+ 页面 HTML 拿趋势）
  const affordable = Math.floor(remaining / costPerTarget);
  const selected = candidates.slice(0, Math.min(candidates.length, affordable));
  const skippedBudget = candidates.length - selected.length;
  if (skippedBudget > 0) truncatedReasons.push(`enrich_budget:${skippedBudget}`);
  log(
    `enrich: ${selected.length}/${candidates.length} targets → ≤${selected.length * costPerTarget} requests ` +
      `(budget ${remaining} left; concurrency ${concurrency}, ` +
      `~${Math.ceil((selected.length * costPerTarget * 400) / (concurrency * 1000))}s at ~0.4s/call)`,
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

  // 正文全文在这里集中一次：键是 sha256（内容指纹，同一份正文只留一份、只传一次）。
  // 收完立刻把 body_text 从记录上摘掉——目录里只能有 length/sha256/v，全文一个字节都不进 catalog。
  const bodies = new Map();
  for (const rec of finalRecords) {
    if (typeof rec?.body_text === 'string' && rec.body_sha256) bodies.set(rec.body_sha256, rec.body_text);
    if (rec) delete rec.body_text;
  }
  log(`bodies: ${bodies.size} distinct texts collected for upload`);
  // 门禁在富集之后再算一次：这才是「这一轮抓完以后水位内正文覆盖了多少」的实测口径。
  // strict 为真才给 buildCatalog 传 requireBody=true（requireBody 选项可强制覆盖）。
  const bodyGate = bodyGateStats(finalRecords, bodyWaterline);
  const strictFilter = resolveRequireBody(requireBody, bodyGate);
  log(
    `body gate: ${bodyGate.head_stored}/${bodyGate.head_total} of the top ${bodyGate.waterline} have body stored ` +
      `(${bodyGate.head_with_body} fetched; coverage ${bodyGate.coverage}) → requireBody ${strictFilter ? 'on' : 'off'}`,
  );
  const catalog = buildCatalog(finalRecords, {
    zh,
    version: `full-${isoStamp()}`,
    generatedAt: new Date().toISOString(),
    requireBody: strictFilter,
  });
  if (strictFilter) log(`requireBody dropped ${JSON.stringify(catalog.dropped)}`);
  const coverage = coverageStats(finalRecords, catalog);

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
    // 只对账不判定：正文覆盖了多少条，是判断「头部是否真的做完了」的唯一实测口径。
    // 平铺的 with_* 保留给 api/collect.js 与 run.mjs 的旧消费方，新口径统一进 coverage。
    with_body: coverage.with_body,
    with_body_sha256: coverage.with_body_sha256,
    with_body_stored: coverage.with_body_stored,
    with_hash: coverage.with_hash,
    with_audit: coverage.with_audit,
    // 趋势查得到多少条：这一维只来自页面 HTML，抓不到就是没有（不拿 installs 假装趋势）
    with_trend: coverage.with_trend,
    flagged: coverage.flagged,
    // 收录过滤的账单：dropped_no_body / dropped_thin_body / dropped_no_description（关闭时全 0）
    coverage,
    body_gate: bodyGate,
    truncated: truncatedReasons.length > 0,
    truncated_reasons: truncatedReasons,
    elapsed_ms: elapsed(),
  };
  log(
    `catalog: ${catalog.count} entries, ${catalog.deduped} merged, ${stats.with_body} with body, ` +
      `${stats.flagged} flagged, ${requests} requests, ${stats.elapsed_ms}ms`,
  );
  return { catalog, stats, bodies };
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
