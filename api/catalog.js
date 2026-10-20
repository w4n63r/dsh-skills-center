// 目录的稳定入口：/api/catalog → 302 到 Blob 上的 catalog-latest.json。
//
// 为什么需要这一层：Blob 的公共地址里带着 store id（n6otug…），会随 store 重建而变；
// 插件和 README 里写的地址不能跟着变，所以给一个固定的、由我们自己控制的入口。
// 这里不做鉴权：目录本身就是要公开给插件拉的，没有秘密。
//
// 不做重定向缓存（no-store）：目录每天更新一次，转发层多缓存一小时没有意义，
// 真正的 60s 缓存由 Blob 指针对象自己的 cacheControlMaxAge 控制（见 collector/publish.mjs）。

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const PREFIX = process.env.BLOB_PREFIX || 'catalog';

// 固定地址（Blob 上的 catalog-latest.json）。设了就完全不碰 Blob API：
// 这个路由每次被调用都 list() 一次会算「高级操作」，免费额度每月只有 2,000 次。
// 换 store 或重建 store 时改这个环境变量即可，插件的地址不用动。
const LATEST_URL = String(process.env.CATALOG_LATEST_URL || '').trim();

export async function GET() {
  // 快路径：直接 302 到 Blob 上的固定地址，零 Blob 操作
  if (/^https?:\/\//.test(LATEST_URL)) {
    return new Response(null, {
      status: 302,
      headers: { location: LATEST_URL, 'cache-control': 'no-store' },
    });
  }
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: `${PREFIX}-latest.json`, limit: 1 });
    const target = blobs?.[0];
    if (!target?.url) {
      return new Response(
        JSON.stringify({ ok: false, stage: 'missing', error: `no ${PREFIX}-latest.json in blob storage — run /api/collect first` }, null, 2),
        { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
      );
    }
    return new Response(null, {
      status: 302,
      headers: { location: target.url, 'cache-control': 'no-store' },
    });
  } catch (error) {
    // Blob 没配置（本地/预览环境）时也要给出能直接照做的错误，而不是 500 空体
    return new Response(
      JSON.stringify({ ok: false, stage: 'blob', error: String(error?.message || error) }, null, 2),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
}
