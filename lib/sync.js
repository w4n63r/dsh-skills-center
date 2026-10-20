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

/** 直连 fetch；网络层失败（DNS/代理/超时）才回退 curl，HTTP 状态码失败不回退。 */
async function readHttp(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return { ok: false, reason: `too_large: ${declared}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, reason: `too_large: ${bytes.length}` };
    return { ok: true, bytes, via: 'fetch' };
  } catch (error) {
    const curl = await curlGet(url, timeoutMs);
    if (curl.ok) return { ...curl, fetchError: message(error) };
    return { ok: false, reason: `fetch_failed: ${message(error)}; curl_failed: ${curl.reason}` };
  }
}

async function curlGet(url, timeoutMs) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  try {
    const { stdout } = await run(
      'curl',
      ['-fsSL', '--max-time', String(seconds), '-H', 'accept: application/json', url],
      { maxBuffer: MAX_BYTES, encoding: 'buffer' },
    );
    const bytes = Buffer.from(stdout);
    return { ok: true, bytes, via: 'curl' };
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
  const source = String(options.url || process.env[URL_ENV] || '').trim();
  const elapsed = () => Date.now() - startedAt;

  if (!source) {
    return { ok: false, reason: 'no_url', source: null, via: null, elapsedMs: elapsed() };
  }

  const pulled = await readSource(source, { timeoutMs });
  if (!pulled.ok) {
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
  const previous = await readSyncMeta();
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
    syncedAt,
    file: SYNC_CATALOG,
    previous: previous ? { version: previous.version ?? null, count: previous.count ?? null, syncedAt: previous.syncedAt ?? null } : null,
    elapsedMs: elapsed(),
  };
}
