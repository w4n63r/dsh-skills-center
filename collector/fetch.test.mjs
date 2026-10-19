// /api/v1 客户端的单测：不联网，用假的 fetch 演一遍分页、429、401、并发失败。
// 这些是「上线后才发现」的典型坑，必须在没有 token 的时候就能测。
import assert from 'node:assert/strict';
import { authHeaders, createClient, flattenCurated, mapLimit, unwrap, PER_PAGE, MIN_INTERVAL_MS } from './fetch.mjs';

// ---- 信封兼容 ----
assert.deepEqual(unwrap([{ a: 1 }]).items.length, 1, 'bare array works');
assert.equal(unwrap({ data: [{}, {}], pagination: { total: 8420, hasMore: true } }).total, 8420);
assert.equal(unwrap({ data: [], pagination: { hasMore: false } }).hasMore, false);
assert.equal(unwrap({ skills: [{}, {}], total: 2 }).total, 2, 'old search shape still parses');
assert.equal(unwrap({ items: [{}], pagination: { total: 99 } }).total, 99);
assert.equal(unwrap(null).items.length, 0, 'null payload must not throw');

// ---- curated 是按 owner 分组的，必须摊平 ----
const curated = flattenCurated({
  data: [
    { owner: 'vercel-labs', skills: [{ id: 'vercel-labs/agent-skills/find-skills' }] },
    { owner: 'anthropics', skills: [{ id: 'anthropics/skills/frontend-design' }, { id: 'anthropics/skills/pdf' }] },
  ],
  totalOwners: 87,
  totalSkills: 342,
});
assert.equal(curated.length, 3, 'nested owner groups must flatten into a flat skill list');
assert.ok(curated.every((s) => s.curated === true && s.official === true));
assert.equal(curated[2].id, 'anthropics/skills/pdf');

// ---- 鉴权头：只发 Authorization ----
const headers = authHeaders('tok');
assert.equal(headers.Authorization, 'Bearer tok');
assert.equal(
  headers['x-vercel-oidc-token'],
  undefined,
  '文档里那个 raw header 写法线上返回 401，不能发（实测）',
);
assert.deepEqual(authHeaders(undefined), {}, 'no token → no headers (so we get an honest 401)');

// ---- 假 API：0 起始分页，2 页 × 2 条后第 3 页空 ----
function makeFakeFetch({ pages, status = 200, onCall } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    onCall?.(url, calls.length);
    const page = Number(new URL(url).searchParams.get('page') ?? 0);
    const rows = pages ? pages[page] || [] : [];
    const total = pages ? pages.flat().length : 0;
    const body = {
      data: rows,
      pagination: { page, perPage: 2, total, hasMore: page < (pages ? pages.length - 1 : 0) },
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : '',
      headers: { get: (k) => (k === 'retry-after' ? '0' : null) },
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

const fake = makeFakeFetch({ pages: [[{ id: 'a/x' }, { id: 'a/y' }], [{ id: 'a/z' }]] });
const client = createClient({ token: 'tok', fetchImpl: fake, base: 'https://example.test' });
const all = await client.listAll({ perPage: 2 });
assert.deepEqual(
  all.map((s) => s.id),
  ['a/x', 'a/y', 'a/z'],
  'pagination follows hasMore instead of a hard-coded count',
);
assert.equal(fake.calls.length, 2, 'must not request a third page once hasMore is false');
assert.ok(fake.calls[0].includes('page=0'), 'first request is page 0 — the API is 0-indexed');
assert.ok(fake.calls[0].startsWith('https://example.test/api/v1/skills?'), 'relative paths get the base');

// 限流：两次请求之间至少隔 MIN_INTERVAL_MS，否则 600/min 会被打成 429
const t0 = Date.now();
const slowClient = createClient({ token: 'tok', fetchImpl: makeFakeFetch({ pages: [[], []] }) });
await slowClient.listPage({ page: 1 });
await slowClient.listPage({ page: 2 });
assert.ok(Date.now() - t0 >= MIN_INTERVAL_MS - 5, `should throttle to ${MIN_INTERVAL_MS}ms between calls`);

// ---- 401：立刻抛，且错误文案要能指导部署，不要伪装成网络问题 ----
const unauthorized = createClient({ token: 'bad', fetchImpl: makeFakeFetch({ status: 401 }) });
await assert.rejects(() => unauthorized.listPage({}), /401 authentication_required/);
await assert.rejects(() => unauthorized.listPage({}), /VERCEL_OIDC_TOKEN|OIDC Federation/);

// ---- 429：重试后成功，不把整批数据丢掉 ----
let attempts = 0;
const flaky = async (url) => {
  attempts += 1;
  if (attempts === 1) {
    return { ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => '0' }, json: async () => ({}) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ skills: [{ id: 'a/ok' }], total: 1 }) };
};
const retried = createClient({ token: 'tok', fetchImpl: flaky });
const recovered = await retried.listPage({});
assert.equal(recovered.items.length, 1, '429 must be retried, not fatal');

// ---- detail / audit 的路径编码：id 里带点号或大写不能变形 ----
const pathCalls = [];
const recorder = createClient({
  token: 'tok',
  fetchImpl: async (url) => {
    pathCalls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
  },
});
await recorder.detail('mintlify.com/mintlify');
await recorder.audit('anthropics/skills/frontend-design');
assert.ok(pathCalls[0].endsWith('/api/v1/skills/mintlify.com/mintlify'), pathCalls[0]);
assert.ok(pathCalls[1].endsWith('/api/v1/skills/audit/anthropics/skills/frontend-design'), pathCalls[1]);

// ---- mapLimit：并发受控、单条失败不影响其他条 ----
let active = 0;
let peak = 0;
const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, 5));
  active -= 1;
  if (n === 3) throw new Error('boom');
  return n * 2;
});
assert.ok(peak <= 2, `concurrency must stay <= 2, saw ${peak}`);
assert.deepEqual(results, [2, 4, null, 8, 10, 12], 'a failing item becomes null, the rest survive');

// 默认 per_page 必须是文档给的上限，改了这里等于多打几十个请求
assert.equal(PER_PAGE, 500);

console.log(`fetch ok — throttled ${MIN_INTERVAL_MS}ms/call, pagination + 401 + 429 + mapLimit verified`);
