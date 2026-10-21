// GitHub 分发路径的单测：不联网，用假的 fetch 记录每一次 API 调用，
// 断言「单提交、两个文件同一个 commit、强推 ref」这几条关键设计真的成立。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMeta, publishCatalogToGitHub, uploadBodiesToGitHub } from './publish-github.mjs';

// 单测里不要真的等 1.1s/次，也不要等 5s 退避
process.env.GH_WRITE_INTERVAL_MS = '0';
process.env.GH_RETRY_BASE_MS = '10';

const catalog = {
  version: 'full-2026-10-20T08-43-08-286Z',
  generated_at: '2026-10-20T08:43:08.286Z',
  count: 2,
  skills: [{ id: 'a/b/c' }, { id: 'a/b/d' }],
};
const sha256 = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');

/** 记录调用的假 GitHub：blob/tree/commit/ref 各自返回像样的形状。 */
function fakeGitHub({ refExists = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || 'GET', body, auth: init.headers?.authorization });
    const respond = (status, payload) => ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(payload),
    });
    if (path.includes('/git/blobs')) {
      const content = body?.content || '';
      return respond(201, { sha: createHash('sha1').update(content).digest('hex') });
    }
    if (path.endsWith('/git/trees')) return respond(201, { sha: 'tree-sha' });
    if (path.endsWith('/git/commits')) return respond(201, { sha: 'commit-sha' });
    if (path.includes('/git/refs/heads/') && (!init.method || init.method === 'GET')) {
      // 读分支 ref：分支不存在时 GitHub 就是 404
      return refExists ? respond(200, { object: { sha: 'old-commit' } }) : respond(404, { message: 'Not Found' });
    }
    if (path.includes('/git/refs/heads/')) return respond(200, { object: { sha: body?.sha } });
    if (path.endsWith('/git/refs')) return respond(201, { ref: body?.ref, object: { sha: body?.sha } });
    return respond(500, { message: `unexpected ${path}` });
  };
  return { calls, fetchImpl };
}

// ---- 1) 正常路径：4 类调用各一次，commit 无父提交，ref 强推 ----
{
  const { calls, fetchImpl } = fakeGitHub();
  const result = await publishCatalogToGitHub({
    catalog,
    token: 'ghp_test',
    repo: 'w4n63r/dsh-skills-center',
    sha256,
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.ok, true, result.error);
  assert.match(result.url, /^https:\/\/raw\.githubusercontent\.com\/w4n63r\/dsh-skills-center\/catalog\/catalog\.json$/);
  assert.match(result.metaUrl, /catalog-meta\.json$/);
  assert.equal(result.commit, 'commit-sha');
  assert.ok(result.bytes > 0);
  assert.ok(calls.every((c) => c.auth === 'Bearer ghp_test'), 'every call carries the token');

  const blobs = calls.filter((c) => c.path.includes('/git/blobs'));
  assert.equal(blobs.length, 2, 'catalog + meta are uploaded as two blobs');
  const paths = calls
    .find((c) => c.path.endsWith('/git/trees'))
    .body.tree.map((t) => t.path)
    .sort();
  assert.deepEqual(paths, ['catalog-meta.json', 'catalog.json'], 'both files land in one tree/commit');
  const commit = calls.find((c) => c.path.endsWith('/git/commits')).body;
  assert.deepEqual(commit.parents, [], 'the catalog branch stays a single parentless commit');
  assert.match(commit.message, /full-2026-10-20T08-43-08-286Z/);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.force, true, 'an existing ref is force-updated');
  assert.equal(patch.body.sha, 'commit-sha');
}

// ---- 2) 分支不存在 → 新建 ref（不是 PATCH） ----
{
  const { calls, fetchImpl } = fakeGitHub({ refExists: false });
  const result = await publishCatalogToGitHub({ catalog, token: 't', repo: 'o/r', sha256, fetchImpl, log: () => {} });
  assert.equal(result.ok, true, result.error);
  const create = calls.find((c) => c.path.endsWith('/git/refs') && c.method === 'POST');
  assert.equal(create.body.ref, 'refs/heads/catalog');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'nothing to patch when the branch is new');
}

