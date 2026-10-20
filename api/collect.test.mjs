// api/collect.js 的接线测试（不联网、不需要 Vercel）：鉴权、CRON_SECRET 缺失、OIDC 取不到时的失败形状。
// 这一层的 bug 后果最重——端点一旦不限人，谁都能触发一次烧额度的采集。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GET, POST, isAuthorized, makeHandler, resolveOidcToken } from './collect.js';

const SECRET = 'cron-secret-for-tests';
const called = (url, headers = {}) => new Request(url, { headers });

// ---- 常量时间比较的包装：只认 Authorization: Bearer 或 x-cron-secret ----
assert.equal(isAuthorized(called('https://x/api/collect', { authorization: `Bearer ${SECRET}` }), SECRET), true);
assert.equal(isAuthorized(called('https://x/api/collect', { authorization: `bearer ${SECRET}` }), SECRET), true, 'scheme is case-insensitive');
assert.equal(isAuthorized(called('https://x/api/collect', { 'x-cron-secret': SECRET }), SECRET), true);
assert.equal(isAuthorized(called('https://x/api/collect', { authorization: 'Bearer nope' }), SECRET), false);
assert.equal(isAuthorized(called('https://x/api/collect', {}), SECRET), false);
assert.equal(
  isAuthorized(called('https://x/api/collect', { authorization: `Bearer ${SECRET}-longer` }), SECRET),
  false,
  'a longer secret must not pass the length check',
);

// ---- OIDC token 只从 Request 头取（handler 内）----
const withHeader = await resolveOidcToken(called('https://x/api/collect', { 'x-vercel-oidc-token': 'jwt-abc' }));
assert.equal(withHeader.token, 'jwt-abc');
assert.equal(withHeader.source, 'x-vercel-oidc-token header');

// 没头时才会走 @vercel/oidc。本机装了 @vercel/oidc 且 .env 里有 dev token 时它会真的取到值，
// 所以这里不赌「一定 null」，只赌「要么拿到 token，要么老实说明为什么没有」——两种都是合法结果。
// 注入一个「本机没有 token」的 getter，才是真的在测失败分支（本机缓存了 dev token 时它反而会取到值）
const withoutHeader = await resolveOidcToken(called('https://x/api/collect', {}), {
  getToken: async () => {
    throw new Error('no cached token');
  },
});
if (withoutHeader.token) {
  assert.equal(withoutHeader.source, '@vercel/oidc getVercelOidcToken()');
} else {
  assert.ok(withoutHeader.why, 'must explain why the token is missing');
}

// ---- CRON_SECRET 没配 → 503，且拒绝执行（不是 401，这是配置问题）----
const previous = process.env.CRON_SECRET;
delete process.env.CRON_SECRET;
const unconfigured = await GET(called('https://x/api/collect', {}));
assert.equal(unconfigured.status, 503);
const unconfiguredBody = await unconfigured.json();
assert.equal(unconfiguredBody.ok, false);
assert.equal(unconfiguredBody.stage, 'config');
assert.ok(unconfiguredBody.fix.includes('CRON_SECRET'));

// ---- secret 配了但请求没带/带错 → 401，且不回显 secret ----
process.env.CRON_SECRET = SECRET;
const anonymous = await GET(called('https://x/api/collect', {}));
assert.equal(anonymous.status, 401);
const anonymousBody = await anonymous.json();
assert.equal(anonymousBody.stage, 'auth');
assert.equal(JSON.stringify(anonymousBody).includes(SECRET), false, 'never echo the secret');

const wrong = await POST(called('https://x/api/collect', { authorization: 'Bearer wrong' }));
assert.equal(wrong.status, 401);

// ---- 过了鉴权但拿不到 OIDC token → 500 + stage=token + 明确的修复指引 ----
// 用 makeHandler 注桩：本机缓存着 dev token，不注桩这条分支永远走不到
const noTokenHandler = makeHandler({
  resolveToken: async () => ({ token: null, source: null, why: 'test: no token available' }),
});
const noToken = await noTokenHandler.GET(called('https://x/api/collect', { authorization: `Bearer ${SECRET}` }));
assert.equal(noToken.status, 500);
const noTokenBody = await noToken.json();
assert.equal(noTokenBody.ok, false);
assert.equal(noTokenBody.stage, 'token');
assert.ok(/OIDC/i.test(noTokenBody.fix), noTokenBody.fix);
assert.ok(Number.isFinite(noTokenBody.elapsed_ms), 'failures always report elapsed_ms');
assert.equal(noTokenBody.trigger, 'cron-or-manual-get');

