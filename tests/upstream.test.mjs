// /upstream：本地目录搜不到时，向上游 skills.sh 的公开搜索接口要几个真结果。
// 这里只用假 fetch —— 单测不该打到线上（那个接口 30 次/分钟/IP）。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dsc-upstream-'));
process.env.DSH_HOME = home;
await mkdir(join(home, 'skills-center', 'catalog'), { recursive: true });
await writeFile(
  join(home, 'skills-center', 'catalog', 'catalog.json'),
  JSON.stringify({ version: 't', count: 1, skills: [{ id: 'acme/skills/one', slug: 'one', name: 'one', source: 'acme/skills', installs: 10 }] }),
  'utf8',
);

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (String(url).includes('q=boom')) throw new Error('connect timeout');
  if (String(url).includes('q=many')) return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
  if (String(url).includes('q=down')) return new Response('{}', { status: 500 });
  return new Response(
    JSON.stringify({
      query: 'pdf',
      skills: [
        { id: 'anthropics/skills/pdf', source: 'anthropics/skills', skillId: 'pdf', name: 'pdf', installs: 812345 },
        { id: 'acme/tools/pdf-tools', source: 'acme/tools', skillId: 'pdf-tools', name: '', installs: null },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

const { apply } = await import('../lib/index.js');

const ctx = {
  inject: () => {},
  logger: { warn() {}, info() {}, error() {}, debug() {} },
  effect(fn) {
    const dispose = fn();
    return () => dispose?.();
  },
  tools: { register() {} },
  skills: { register() {}, registerProvider() {}, invalidateCache() {} },
  webServer: {
    routes: [],
    register(route) {
      this.routes.push(route);
      return () => {};
    },
  },
};
apply(ctx, {});
const route = ctx.webServer.routes[0];
assert.ok(route, '应当注册一个 webServer 路由');

const callApi = async (path) => {
  let body = '';
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      body += chunk ?? '';
    },
  };
  await route.handler({ url: `http://localhost${path}`, method: 'GET', headers: {} }, res);
  return { code: res.statusCode, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
};

try {
  const ok = await callApi('/api/dsh-skills-center/upstream?q=pdf');
  assert.equal(ok.code, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.source, 'skills.sh');
  assert.equal(ok.json.count, 2);
  assert.equal(ok.json.skills[0].name, 'pdf');
  assert.equal(ok.json.skills[0].installs, 812345);
  assert.equal(ok.json.skills[0].url, 'https://skills.sh/anthropics/skills/pdf');
  assert.equal(ok.json.skills[1].name, 'pdf-tools', '没有 name 时退回 slug');
  assert.equal(ok.json.skills[1].installs, null);
  assert.match(calls.at(-1).url, /limit=8/, '默认 limit 8');
  assert.ok(calls.at(-1).options.signal, '必须带超时信号');

  assert.equal((await callApi('/api/dsh-skills-center/upstream?q=p')).code, 400, 'q 少于 2 字符拒绝');

  const many = await callApi('/api/dsh-skills-center/upstream?q=many');
  assert.equal(many.code, 429);
  assert.equal(many.json.error, 'upstream_rate_limited');
  assert.equal(many.json.retry_after, '60');

  const down = await callApi('/api/dsh-skills-center/upstream?q=down');
  assert.equal(down.code, 502);
  assert.equal(down.json.error, 'upstream_failed');
  assert.equal(down.json.status, 500);

  const boom = await callApi('/api/dsh-skills-center/upstream?q=boom');
  assert.equal(boom.code, 502);
  assert.equal(boom.json.error, 'upstream_unreachable');

  const capped = await callApi('/api/dsh-skills-center/upstream?q=pdf&limit=999');
  assert.equal(capped.code, 200);
  assert.match(calls.at(-1).url, /limit=20/, 'limit 上限 20');
} finally {
  globalThis.fetch = realFetch;
  await rm(home, { recursive: true, force: true });
}

console.log('upstream ok — 本地搜不到时问上游，限流与失败如实回传，q 长度与 limit 上限有守卫');
