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

/**
 * 把正文全文发到 GitHub 的 bodies 分支（内容寻址：<sha256>.md）。
 *
 * 为什么不用 Blob：2026-10-21 线上 store 被 suspended（连公开读都 403），整条发布链一起 500。
 * 正文是「收录标准」的凭据（没有正文就不收录），不能挂在随时会被停掉的存储上；
 * GitHub raw 免费、不限流、且已经在承载目录主路径。
 *
 * 一次调用只产生一个 commit：base_tree 复用旧树，而内容寻址意味着同一份正文永远只占一个文件，
 * 所以每天新增的只有这一轮真正抓到的那些 blob。
 *
 * 失败不抛：落到返回值的 `failed` 里，调用方据此把目录里对应的 body.v 抹掉——绝不留一个取不到的 sha。
 */
export async function uploadBodiesToGitHub({
  bodies,
  token,
  repo,
  branch = 'bodies',
  apiBase = DEFAULT_API,
  fetchImpl = globalThis.fetch,
  concurrency = 6,
  message = null,
  log = () => {},
} = {}) {
  const base = `https://raw.githubusercontent.com/${repo}/${branch}`;
  if (!token) {
    return { ok: false, stage: 'auth', error: 'no GitHub token', uploaded: 0, failed: [], base, commit: null };
  }
  if (!repo || !repo.includes('/')) {
    return { ok: false, stage: 'repo', error: 'repo must be "owner/name"', uploaded: 0, failed: [], base, commit: null };
  }
  const entries = [...(bodies instanceof Map ? bodies : new Map(Object.entries(bodies || {})))].filter(
    ([sha, text]) => /^[0-9a-f]{64}$/.test(sha) && typeof text === 'string' && text.length > 0,
  );
  const failed = [];
  if (!entries.length) return { ok: true, stage: 'empty', uploaded: 0, failed, base, commit: null };

  const call = async (path, init) => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      ...init,
      headers: { ...((init && init.headers) || {}), authorization: `Bearer ${token}` },
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
  const all = () => entries.map(([sha]) => sha);

  let stage = 'ref';
  try {
    // 1) 现有分支的树当 base_tree：旧正文文件不动，只加这一轮新的。
    const ref = await call(`/repos/${repo}/git/ref/heads/${branch}`);
    let parent = null;
    let baseTree = null;
    if (ref.ok) {
      parent = (ref.body && ref.body.object && ref.body.object.sha) || null;
      if (parent) {
        const commit = await call(`/repos/${repo}/git/commits/${parent}`);
        if (!commit.ok) {
          return { ok: false, stage: 'base', error: `commit ${commit.status}: ${msg(commit.body)}`, uploaded: 0, failed: all(), base, commit: null };
        }
        baseTree = (commit.body && commit.body.tree && commit.body.tree.sha) || null;
      }
    } else if (ref.status !== 404) {
      return { ok: false, stage: 'ref', error: `ref ${ref.status}: ${msg(ref.body)}`, uploaded: 0, failed: all(), base, commit: null };
    }

    // 2) 每条正文建一个 blob：分批发，GitHub 对突发很敏感（secondary rate limit）。
    stage = 'blob';
    const tree = [];
    for (let i = 0; i < entries.length; i += concurrency) {
      const slice = entries.slice(i, i + concurrency);
      const results = await Promise.all(
        slice.map(async ([sha, text]) => {
          const blob = await call(`/repos/${repo}/git/blobs`, json({ content: text, encoding: 'utf-8' }));
          return { sha, ok: blob.ok, blobSha: blob.body && blob.body.sha, status: blob.status, error: blob.ok ? null : msg(blob.body) };
        }),
      );
      for (const r of results) {
        if (r.ok && r.blobSha) tree.push({ path: `${r.sha}.md`, mode: '100644', type: 'blob', sha: r.blobSha });
        else failed.push(r.sha);
      }
    }
    if (!tree.length) {
      return { ok: false, stage, error: `all ${failed.length} blobs failed`, uploaded: 0, failed, base, commit: null };
    }

    // 3) tree → commit → 强推 ref。
    stage = 'tree';
    const created = await call(`/repos/${repo}/git/trees`, json({ ...(baseTree ? { base_tree: baseTree } : {}), tree }));
    if (!created.ok) {
      return { ok: false, stage, error: `tree ${created.status}: ${msg(created.body)}`, uploaded: 0, failed: all(), base, commit: null };
    }

    stage = 'commit';
    const commit = await call(
      `/repos/${repo}/git/commits`,
      json({
        message: message || `bodies: ${tree.length} texts, ${new Date().toISOString()}`,
        tree: created.body && created.body.sha,
        parents: parent ? [parent] : [],
      }),
    );
    if (!commit.ok) {
      return { ok: false, stage, error: `commit ${commit.status}: ${msg(commit.body)}`, uploaded: 0, failed: all(), base, commit: null };
    }

    stage = 'ref';
    const sha = commit.body && commit.body.sha;
    const update = parent
      ? await call(`/repos/${repo}/git/refs/heads/${branch}`, { ...json({ sha, force: true }), method: 'PATCH' })
      : await call(`/repos/${repo}/git/refs`, json({ ref: `refs/heads/${branch}`, sha }));
    if (!update.ok) {
      return { ok: false, stage, error: `ref ${update.status}: ${msg(update.body)}`, uploaded: 0, failed: all(), base, commit: null };
    }

    log(`github: stored ${tree.length} bodies${failed.length ? `, ${failed.length} failed` : ''} → ${repo}@${branch} ${String(sha).slice(0, 8)}`);
    return { ok: failed.length === 0, stage: 'done', uploaded: tree.length, failed, base, commit: sha || null };
  } catch (error) {
    return { ok: false, stage, error: String((error && error.message) || error), uploaded: 0, failed: all(), base, commit: null };
  }
}
