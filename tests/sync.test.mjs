// 同步层的单测：ETag 条件请求（304 不写盘、200 写盘并记住 url/etag）与 HEAD 检查更新。
// 只打桩 fetch，不联网；DSH_HOME 指向临时目录，必须在 import 之前设好。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dsc-sync-'));
process.env.DSH_HOME = home;
const { syncCatalog, checkForUpdate, SYNC_CATALOG, SYNC_META } = await import('../lib/sync.js');

const CATALOG = JSON.stringify({
  version: 'full-2026-10-20T07-02-32-737Z',
  count: 2,
  skills: [
    { id: 'a/b/c', slug: 'c', stars: 1234 },
    { id: 'a/b/d', slug: 'd' },
  ],
});

const calls = [];
const installFetch = (handler) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    return handler(String(url), init);
  };
};
const jsonResponse = (body, { status = 200, etag = '"abc"', url = 'https://blob.example/catalog-latest.json' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (name) => (name === 'etag' ? etag : name === 'content-length' ? String(body.length) : null) },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  json: async () => JSON.parse(body),
});

// ---- 1) 第一次同步：走入口地址，跟随 302，记住最终 url 与 etag ----
installFetch(async (url, init) => {
  if (url === 'https://center.example/api/catalog') {
    return jsonResponse(CATALOG, { url: 'https://blob.example/catalog-latest.json' });
  }
  throw new Error(`unexpected ${url} ${init.method}`);
});
const first = await syncCatalog({ url: 'https://center.example/api/catalog' });
assert.equal(first.ok, true);
assert.equal(first.changed, true);
assert.equal(first.etag, '"abc"', 'etag is remembered');
assert.equal(first.url, 'https://blob.example/catalog-latest.json', 'resolved url is remembered');
const metaAfterFirst = JSON.parse(await readFile(SYNC_META, 'utf8'));
assert.equal(metaAfterFirst.etag, '"abc"');
assert.match(await readFile(SYNC_CATALOG, 'utf8'), /full-2026-10-20/);

// ---- 2) 第二次同步：带 If-None-Match 打 Blob，304 → 零字节、不写盘 ----
const before = await readFile(SYNC_CATALOG, 'utf8');
installFetch(async (url, init) => {
  assert.match(url, /blob\.example/, 'the second sync goes straight to the blob, bypassing the function');
  assert.equal(init.headers['if-none-match'], '"abc"', 'conditional header is sent');
  return { ok: true, status: 304, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
});
const second = await syncCatalog({ url: 'https://center.example/api/catalog' });
assert.equal(second.ok, true);
assert.equal(second.changed, false);
assert.equal(second.unchanged, true);
assert.equal(second.bytes, 0, 'a 304 downloads nothing');
assert.equal(await readFile(SYNC_CATALOG, 'utf8'), before, 'the catalog file is untouched');

// ---- 3) 内容真变了：200 + 新 etag → 写盘并更新 meta ----
const NEW = CATALOG.replace('"count": 2', '"count": 2').replace('full-2026-10-20T07-02-32-737Z', 'full-2026-10-21T07-00-00-000Z');
installFetch(async (url) => jsonResponse(NEW, { etag: '"def"', url }));
const third = await syncCatalog({ url: 'https://center.example/api/catalog' });
assert.equal(third.changed, true);
assert.equal(third.version, 'full-2026-10-21T07-00-00-000Z');
assert.equal(JSON.parse(await readFile(SYNC_META, 'utf8')).etag, '"def"');

// ---- 4) 检查更新：HEAD + If-None-Match，不下载正文 ----
installFetch(async (url, init) => {
  assert.equal(init.method, 'HEAD', 'the update check never downloads the body');
  return { ok: true, status: 304, url, headers: { get: (name) => (name === 'etag' ? '"def"' : null) } };
});
const upToDate = await checkForUpdate();
assert.equal(upToDate.ok, true);
assert.equal(upToDate.updateAvailable, false);
assert.equal(upToDate.notModified, true);

installFetch(async (url, init) => ({
  ok: true,
  status: 200,
  url,
  headers: { get: (name) => (name === 'etag' ? '"ghi"' : null) },
}));
const stale = await checkForUpdate();
assert.equal(stale.updateAvailable, true, 'a different etag means a new version is out');
assert.equal(stale.localVersion, 'full-2026-10-21T07-00-00-000Z');

// ---- 5) 记住的地址失效（404）→ 清掉基线，下次重新解析 ----
installFetch(async (url) => ({ ok: false, status: 404, url, headers: { get: () => null } }));
const broken = await syncCatalog({ url: 'https://center.example/api/catalog' });
assert.equal(broken.ok, false);
assert.match(broken.reason, /404/);
assert.equal(JSON.parse(await readFile(SYNC_META, 'utf8')).etag, null, 'stale baseline is cleared');

// 没有基线时检查更新会说 no_baseline，而不是假装有新版本
const noBaseline = await checkForUpdate();
assert.equal(noBaseline.ok, false);
assert.equal(noBaseline.reason, 'no_baseline');

// ---- 6) 小文件先行：meta 的 sha256 与本地一致 → 6MB 一个字节都不下 ----
{
  const GH = 'https://raw.githubusercontent.com/o/r/catalog/catalog.json';
  const GH_META = 'https://raw.githubusercontent.com/o/r/catalog/catalog-meta.json';
  // 先正常同步一次，拿到 sha256 基线
  installFetch(async (url) => jsonResponse(CATALOG, { url, etag: '"one"' }));
  const seeded = await syncCatalog({ url: GH, force: true });
  assert.equal(seeded.ok, true);
  const localSha = JSON.parse(await readFile(SYNC_META, 'utf8')).sha256;

  const seen = [];
  installFetch(async (url) => {
    seen.push(url);
    if (url === GH_META) {
      return jsonResponse(JSON.stringify({ version: 'full-2026-10-21T07-00-00-000Z', count: 2, sha256: localSha }));
    }
    return jsonResponse(CATALOG, { url, etag: '"two"' });
  });
  const unchanged = await syncCatalog({ url: GH });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed, false, 'same sha256 → nothing to write');
  assert.equal(unchanged.reason, 'meta_unchanged');
  assert.equal(unchanged.bytes, 0);
  assert.deepEqual(seen, [GH_META], 'only the tiny meta file was fetched');
}

