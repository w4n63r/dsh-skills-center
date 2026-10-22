// Vercel 正文代理测试：鉴权、id/sha 校验、上游错误原样透传、sha 不符必须拒收。
// 运行：node tests/api-body.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.CRON_SECRET = 'test-secret';

const { default: handler, pickSkillFile, isSafeId } = await import('../api/body.js');

const SKILL_TEXT = '# hello\n\n这份是正文。\n';
const SKILL_SHA = createHash('sha256').update(SKILL_TEXT).digest('hex');

const realFetch = globalThis.fetch;
let calls = [];
let upstreamAnswer = null;

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), auth: init?.headers?.authorization || '' });
  return upstreamAnswer(url, init);
};

const request = (query, { secret = 'test-secret', oidc = 'jwt-1', headerName = 'authorization' } = {}) => {
  const headers = {};
  if (secret !== null) headers[headerName] = headerName === 'authorization' ? `Bearer ${secret}` : secret;
  if (oidc) headers['x-vercel-oidc-token'] = oidc;
  return new Request(`https://app.test/api/body${query}`, { headers });
};

const okUpstream = (files) => () =>
  new Response(JSON.stringify({ id: 'acme/skills/hello', hash: 'x', files }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

try {
  // 1. 没配置 secret：503（公开代理等于开着额度给别人烧）
  delete process.env.CRON_SECRET;
  let res = await handler(request('?id=acme/skills/hello'));
  assert.equal(res.status, 503, 'no CRON_SECRET must 503');
  process.env.CRON_SECRET = 'test-secret';

  // 2. secret 不对：401
  res = await handler(request('?id=acme/skills/hello', { secret: 'wrong' }));
  assert.equal(res.status, 401, 'wrong secret must 401');

  // 3. 没有请求头 OIDC token 时：要么退回 @vercel/oidc 拿到 token（本机装了它），要么 503。
  //    这里不断言具体值，只断言「不许在没有上游鉴权的情况下继续发请求」。
  upstreamAnswer = okUpstream([{ path: 'SKILL.md', contents: SKILL_TEXT }]);
  res = await handler(request('?id=acme/skills/hello', { oidc: '' }));
  assert.ok([200, 503].includes(res.status), `missing header token must 200 (module token) or 503, got ${res.status}`);
  if (res.status === 503) assert.equal((await res.json()).error, 'no Vercel OIDC token');

  // 4. id 不安全：400（不许 ../ 和空段）
  for (const bad of ['', 'acme', 'acme//hello', '../etc/passwd', 'a/b/../../c']) {
    res = await handler(request(`?id=${encodeURIComponent(bad)}`));
    assert.equal(res.status, 400, `unsafe id must 400: ${bad}`);
  }
  assert.equal(isSafeId('open.feishu.cn/skills/lark-doc'), true);
  assert.equal(isSafeId('acme/skills/hello'), true);

  // 5. sha 形状不对：400
  res = await handler(request('?id=acme/skills/hello&sha=nothex'));
  assert.equal(res.status, 400, 'bad sha must 400');

  // 6. 挑文件：优先 SKILL.md，其次第一个
  assert.equal(pickSkillFile([{ path: 'a.md' }, { path: 'SKILL.md' }]).path, 'SKILL.md');
  assert.equal(pickSkillFile([{ path: 'docs/x.md' }]).path, 'docs/x.md');
  assert.equal(pickSkillFile([]), null);

  // 7. 正常：200 + markdown + sha 头，且请求带上了上游鉴权
  calls = [];
  upstreamAnswer = okUpstream([{ path: 'README.md', contents: 'nope' }, { path: 'SKILL.md', contents: SKILL_TEXT }]);
  res = await handler(request('?id=acme/skills/hello'));
  assert.equal(res.status, 200, 'happy path must 200');
  assert.equal(await res.text(), SKILL_TEXT, 'body must be the SKILL.md text');
  assert.equal(res.headers.get('x-body-sha256'), SKILL_SHA, 'sha header must match');
  assert.equal(res.headers.get('x-body-path'), 'SKILL.md');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://skills.sh/api/v1/skills/acme/skills/hello');
  assert.equal(calls[0].auth, 'Bearer jwt-1', 'upstream must receive the OIDC token, not the CRON secret');

  // 8. ?sha= 对得上：200
  res = await handler(request(`?id=acme/skills/hello&sha=${SKILL_SHA}`));
  assert.equal(res.status, 200, 'matching sha must pass');

  // 9. ?sha= 对不上：502 body_sha_mismatch（内容变了但 id 没变时不许冒充）
  res = await handler(request(`?id=acme/skills/hello&sha=${'a'.repeat(64)}`));
  assert.equal(res.status, 502, 'mismatched sha must 502');
  assert.equal((await res.json()).error, 'body_sha_mismatch');

  // 10. 上游 404 原样透传
  upstreamAnswer = () => new Response('{"error":"not_found"}', { status: 404 });
  res = await handler(request('?id=acme/skills/gone'));
  assert.equal(res.status, 404, 'upstream 404 must pass through');
  assert.equal((await res.json()).error, 'upstream_404');

  // 11. 上游没有文件：404 no_body
  upstreamAnswer = okUpstream([]);
  res = await handler(request('?id=acme/skills/empty'));
  assert.equal(res.status, 404, 'no files must 404');
  assert.equal((await res.json()).error, 'no_body');

  // 12. 上游连不上：502
  upstreamAnswer = () => {
    throw new Error('boom');
  };
  res = await handler(request('?id=acme/skills/hello'));
  assert.equal(res.status, 502, 'network failure must 502');
  assert.match((await res.json()).error, /^upstream_fetch_failed/);

  console.log('api-body ok — 鉴权 3 档 + id/sha 校验 + SKILL.md 优先 + sha 不符拒收 + 上游错误透传');
} finally {
  globalThis.fetch = realFetch;
}
