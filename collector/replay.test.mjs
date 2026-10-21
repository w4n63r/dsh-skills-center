// --replay 端到端测试：fixture → collect() → catalog，走的是 api/collect.js 同一个编排函数。
//
// 断言只写「实测过的事实」和「错了会真出事」的约束：
//   1) ai-video-generation 六个 fork 必须并成 1 条，installs_merged = 2917414
//   2) hash 只能来自 detail（列表项没有 hash）；没有 detail 的记录不许凭空长出 hash
//   3) audit 的 fail 必须留在分母里（3 条里 1 条 fail → A = 2/3，不是 1.0）
//   4) 分页 0 起始、看 hasMore；只发 Authorization，不发 x-vercel-oidc-token
//   5) 预算闸门真的会截断，并且如实报告（truncated / skipped_budget / skipped_deadline）
//   6) 聚类键（slug|name）只用来排顺序、不是身份：簇首已入库时，同簇其它成员仍要抓 detail
import assert from 'node:assert/strict';
import { loadReplayFixture } from './replay.mjs';
import { collect } from './collect.mjs';
import { validateCatalog } from './publish.mjs';
import { ENRICH_VERSION } from './pipeline.mjs';

const FIXTURE = new URL('./fixtures/v1-sample.json', import.meta.url);
const TOKEN = 'replay-test-jwt';
const quiet = { log: () => {} };

// ---- 全链路 ----
const { fetchImpl, fixture } = await loadReplayFixture(FIXTURE);
const { catalog, stats, bodies } = await collect({ fetchImpl, token: TOKEN, ...quiet });

assert.equal(catalog.count, catalog.skills.length, 'count must match skills.length');
assert.equal(catalog.raw_count, 14, '6 own list + 1 curated-only = 14 normalized records');
assert.equal(catalog.deduped, 5, 'the six ai-video forks must collapse (6 → 1)');
assert.ok(catalog.version.startsWith('full-'), catalog.version);
assert.ok(Date.parse(catalog.generated_at) > 0);
assert.deepEqual(validateCatalog(catalog).errors, [], 'replay catalog must pass the pre-upload schema check');

// ---- 1) 六个 fork 合并成 1 条 ----
const forks = fixture.list.filter((s) => s.slug === 'ai-video-generation');
assert.equal(forks.length, 6, 'fixture must carry all six fork ids');
const aiVideo = catalog.skills.filter((s) => s.slug === 'ai-video-generation');
assert.equal(aiVideo.length, 1, 'six forks must collapse into exactly one catalog entry');
assert.equal(aiVideo[0].id, '101-skills/superpowers/ai-video-generation', 'canonical = highest installs');
assert.equal(aiVideo[0].installs, 801414, 'scoring uses the canonical id only');
assert.equal(aiVideo[0].installs_merged, 2917414, '801414+642000+484000+339000+333000+318000');
assert.equal(aiVideo[0].aliases.length, 5);
assert.equal(aiVideo[0].trend_pct, 76.1, 'trend comes from detail.weeklyInstalls (76.1% real measurement)');

// ---- 2) hash 只从 detail 取 ----
assert.ok(aiVideo[0].hash, 'the enriched lead has the detail hash');
const noDetail = catalog.skills.find((s) => s.id === 'larksuite/cli/lark-drive');
assert.ok(noDetail, 'a 404 on detail must not drop the record');
assert.equal(noDetail.hash, undefined, 'list-only records never invent a hash');
assert.equal(noDetail.trend_pct, null, 'no detail → no weekly series → null trend, not 0');
assert.equal(noDetail.score.A, 0.5, 'no audit data stays neutral 0.5');
assert.deepEqual(noDetail.flags, [], 'no body → no body-based flags');
assert.equal(
  stats.enrich_targets.failed,
  6,
  'fixture 只给 6 个 ai-video fork 里的簇首配了 detail，其余 5 个 + lark-drive 共 6 个 404',
);
assert.equal(stats.enrich_targets.completed, 8);
assert.equal(stats.with_body, 8, 'only enriched targets have a body');
assert.equal(stats.with_hash, 13, '8 enriched + 5 forks that inherited the cluster hash');

// ---- 2b) detail 是唯一有描述的地方；normalizeRecord 跑两遍不许把它洗掉 ----
const enriched = catalog.skills.filter((s) => s.description_en);
assert.equal(enriched.length, 8, 'the 8 successfully enriched records carry detail.description');
assert.match(
  catalog.skills.find((s) => s.slug === 'grill-me').description_en,
  /forwarding shell/i,
  'detail.description must survive both normalize passes',
);
assert.equal(noDetail.description_en, undefined, 'list-only record never invents a description');
assert.ok(
  catalog.skills.every((s) => s.source_kind === 'github' && s.kind === 'github'),
  'list items say sourceType (camelCase); source_kind/kind must survive the second normalize pass',
);