// ---- 3) 失败要如实上报，且不谎报成功 ----
{
  const failing = async (url) => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }),
  });
  const result = await publishCatalogToGitHub({ catalog, token: 't', repo: 'o/r', fetchImpl: failing, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'blob');
  assert.match(result.error, /403|not accessible/);
}
{
  // 没 token / 没 repo / 空目录：在发请求之前就拦住
  assert.equal((await publishCatalogToGitHub({ catalog, repo: 'o/r' })).stage, 'auth');
  assert.equal((await publishCatalogToGitHub({ catalog, token: 't' })).stage, 'repo');
  assert.equal((await publishCatalogToGitHub({ catalog: { skills: [] }, token: 't', repo: 'o/r' })).stage, 'catalog');
}

// ---- 4) meta 文件够小、字段固定：插件靠它决定要不要下 6MB ----
{
  const meta = buildMeta(catalog, { sha256, bytes: 12345 });
  assert.deepEqual(Object.keys(meta).sort(), ['bytes', 'count', 'generated_at', 'published_at', 'sha256', 'version']);
  assert.equal(meta.sha256, sha256);
  assert.equal(meta.count, 2);
  assert.ok(JSON.stringify(meta).length < 400, 'meta stays tiny');
}

// ---- 5) 正文上传：内容寻址文件、单提交、base_tree 复用旧正文 ----
function fakeBodiesGitHub({ refExists = true, failShas = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method || 'GET';
    calls.push({ path, method, body });
    const respond = (status, payload) => ({ ok: status < 300, status, text: async () => JSON.stringify(payload) });
    if (path === '/repos/o/r/git/ref/heads/bodies') {
      return refExists ? respond(200, { object: { sha: 'old-commit' } }) : respond(404, { message: 'Not Found' });
    }
    if (/\/git\/commits\/[0-9a-z-]+$/.test(path)) return respond(200, { tree: { sha: 'base-tree' } });
    if (path.endsWith('/git/blobs')) {
      const sha = createHash('sha256').update(String(body?.content || '')).digest('hex');
      if (failShas.has(sha)) return respond(403, { message: 'Resource not accessible by personal access token' });
      return respond(201, { sha: `blob-${sha.slice(0, 6)}` });
    }
    if (path.endsWith('/git/trees')) return respond(201, { sha: 'tree-sha' });
    if (path.endsWith('/git/commits')) return respond(201, { sha: 'body-commit-sha' });
    if (path.endsWith('/git/refs/heads/bodies')) return respond(200, { object: { sha: body?.sha } });
    if (path.endsWith('/git/refs')) return respond(201, { ref: body?.ref, object: { sha: body?.sha } });
    return respond(500, { message: `unexpected ${method} ${path}` });
  };
  return { calls, fetchImpl };
}

const textA = '# a\nbody a';
const textB = '# b\nbody b';
const shaA = createHash('sha256').update(textA).digest('hex');
const shaB = createHash('sha256').update(textB).digest('hex');

