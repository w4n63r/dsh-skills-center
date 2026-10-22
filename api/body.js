// Vercel 正文代理：本地批量取正文时走这里。
//
// 为什么需要它：skills.sh 的匿名下载接口只有 **60 次/小时/IP**，而认证版
// `/api/v1/skills/<id>` 是 **600 次/分钟**（team+project 级）。本函数跑在 Vercel 上，
// 天然带 OIDC token，等于把「一次批量补 100 份正文」从两小时压到几秒。
//
// 鉴权：`CRON_SECRET`（与 `/api/collect` 用同一个 secret）。没设置直接 503 —— 否则这就是
// 一个公开的上游代理，谁都能拿它刷别人的额度。
//
// 参数：
//   `id`  `<source>/<slug>`（必填，就是目录里的 id）
//   `sha` 64 位十六进制（可选；给了就校验，对不上回 502 `body_sha_mismatch`）
// 响应：`text/markdown`，头里带 `x-body-sha256` / `x-body-path` / `x-body-bytes`。

import { timingSafeEqual, createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SECRET_HEADER = 'authorization';

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** 常量时间比较；长度不同也走一次比较，避免用响应时间探测。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(left.length, right.length, 1);
  const la = Buffer.alloc(len);
  const lb = Buffer.alloc(len);
  left.copy(la);
  right.copy(lb);
  return timingSafeEqual(la, lb) && left.length === right.length;
}

/**
 * 取上游所需的 OIDC token。正确渠道只有两个，都在 handler 内：
 *   ① 平台注入到 Request 的 `x-vercel-oidc-token` 头
 *   ② `@vercel/oidc` 的 `getVercelOidcToken()`
 * 不要碰 `process.env.VERCEL_OIDC_TOKEN`（运行期不被保证）。
 */
async function resolveOidc(request) {
  const fromHeader = request.headers.get('x-vercel-oidc-token');
  if (fromHeader) return fromHeader.trim();
  try {
    const mod = await import('@vercel/oidc');
    return await mod.getVercelOidcToken();
  } catch {
    return '';
  }
}

/** 从 files[{path,contents}] 里挑 SKILL.md；没有就退回第一个文件。 */
export function pickSkillFile(files) {
  const list = Array.isArray(files) ? files : [];
  return list.find((f) => /(^|\/)SKILL\.md$/i.test(String(f?.path || ''))) || list[0] || null;
}

/** id 只允许 `<owner>/<repo...>/<slug>` 这种段式，挡掉 ../ 和空段。 */
export function isSafeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 300) return false;
  const parts = id.split('/');
  if (parts.length < 2) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9._-]+$/.test(p) && !/^\.+$/.test(p));
}

export default async function handler(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(503, { error: 'CRON_SECRET is not set' });

  const auth = String(request.headers.get(SECRET_HEADER) || '').replace(/^Bearer\s+/i, '').trim();
  if (!safeEqual(auth, secret)) return json(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  const want = String(url.searchParams.get('sha') || '').trim().toLowerCase();
  if (!isSafeId(id)) return json(400, { error: 'bad_id' });
  if (want && !/^[0-9a-f]{64}$/.test(want)) return json(400, { error: 'bad_sha' });

  const token = await resolveOidc(request);
  if (!token) return json(503, { error: 'no Vercel OIDC token' });

  let upstream;
  try {
    upstream = await fetch(`https://skills.sh/api/v1/skills/${id.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch (err) {
    return json(502, { error: `upstream_fetch_failed: ${err?.message || err}` });
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json(upstream.status, { error: `upstream_${upstream.status}`, detail: String(detail).slice(0, 200) });
  }

  const data = await upstream.json().catch(() => null);
  const file = pickSkillFile(data?.files);
  const contents = typeof file?.contents === 'string' ? file.contents : '';
  if (!contents) return json(404, { error: 'no_body' });

  const sha = createHash('sha256').update(contents).digest('hex');
  if (want && want !== sha) return json(502, { error: 'body_sha_mismatch', sha });

  return new Response(contents, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      'x-body-sha256': sha,
      'x-body-path': String(file?.path || ''),
      'x-body-bytes': String(Buffer.byteLength(contents)),
    },
  });
}
