// 远端目录同步：把采集端（Vercel /api/collect → Blob）产出的 catalog.json 拉到本地。
//
// 设计取舍：
// - 只认「一个 JSON 文件」这一个契约，采集端怎么算分数、怎么聚类都与这里无关。
// - 先校验再落盘，校验不过就保持旧目录不动（宁可旧，不可坏）。
// - 写入走「同目录临时文件 + rename」，GUI 正在读也不会读到半个文件。
// - Node 自带 fetch 不走系统代理；本机 skills.sh 解析到 fake-ip 时直连会失败，
//   所以网络失败后回退到 curl 子进程（curl 走系统代理，HANDOFF §5）。
// - 来源可以是 http(s)、本地文件路径或 file:// URL：离线用手上的采集产物验证同一条代码路径。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CENTER_HOME } from './paths.js';

const run = promisify(execFile);

/** 同步目录：CATALOG_CANDIDATES 第一位，同步产物直接覆盖样例数据。 */
export const SYNC_DIR = join(CENTER_HOME, 'catalog');
export const SYNC_CATALOG = join(SYNC_DIR, 'catalog.json');
export const SYNC_META = join(SYNC_DIR, 'meta.json');
export const SYNC_PREV = join(SYNC_DIR, 'catalog.prev.json');

/** 上限：全量目录按 8 千条估不到 20MB，64MB 足够挡住下错的东西。 */
export const MAX_BYTES = 64 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
/** 远端目录地址的环境变量名；工具参数 url 优先级更高。 */
export const SYNC_URL_ENV = 'DSH_SKILLS_CENTER_CATALOG_URL';
// 默认地址是插件自己托管的稳定入口（302 到 Blob 上的 catalog-latest.json），
// 换 store 或改部署域名时只需要换这一行，用户不用改环境变量。
export const DEFAULT_CATALOG_URL = 'https://dsh-skills-center.vercel.app/api/catalog';
const URL_ENV = SYNC_URL_ENV;

const message = (error) => String(error && error.message ? error.message : error);

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验一份目录 JSON。只挡「会让插件崩」和「明显不是目录」的东西，
 * 不动业务字段——采集端加什么字段，这边原样存下来。
 */
export function parseCatalog(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not_json: ${message(error)}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'not_object' };
  }
  if (!Array.isArray(data.skills)) {
    return { ok: false, reason: 'no_skills_array' };
  }
  if (data.skills.length === 0) {
    return { ok: false, reason: 'empty_skills' };
  }
  for (let i = 0; i < data.skills.length; i += 1) {
    const skill = data.skills[i];
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      return { ok: false, reason: `skill_${i}_not_object` };
    }
    if (typeof skill.id !== 'string' || !skill.id.trim()) {
      return { ok: false, reason: `skill_${i}_missing_id` };
    }
  }
  return {
    ok: true,
    catalog: {
      ...data,
      version: typeof data.version === 'string' ? data.version : null,
      count: data.skills.length,
    },
  };
}

/** 一条字符串来源 → 字节。按 URL / 本地路径分流。 */
async function readSource(source, { timeoutMs }) {
  const value = String(source || '').trim();
  if (!value) return { ok: false, reason: 'no_url' };
  if (/^https?:\/\//i.test(value)) return readHttp(value, timeoutMs);
  const file = value.startsWith('file://') ? fileURLToPath(value) : value;
  try {
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES) return { ok: false, reason: `too_large: ${bytes.length}` };
    return { ok: true, bytes, via: 'file' };
  } catch (error) {
    return { ok: false, reason: `read_failed: ${message(error)}` };
  }
}

/**
 * 直连 fetch；网络层失败（DNS/代理/超时）才回退 curl，HTTP 状态码失败不回退。
 * 带 `etag` 时发条件请求：304 表示远端没变，此时**一个字节都不下载**（Blob 的 304 是 0 字节）。
 */
/** 值得重试的状态：Blob 覆盖写 latest 指针后的传播窗口会返回 404，限流与 5xx 同理。 */
const RETRYABLE = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS = [500, 1500];