process.env.CRON_SECRET = previous;

// ---- 全链路：带 x-vercel-oidc-token 时 handler 真的跑到采集/schema/上传 ----
// 用 --replay 的假 fetch 顶掉 globalThis.fetch，验的是「接线」而不是网络：
//   ?dry=1 → 200 + 统计；不带 dry → 必须在 upload 阶段大声失败（本机没装 @vercel/blob）
const { loadReplayFixture } = await import('../collector/replay.mjs');
const replay = await loadReplayFixture(new URL('../collector/fixtures/v1-sample.json', import.meta.url));
const realFetch = globalThis.fetch;
const realLog = console.log;
process.env.CRON_SECRET = SECRET;
globalThis.fetch = replay.fetchImpl;
console.log = () => {};

const dry = await GET(called('https://x/api/collect?dry=1', { authorization: `Bearer ${SECRET}`, 'x-vercel-oidc-token': 'jwt-abc' }));
const dryBody = await dry.json();
const failBlob = makeHandler({
  resolveToken: async () => ({ token: 'jwt-abc', source: 'x-vercel-oidc-token header' }),
  loadBlob: async () => {
    throw new Error('test: @vercel/blob is not installed');
  },
});
const forReal = await failBlob.GET(called('https://x/api/collect', { authorization: `Bearer ${SECRET}` }));
const forRealBody = await forReal.json();

globalThis.fetch = realFetch;
console.log = realLog;
process.env.CRON_SECRET = previous;

assert.equal(dry.status, 200, `dry run must succeed: ${JSON.stringify(dryBody).slice(0, 300)}`);
assert.equal(dryBody.ok, true);
assert.equal(dryBody.dry_run, true);
assert.equal(dryBody.uploaded, null);
assert.equal(dryBody.oidc_token_source, 'x-vercel-oidc-token header');
assert.equal(dryBody.count, 9, 'the handler really ran collect() over the fixture');
assert.equal(dryBody.raw_count, 14);
assert.equal(dryBody.deduped, 5);
assert.equal(dryBody.requests.used, 21);
assert.equal(dryBody.requests.max, 1500, 'default request budget covers 6 list pages + 600 enrich targets');
assert.equal(dryBody.limit_records, 3000, 'the catalog is capped at the top 3000 by installs by default');
assert.equal(dryBody.list_total, 13, 'pagination.total from the fixture is surfaced, not hidden');
assert.ok(dryBody.previous, 'the response must report what happened when reading the previous catalog');
assert.equal(dryBody.previous.count, 0);
assert.equal(dryBody.inherited_enriched, 0);
assert.equal(dryBody.truncated, false);
assert.ok(dryBody.version.startsWith('full-'), dryBody.version);

assert.equal(forReal.status, 500, 'a missing upload dependency must not be reported as success');
assert.equal(forRealBody.stage, 'upload', 'collect and the schema gate passed; only the blob upload is blocked');
assert.match(forRealBody.error, /blob/i, 'the upload failure must name the blob layer');
assert.equal(forRealBody.catalog_stats.count, 9, 'the failure still reports what was collected');

// ---- 回归守卫：函数里不许模块级读 process.env.VERCEL_OIDC_TOKEN ----
const source = await readFile(new URL('./collect.js', import.meta.url), 'utf8');
// 注释里允许提到这个名字（本文件就是在解释为什么不能用），代码里不许出现
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.equal(
  /process\.env\.VERCEL_OIDC_TOKEN/.test(codeOnly),
  false,
  'Vercel docs: the env var is not guaranteed at runtime — read the Request header instead',
);
assert.ok(/export async function GET/.test(source), 'cron needs a GET export');
assert.ok(/export async function POST/.test(source), 'manual re-runs need POST');

console.log(
  'api ok — CRON_SECRET gate (503/401), OIDC via Request header, fixture end-to-end to ?dry=1 (9 entries, 21 requests, ' +
    'limit_records=3000), upload failure is loud and carries catalog_stats',
);