// ---- 3) audit：fail 计入分母；riskLevel "SAFE" 不影响解析 ----
const grill = catalog.skills.find((s) => s.slug === 'grill-me');
assert.equal(Math.round(grill.score.A * 10000) / 10000, 0.6667, '2 pass + 1 fail = 0.6667, not 1.0');
assert.ok(grill.flags.includes('pointer'), 'forwarding shell flagged');
assert.ok(grill.flags.includes('thin_body'));
const prisma = catalog.skills.find((s) => s.slug === 'prisma-postgres');
assert.equal(prisma.score.A, 0, 'a single fail audit is 0 pass / 1 judged');
assert.ok(prisma.flags.includes('deprecated'));
assert.equal(aiVideo[0].audit.audits.length, 5, 'all five provider rows are kept');
assert.ok(
  aiVideo[0].audit.audits.some((a) => a.riskLevel === 'SAFE'),
  'the undocumented "SAFE" riskLevel must survive unchanged',
);

// ---- 4) 分页与鉴权头（把收到的请求原样查一遍）----
const listCalls = fetchImpl.calls.filter((c) => c.url.includes('/api/v1/skills?'));
assert.equal(listCalls.length, 3, '13 records at pageSize 5 = 3 pages, and no fourth request');
assert.ok(listCalls[0].url.includes('page=0'), 'first page request must be page=0');
// 分页之间是并发的（每页约 7s，不并发跑不完），所以只能断言「页码集合」，不能断言到达顺序
const listPages = listCalls.map((c) => new URL(c.url).searchParams.get('page')).sort();
assert.deepEqual(listPages, ['0', '1', '2'], 'pages 0..2, each exactly once');
assert.ok(
  fetchImpl.calls.every((c) => c.headers['x-vercel-oidc-token'] === undefined),
  'must never send x-vercel-oidc-token upstream (401s in production)',
);
// 页面 HTML（www.skills.sh）是公开的，不该带 token；/api/v1 的每个请求都必须带。
const apiCalls = fetchImpl.calls.filter((c) => !c.url.includes('www.skills.sh'));
assert.ok(
  apiCalls.length > 0 && apiCalls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`),
  'every /api/v1 request carries Authorization: Bearer',
);
assert.ok(
  fetchImpl.calls.filter((c) => c.url.includes('www.skills.sh')).every((c) => c.headers.Authorization === undefined),
  'never leak the upstream token to the public HTML site',
);
const curatedCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/api/v1/skills/curated'));
assert.equal(curatedCalls.length, 1, 'curated is a single request (it is owner-grouped, not paginated)');
assert.equal(stats.records, 14, 'curated-only skills are unioned into the record set');
const writingDocs = catalog.skills.find((s) => s.slug === 'writing-docs');
assert.ok(writingDocs?.curated, 'a skill that only exists in the curated endpoint still lands in the catalog');
assert.equal(writingDocs.score.C, 1);

// ---- 排序：目录必须按 S 降序（插件 UI 的前提）----
const scores = catalog.skills.map((s) => s.score.S);
assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

// ---- 5) 预算闸门：请求不够时截断并诚实上报 ----
const tight = await loadReplayFixture(FIXTURE);
const budgeted = await collect({ fetchImpl: tight.fetchImpl, token: TOKEN, maxRequests: 8, ...quiet });
assert.ok(budgeted.stats.requests.used <= 8, `used ${budgeted.stats.requests.used} must stay within budget 8`);
// 每个目标现在要 3 个请求（detail + audit + 页面 HTML 拿趋势），所以 4 个剩余额度只能覆盖 1 个
assert.equal(budgeted.stats.enrich_targets.selected, 1, '3 list + 1 curated leaves 4 calls = 1 target at 3 calls each');
assert.ok(budgeted.stats.enrich_targets.skipped_budget > 0);
assert.equal(budgeted.stats.truncated, true);
assert.ok(budgeted.stats.truncated_reasons.some((r) => r.startsWith('enrich_budget:')), budgeted.stats.truncated_reasons.join());
assert.equal(budgeted.catalog.count, 9, 'truncation must not drop records — it only leaves them list-level');
assert.equal(budgeted.stats.with_body, 1);

// ---- 5b) 时间闸门：到点后不再发新请求 ----
const deadlined = await collect({ fetchImpl: (await loadReplayFixture(FIXTURE)).fetchImpl, token: TOKEN, maxRuntimeMs: -1, ...quiet });
assert.equal(deadlined.stats.requests.enrich, 0, 'a blown deadline must not spend a single enrich request');
assert.equal(deadlined.stats.enrich_targets.skipped_deadline, 14, '14 个候选目标（簇里每个成员都算，不只簇首）一个都没抓');
assert.ok(deadlined.stats.truncated_reasons.some((r) => r.startsWith('enrich_deadline:')));

// ---- 目录段单独跑：17 个请求就能出全量目录，任何套餐都跑得完 ----
const listOnly = await collect({ fetchImpl: (await loadReplayFixture(FIXTURE)).fetchImpl, token: TOKEN, stage: 'list', ...quiet });
assert.ok(listOnly.catalog.version.startsWith('dir-'), listOnly.catalog.version);
assert.equal(listOnly.catalog.count, 9);
assert.equal(listOnly.stats.requests.enrich, 0, 'list stage never touches detail/audit');
assert.deepEqual(validateCatalog(listOnly.catalog).errors, [], 'list-only catalog must also pass the schema gate');

// ---- 6) stage 2：正文全文必须交得出来，但一个字节都不许进目录 ----
assert.ok(bodies instanceof Map, 'collect() must hand back the body texts for upload');
assert.equal(bodies.size, 8, 'one distinct text per successfully enriched target');
for (const [sha, text] of bodies) {
  assert.match(sha, /^[0-9a-f]{64}$/, 'body keys are sha256 fingerprints');
  assert.ok(typeof text === 'string' && text.length > 0, 'a body text must never be empty');
}
const withBody = catalog.skills.filter((s) => s.body);
assert.equal(withBody.length, 8, 'every enriched target carries body metadata');
assert.ok(
  withBody.every((s) => s.body.length > 0 && /^[0-9a-f]{64}$/.test(s.body.sha256)),
  'body = {length, sha256}',
);
assert.ok(withBody.every((s) => s.body.v === 1), 'body.v is the “this text is in the blob” stamp');
assert.ok(
  [...new Set(withBody.map((s) => s.body.sha256))].every((k) => bodies.has(k)),
  'every fingerprint in the catalog must have its text in bodies',
);
assert.equal(JSON.stringify(catalog).includes('body_text'), false, 'the full text must never leak into the catalog');

// ---- 7) 富集视野要往前走，而且整簇成员都要抓到 ----
// 聚类键（slug|name）只用来排顺序，不是身份：fixture 里 6 个 fork 同名同 slug、装量不同，
// 只抓簇首的话其余 5 个永远 enrich_v=null——既拿不到正文（收录标准要它），也拿不到自己的 hash。
const second = await loadReplayFixture(FIXTURE);
const stored = [
  {
    id: '101-skills/superpowers/ai-video-generation',
    slug: 'ai-video-generation',
    installs: 801414,
    description: 'already stored',
    enrich_v: ENRICH_VERSION,
    body: { length: 4096, sha256: 'b'.repeat(64), v: 1 },
  },
];
const advanced = await collect({ fetchImpl: second.fetchImpl, token: TOKEN, previous: stored, ...quiet });
const urls = second.fetchImpl.calls.map((c) => c.url);
assert.equal(
  urls.filter((u) => u.includes('101-skills/superpowers/ai-video-generation')).length,
  0,
  'a head record whose body is already stored must not be re-fetched at all',
);
assert.ok(
  urls.some((u) => u.includes('magentosh/superpowers/ai-video-generation')),
  'the other forks of the same cluster must still be fetched: slug|name orders clusters, it is not an identity',
);
assert.equal(advanced.stats.enrich_targets.already_enriched, 1, 'the stored head record counts as already enriched');
assert.ok(advanced.stats.enrich_targets.desired > 0, 'the frontier must move on to the next clusters');
const inherited = advanced.catalog.skills.find((s) => s.id === '101-skills/superpowers/ai-video-generation');
assert.ok(inherited, 'the stored record must stay in the catalog');
assert.equal(inherited.body.sha256, 'b'.repeat(64), 'the stored fingerprint is inherited instead of re-fetched');
assert.equal(inherited.body.v, 1, 'the stored stamp survives into the next catalog');
assert.equal(inherited.body.length, 4096);

console.log(
  `replay ok — ${catalog.count} entries from ${catalog.raw_count} records (${catalog.deduped} merged), ` +
    `${stats.requests.used} requests, forks 6→1 installs_merged=${aiVideo[0].installs_merged}, ` +
    `budget gate trims ${budgeted.stats.enrich_targets.skipped_budget} targets at maxRequests=8`,
);