// ---- 7) meta 变了 → 才去下 catalog.json ----
{
  const GH = 'https://raw.githubusercontent.com/o/r/catalog/catalog.json';
  const GH_META = 'https://raw.githubusercontent.com/o/r/catalog/catalog-meta.json';
  const NEW = CATALOG.replace('full-2026-10-20T07-02-32-737Z', 'full-2026-10-22T07-00-00-000Z');
  const seen = [];
  installFetch(async (url) => {
    seen.push(url);
    if (url === GH_META) return jsonResponse(JSON.stringify({ version: 'full-2026-10-22T07-00-00-000Z', count: 2, sha256: 'different' }));
    return jsonResponse(NEW, { url, etag: '"three"' });
  });
  const changed = await syncCatalog({ url: GH });
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true);
  assert.equal(changed.version, 'full-2026-10-22T07-00-00-000Z');
  assert.ok(seen.includes(GH_META) && seen.some((u) => u !== GH_META), 'meta first, then the catalog');
}

// ---- 8) 主地址整条失败 → 用回退地址（Blob），并记录 fallbackFrom ----
{
  const GH = 'https://raw.githubusercontent.com/o/r/catalog/catalog.json';
  const BLOB = 'https://dsh-skills-center.vercel.app/api/catalog';
  installFetch(async (url) => {
    if (url === BLOB) return jsonResponse(CATALOG, { url: BLOB, etag: '"blob"' });
    return { ok: false, status: 404, url, headers: { get: () => null } };
  });
  const viaFallback = await syncCatalog({ url: GH, fallbacks: [BLOB] });
  assert.equal(viaFallback.ok, true, 'the fallback keeps sync working when GitHub is down');
  assert.equal(viaFallback.fallbackFrom, GH);
  assert.equal(JSON.parse(await readFile(SYNC_META, 'utf8')).source, BLOB, 'meta records where the bytes actually came from');
}

await rm(home, { recursive: true, force: true });

console.log(`sync ok — ${calls.length} 次打桩请求：解析入口 → 304 零字节 → 200 更新 → HEAD 检查 → 404 清基线`);
