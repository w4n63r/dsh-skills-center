// 目录的第二条分发路径：GitHub（单提交分支 + raw CDN）。
//
// 为什么要有它：Vercel Blob 的公开读路径实测会整体 404（"Store not found"，2026-10-20 故障），
// 而目录分发是插件的命脉；GitHub raw 免费、全球 CDN、ETag 由内容推导（内容不变就永远 304）。
//
// 设计取舍：
// - **单提交分支**：catalog 分支永远只有一个「无父提交」的 commit，每天强推覆盖。
//   好处：仓库只占一份目录的体积（~6MB），不会天天 +6MB；读者要么看到旧版要么看到新版（commit 是原子的）。
// - 两个文件一起进同一个 commit：`catalog.json`（全量）与 `catalog-meta.json`（~200 字节，
//   供插件「先查小文件、变了再下大文件」）。分开两次提交会出现「meta 说新了、catalog 还是旧的」的窗口。
// - 用 Git Data API（blob→tree→commit→ref）而不是 Contents API：一次提交写多个文件，
//   而且能构造无父提交来保持单提交历史。
// - 失败不抛：调用方（采集函数）把结果写进响应体，Blob 那份仍然在，不影响线上可用性。

const DEFAULT_API = 'https://api.github.com';

const json = (body) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'dsh-skills-center-collector',
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** meta 文件：插件先用它判断「要不要下 6MB」。字段少而稳，别塞业务字段。 */
export function buildMeta(catalog, { sha256 = null, bytes = null } = {}) {
  return {
    version: catalog?.version ?? null,
    count: Number.isFinite(catalog?.count) ? catalog.count : null,
    generated_at: catalog?.generated_at ?? null,
    bytes: bytes ?? null,
    sha256: sha256 ?? null,
    published_at: new Date().toISOString(),
  };
}

/**
 * 把目录发到 GitHub 的 catalog 分支（单提交、强推）。
 *
 * @param {object} options
 * @param {object} options.catalog   目录对象
 * @param {string} options.token     GitHub token（contents:write）
 * @param {string} options.repo      "owner/repo"
 * @param {string} [options.branch]  分支名，默认 catalog
 * @param {string} [options.sha256]  目录内容的 sha256（调用方算好，写进 meta）
 * @param {Function} [options.fetchImpl] 注入 fetch（离线测试）
 * @returns {Promise<{ok:boolean, stage?:string, error?:string, url?:string, metaUrl?:string, commit?:string, bytes?:number, meta?:object}>}
 */
export async function publishCatalogToGitHub({
  catalog,
  token,
  repo,
  branch = 'catalog',
  sha256 = null,
  apiBase = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  if (!token) return { ok: false, stage: 'auth', error: 'no GitHub token' };
  if (!repo || !repo.includes('/')) return { ok: false, stage: 'repo', error: 'repo must be "owner/name"' };
  if (!catalog || !Array.isArray(catalog.skills) || !catalog.skills.length) {
    return { ok: false, stage: 'catalog', error: 'catalog has no skills' };
  }

  const body = JSON.stringify(catalog);
  const bytes = Buffer.byteLength(body);
  const meta = buildMeta(catalog, { sha256, bytes });
  const metaBody = JSON.stringify(meta);

  const call = async (path, init) => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      ...init,
      headers: { ...(init?.headers || {}), authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: response.status, ok: response.ok, body: parsed };
  };

  let stage = 'blob';
  try {
    // 1) 两个文件的内容先建 blob（GitHub 返回各自的 sha）
    const catalogBlob = await call(`/repos/${repo}/git/blobs`, json({ content: body, encoding: 'utf-8' }));
    if (!catalogBlob.ok) return { ok: false, stage, error: `blob(catalog) ${catalogBlob.status}: ${msg(catalogBlob.body)}` };
    const metaBlob = await call(`/repos/${repo}/git/blobs`, json({ content: metaBody, encoding: 'utf-8' }));
    if (!metaBlob.ok) return { ok: false, stage, error: `blob(meta) ${metaBlob.status}: ${msg(metaBlob.body)}` };

    // 2) 树里只放这两个文件；不基于任何 base_tree，保证目录分支永远是干净的两个文件
    stage = 'tree';
    const tree = await call(`/repos/${repo}/git/trees`, json({
      tree: [
        { path: 'catalog.json', mode: '100644', type: 'blob', sha: catalogBlob.body?.sha },
        { path: 'catalog-meta.json', mode: '100644', type: 'blob', sha: metaBlob.body?.sha },
      ],
    }));
    if (!tree.ok) return { ok: false, stage, error: `tree ${tree.status}: ${msg(tree.body)}` };

    // 3) 无父提交：catalog 分支永远只有一个 commit（仓库不会天天长大）
    stage = 'commit';
    const commit = await call(`/repos/${repo}/git/commits`, json({
      message: `catalog ${catalog.version} (${catalog.count} skills)`,
      tree: tree.body?.sha,
      parents: [],
    }));
    if (!commit.ok) return { ok: false, stage, error: `commit ${commit.status}: ${msg(commit.body)}` };

    // 4) 强推 ref：分支不存在就新建，存在就 force 覆盖到新提交
    stage = 'ref';
    const refPath = `/repos/${repo}/git/refs/heads/${branch}`;
    const existing = await call(refPath);
    const refResult = existing.status === 404
      ? await call(`/repos/${repo}/git/refs`, json({ ref: `refs/heads/${branch}`, sha: commit.body?.sha }))
      : await call(refPath, { ...json({ sha: commit.body?.sha, force: true }), method: 'PATCH' });
    if (!refResult.ok) return { ok: false, stage, error: `ref ${refResult.status}: ${msg(refResult.body)}` };

    const raw = `https://raw.githubusercontent.com/${repo}/${branch}`;
    log(`github: published ${catalog.count} skills (${bytes}B) → ${repo}@${branch} ${String(commit.body?.sha).slice(0, 8)}`);
    return {
      ok: true,
      stage: 'done',
      url: `${raw}/catalog.json`,
      metaUrl: `${raw}/catalog-meta.json`,
      commit: commit.body?.sha ?? null,
      bytes,
      meta,
    };
  } catch (error) {
    return { ok: false, stage, error: String(error?.message || error) };
  }
}

const msg = (body) => (body && (body.message || body.error)) || 'unknown error';