{
  // 两份正文 → 两个 <sha>.md + 一个 commit，且旧正文靠 base_tree 留在树里
  const { calls, fetchImpl } = fakeBodiesGitHub();
  const result = await uploadBodiesToGitHub({
    bodies: new Map([
      [shaA, textA],
      [shaB, textB],
    ]),
    token: 'ghp_test',
    repo: 'o/r',
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.uploaded, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(result.commit, 'body-commit-sha');
  assert.equal(result.base, 'https://raw.githubusercontent.com/o/r/bodies');
  const tree = calls.find((c) => c.path.endsWith('/git/trees')).body;
  assert.deepEqual(tree.tree.map((t) => t.path).sort(), [`${shaA}.md`, `${shaB}.md`].sort(), '正文按内容寻址命名');
  assert.equal(tree.base_tree, 'base-tree', '一次调用只加新的，旧正文不动');
  assert.equal(calls.filter((c) => c.path.endsWith('/git/blobs')).length, 2);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(calls.find((c) => c.method === 'PATCH').body.sha, 'body-commit-sha');
}

{
  // 个别正文传不上去：不谎报成功，落进 failed 让调用方抹掉 body.v
  const { fetchImpl } = fakeBodiesGitHub({ failShas: new Set([shaB]) });
  const result = await uploadBodiesToGitHub({ bodies: { [shaA]: textA, [shaB]: textB }, token: 't', repo: 'o/r', fetchImpl, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.failed, [shaB]);
}

{
  // 非法指纹、空正文全部过滤；没有可传的就一个请求都不发
  const { calls, fetchImpl } = fakeBodiesGitHub();
  const result = await uploadBodiesToGitHub({ bodies: { nope: textA, [shaA]: '' }, token: 't', repo: 'o/r', fetchImpl, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.uploaded, 0);
  assert.equal(result.stage, 'empty');
  assert.equal(calls.length, 0);
}

{
  // 分支还不存在 → 新建 ref 而不是 PATCH；首个 commit 没有父提交
  const { calls, fetchImpl } = fakeBodiesGitHub({ refExists: false });
  const result = await uploadBodiesToGitHub({ bodies: { [shaA]: textA }, token: 't', repo: 'o/r', fetchImpl, log: () => {} });
  assert.equal(result.ok, true, result.error);
  const create = calls.find((c) => c.path.endsWith('/git/refs') && c.method === 'POST');
  assert.equal(create.body.ref, 'refs/heads/bodies');
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/commits')).body.parents, []);
  assert.equal(calls.find((c) => c.path.endsWith('/git/trees')).body.base_tree, undefined);
}

{
  // 缺 token / 缺 repo：发请求之前就拦住
  assert.equal((await uploadBodiesToGitHub({ bodies: { [shaA]: textA }, repo: 'o/r' })).stage, 'auth');
  assert.equal((await uploadBodiesToGitHub({ bodies: { [shaA]: textA }, token: 't' })).stage, 'repo');
}

{
  // 每轮上限：超出的按失败上报（调用方据此抹掉 body.v，下一轮自然重试）
  const { calls, fetchImpl } = fakeBodiesGitHub();
  const result = await uploadBodiesToGitHub({
    bodies: { [shaA]: textA, [shaB]: textB },
    token: 't',
    repo: 'o/r',
    maxBodies: 1,
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.failed, [shaB]);
  assert.equal(calls.filter((c) => c.path.endsWith('/git/blobs')).length, 1, '超出的正文一个请求都不发');
}

{
  // 限流 403：等一会儿重试，而不是把整轮判死
  const inner = fakeBodiesGitHub();
  let blobHits = 0;
  const flaky = async (url, init) => {
    if (String(url).endsWith('/git/blobs') && (blobHits += 1) === 1) {
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }),
      };
    }
    return inner.fetchImpl(url, init);
  };
  const result = await uploadBodiesToGitHub({ bodies: { [shaA]: textA }, token: 't', repo: 'o/r', fetchImpl: flaky, log: () => {} });
  assert.equal(result.ok, true, result.error);
  assert.equal(blobHits, 2, '第一次限流后必须重试');
}

{
  // 权限类 403 不重试：重试也没用，直接如实上报
  let hits = 0;
  const denied = async () => {
    hits += 1;
    return {
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }),
    };
  };
  const result = await uploadBodiesToGitHub({ bodies: { [shaA]: textA }, token: 't', repo: 'o/r', fetchImpl: denied, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'ref');
  assert.equal(hits, 1, '权限类 403 只发一次');
}

console.log('publish-github ok — 单提交强推、catalog+meta 同 commit、正文内容寻址上传、限流退避重试、失败如实上报');
