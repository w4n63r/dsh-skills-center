// /body 路由测试：正文按内容寻址（<sha256>.md）从 body_base 抓一次、缓存到本地、之后走缓存。
// 运行：node tests/body.test.mjs
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = await mkdtemp(join(tmpdir(), 'skills-center-body-'));
process.env.DSH_HOME = home;

// 静态 import 会被提升到上面两行之前，模块会在真实 HOME 下算好路径 —— 必须动态 import。
const { apply } = await import('../lib/index.js');

const SHA = 'f'.repeat(64);
const SKILL_ID = 'acme/skills/hello';
const BODY_BASE = 'https://bodies.test/b';
const CATALOG = {
  version: 'test-body',
  generated_at: '2026-10-21T00:00:00.000Z',
  count: 1,
  raw_count: 1,
  max_installs: 10,
  body_base: BODY_BASE,
  skills: [
    {
      id: SKILL_ID,
      source: 'acme/skills',
      slug: 'hello',
      name: 'hello',
      installs: 10,
      description_en: 'says hello',
      body: { length: 42, sha256: SHA, v: 1 },
    },
  ],
};

const catalogFile = join(home, 'skills-center', 'catalog', 'catalog.json');
await mkdir(join(home, 'skills-center', 'catalog'), { recursive: true });
await writeFile(catalogFile, JSON.stringify(CATALOG), 'utf8');

// ---- 假 ctx：只实现 apply 用到的面 ----
const captured = { routes: [] };
const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => dispose?.();
  },
  skills: { registerProvider: () => () => {} },
  tools: { register: () => () => {} },
  webServer: {
    register(route) {
      captured.routes.push(route);
      return () => {};
    },
  },
};
apply(ctx, {});
assert.equal(captured.routes.length, 1, '插件应注册一条 prefix 路由');
const route = captured.routes[0];

const calls = [];
const fakeFetch = async (url) => {
  calls.push(String(url));
  if (!String(url).startsWith(`${BODY_BASE}/${SHA}.md`)) {
    return { ok: false, status: 404, text: async () => '{}' };
  }
  return { ok: true, status: 200, text: async () => '# hello\n\n正文 fixture\n' };
};
globalThis.fetch = fakeFetch;

const callApi = async (pathname) => {
  let body = '';
  const headers = {};
  const res = {
    statusCode: 0,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      body = chunk;
    },
  };
  await route.handler({ url: pathname, method: 'GET' }, res);
  return { code: res.statusCode, headers, body };
};

// 1) 第一次：从远端抓，并落缓存
const first = await callApi(`/api/dsh-skills-center/body?id=${encodeURIComponent(SKILL_ID)}`);
assert.equal(first.code, 200);
assert.match(first.headers['content-type'], /text\/markdown/);
assert.equal(first.headers['x-body-via'], 'remote');
assert.match(first.body, /正文 fixture/);
assert.deepEqual(calls, [`${BODY_BASE}/${SHA}.md`], '正文地址 = body_base/<sha256>.md');
const cached = await readFile(join(home, 'skills-center', 'bodies', `${SHA}.md`), 'utf8');
assert.match(cached, /正文 fixture/, '正文要落到本地缓存');

// 2) 第二次：走缓存，不再请求远端
const second = await callApi(`/api/dsh-skills-center/body?sha=${SHA}`);
assert.equal(second.code, 200);
assert.equal(second.headers['x-body-via'], 'cache');
assert.equal(second.body, first.body);
assert.equal(calls.length, 1, '缓存命中就不该再打远端');

// 3) 错误路径
assert.equal((await callApi('/api/dsh-skills-center/body?sha=nothex')).code, 400);
assert.equal((await callApi('/api/dsh-skills-center/body?id=acme/skills/nope')).code, 404);
const noBody = JSON.parse((await callApi('/api/dsh-skills-center/body?id=acme/skills/nope')).body);
assert.equal(noBody.error, 'no_body');

// 4) 远端 404：如实上报，不写缓存
const missSha = 'a'.repeat(64);
const miss = await callApi(`/api/dsh-skills-center/body?sha=${missSha}`);
assert.equal(miss.code, 502);
assert.match(miss.body, /body_fetch_404/);
await assert.rejects(readFile(join(home, 'skills-center', 'bodies', `${missSha}.md`), 'utf8'));

await rm(home, { recursive: true, force: true });
console.log('body ok — 内容寻址取正文、落缓存、二次命中缓存、错误路径如实上报');