async function readHttp(url, timeoutMs, { etag } = {}) {
  const headers = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  try {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(url, {
        redirect: 'follow',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!RETRYABLE.has(response.status) || attempt >= RETRY_DELAYS.length) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
    if (response.status === 304) {
      return { ok: true, unchanged: true, via: 'fetch', url: response.url || url, etag: etag || null };
    }
    if (!response.ok) {
      // 直连拿到 404/5xx 时不能就此认定失败：本机对 Blob 域名会返回 404 "Store not found"，
      // 而 curl（走系统代理）是好的。HTTP 层面失败同样回退一次 curl。
      const curl = await curlGet(url, timeoutMs, { etag });
      if (curl.ok) return { ...curl, fetchStatus: response.status };
      return { ok: false, reason: `http_${response.status}` };
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return { ok: false, reason: `too_large: ${declared}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, reason: `too_large: ${bytes.length}` };
    return {
      ok: true,
      bytes,
      via: 'fetch',
      // 302 之后的最终地址要记住：下次直接打 Blob，不再过 Vercel 函数
      url: response.url || url,
      etag: response.headers.get('etag') || null,
    };
  } catch (error) {
    // 网络层异常（DNS/代理/超时）→ curl
    const curl = await curlGet(url, timeoutMs, { etag });
    if (curl.ok) return { ...curl, fetchError: message(error) };
    return { ok: false, reason: `fetch_failed: ${message(error)}; curl_failed: ${curl.reason}` };
  }
}

/**
 * 便宜的「远端有没有新版」检查：HEAD + If-None-Match。
 * 不下载正文：304 = 就是本地这份；200 = 有新 ETag；没记住 url/etag 时返回 unknown，让调用方先同步一次。
 */
export async function checkForUpdate(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const meta = await readSyncMeta();
  const url = String(options.url || meta?.url || '').trim();
  if (!url || !meta?.etag) {
    return { ok: false, reason: 'no_baseline', checkedAt: new Date().toISOString() };
  }
  try {
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(url, {
        method: 'HEAD',
        headers: { 'if-none-match': meta.etag },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!RETRYABLE.has(response.status) || attempt >= RETRY_DELAYS.length) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
    let remoteEtag = response.headers.get('etag');
    let status = response.status;
    if (RETRYABLE.has(status) || status === 0) {
      // 同 readHttp：直连打不通 Blob 域名时用 curl 再问一次
      const curl = await curlGet(url, timeoutMs, { etag: meta.etag, head: true });
      if (curl.ok) {
        status = curl.unchanged ? 304 : 200;
        remoteEtag = curl.etag || remoteEtag;
      }
    }
    return {
      ok: true,
      updateAvailable: status === 200 && remoteEtag !== meta.etag,
      notModified: status === 304,
      status,
      localVersion: meta.version ?? null,
      etag: remoteEtag || null,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, reason: `check_failed: ${message(error)}`, checkedAt: new Date().toISOString() };
  }
}

/**
 * 解析 `curl -D -` 的输出：最后一个 HTTP 响应块的状态行、头部与正文。
 * 走 -L 时会有多段头部（每一跳一段），只认最后一段。
 */
function parseCurlOutput(buffer) {
  const text = buffer.toString('latin1');
  const marker = text.lastIndexOf('\r\nHTTP/');
  const start = marker >= 0 ? marker + 2 : text.indexOf('HTTP/');
  if (start < 0) return { status: 0, headers: {}, body: buffer };
  const split = text.indexOf('\r\n\r\n', start);
  const headText = split >= 0 ? text.slice(start, split) : text.slice(start);
  const headers = {};
  for (const line of headText.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const status = Number((headText.match(/^HTTP\/[\d.]+\s+(\d{3})/) || [])[1] || 0);
  // 正文是二进制安全的：用 latin1 定位，按字节切
  const bodyStart = split >= 0 ? Buffer.byteLength(text.slice(0, split + 4), 'latin1') : buffer.length;
  return { status, headers, body: buffer.subarray(bodyStart) };
}

/**
 * curl 回退：本机 Node fetch 走直连，访问 *.public.blob.vercel-storage.com 会拿到
 * 404 "Store not found"（fake-ip/代理环境，见 HANDOFF §5）；curl 走系统代理是通的。
 * 所以不仅网络异常要回退，HTTP 层面失败也要回退——还要把 etag 与最终地址带回来。
 */
async function curlGet(url, timeoutMs, { etag, head = false } = {}) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(seconds),
    '-H',
    'accept: application/json',
  ];
  if (etag) args.push('-H', `If-None-Match: ${etag}`);
  if (head) args.push('-I');
  else args.push('-D', '-');
  args.push(url);
  try {
    const { stdout } = await run('curl', args, { maxBuffer: MAX_BYTES, encoding: 'buffer' });
    const parsed = head
      ? { status: Number((stdout.toString('latin1').match(/HTTP\/[\d.]+\s+(\d{3})/) || [])[1] || 0), headers: {} }
      : parseCurlOutput(Buffer.from(stdout));
    if (head) {
      for (const line of stdout.toString('latin1').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon > 0) parsed.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
    if (parsed.status === 304) return { ok: true, unchanged: true, via: 'curl', url, etag: parsed.headers.etag || etag || null };
    if (parsed.status < 200 || parsed.status >= 300) return { ok: false, reason: `curl_http_${parsed.status}` };
    const bytes = parsed.body ?? Buffer.alloc(0);
    if (bytes.length > MAX_BYTES) return { ok: false, reason: `too_large: ${bytes.length}` };
    return { ok: true, bytes, via: 'curl', url, etag: parsed.headers.etag || null };
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
}

export async function readSyncMeta() {
  try {
    return JSON.parse(await readFile(SYNC_META, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 拉一次目录。
 * @param {{url?: string, force?: boolean, timeoutMs?: number}} [options]
 *   url 缺省读 DSH_SKILLS_CENTER_CATALOG_URL；force 为 true 时即使内容没变也重写。
 */
export async function syncCatalog(options = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const source = String(options.url || process.env[URL_ENV] || DEFAULT_CATALOG_URL).trim();
  const elapsed = () => Date.now() - startedAt;

  if (!source) {
    return { ok: false, reason: 'no_url', source: null, via: null, elapsedMs: elapsed() };
  }

  const previous = await readSyncMeta();
  // 上次已经解析出真实地址与 ETag 且来源没变 → 走条件请求（304 就零字节返回）
  const reuse = !options.force && previous?.etag && previous?.url && previous.source === source;
  let pulled = reuse
    ? await readHttp(previous.url, timeoutMs, { etag: previous.etag })
    : await readSource(source, { timeoutMs });

  // 记住的地址失效（Blob 覆盖写指针的那几秒会短暂 404）→ 清基线，同一调用里用入口地址重试一次，
  // 别让用户看到一次无意义的失败。
  if (!pulled.ok && reuse && /http_(403|404|410)/.test(String(pulled.reason))) {
    await writeFile(SYNC_META, `${JSON.stringify({ ...previous, url: null, etag: null }, null, 2)}\n`, 'utf8').catch(() => {});
    pulled = await readSource(source, { timeoutMs });
  }

  if (pulled.ok && pulled.unchanged) {
    return {
      ok: true,
      changed: false,
      unchanged: true,
      reason: 'not_modified',
      source,
      via: pulled.via,
      version: previous.version ?? null,
      count: previous.count ?? null,
      bytes: 0,
      syncedAt: previous.syncedAt ?? null,
      file: SYNC_CATALOG,
      elapsedMs: elapsed(),
    };
  }
  if (!pulled.ok) {
    // 重试也失败：基线已经在上一步清掉了，下一次同步会重新解析入口地址
    return { ok: false, reason: pulled.reason, source, via: null, elapsedMs: elapsed() };
  }

  const sha256 = createHash('sha256').update(pulled.bytes).digest('hex');
  const parsed = parseCatalog(pulled.bytes.toString('utf8'));
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      source,
      via: pulled.via,
      sha256,
      bytes: pulled.bytes.length,
      elapsedMs: elapsed(),
    };
  }

  const catalog = parsed.catalog;
  if (!options.force && previous && previous.sha256 === sha256) {
    return {
      ok: true,
      changed: false,
      reason: 'unchanged',
      source,
      via: pulled.via,
      version: catalog.version,
      count: catalog.count,
      sha256,
      bytes: pulled.bytes.length,
      syncedAt: previous.syncedAt ?? null,
      file: SYNC_CATALOG,
      elapsedMs: elapsed(),
    };
  }

  await mkdir(SYNC_DIR, { recursive: true });
  const hadPreviousFile = await fileExists(SYNC_CATALOG);
  if (hadPreviousFile) {
    // 旧版留一份：同步来的目录坏了用户还能退回去（catalog.prev.json）。
    await copyFile(SYNC_CATALOG, SYNC_PREV).catch(() => {});
  }
  const temp = join(SYNC_DIR, `catalog.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, pulled.bytes);
  await rename(temp, SYNC_CATALOG);

  const syncedAt = new Date().toISOString();
  const meta = {
    version: catalog.version,
    count: catalog.count,
    sha256,
    bytes: pulled.bytes.length,
    source,
    via: pulled.via,
    // 记住最终地址与 ETag：日常同步靠它们换 304（零字节），检查更新靠它们发 HEAD
    url: pulled.url || (previous?.source === source ? previous.url : null) || null,
    etag: pulled.etag || null,
    syncedAt,
  };
  await writeFile(SYNC_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    changed: true,
    source,
    via: pulled.via,
    version: catalog.version,
    count: catalog.count,
    sha256,
    bytes: pulled.bytes.length,
    url: meta.url,
    etag: meta.etag,
    syncedAt,
    file: SYNC_CATALOG,
    previous: previous ? { version: previous.version ?? null, count: previous.count ?? null, syncedAt: previous.syncedAt ?? null } : null,
    elapsedMs: elapsed(),
  };
}
