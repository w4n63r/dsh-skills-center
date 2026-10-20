// GitHub 分发路径的单测：不联网，用假的 fetch 记录每一次 API 调用，
// 断言「单提交、两个文件同一个 commit、强推 ref」这几条关键设计真的成立。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildMeta, publishCatalogToGitHub } from './publish-github.mjs';

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

console.log('publish-github ok — 单提交强推、catalog+meta 同 commit、失败如实上报');
