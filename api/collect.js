// Vercel 采集函数：cron 每天打一次，把 skills.sh 全量目录 + 头部详情/审计采下来，写进 Blob。
//
// 三个「线上才会踩」的坑，代码按实测结论写死：
//   1) OIDC token 只在 Request 的 x-vercel-oidc-token 头上（或 @vercel/oidc 的 getVercelOidcToken()，
//      必须在 handler 内调用）。process.env.VERCEL_OIDC_TOKEN 在运行期不被保证 —— 本文件没有一处模块级读它。
//   2) 上游只认 Authorization: Bearer <jwt>，把 x-vercel-oidc-token 当上游鉴权头会 401（见 collector/fetch.mjs）。
//   3) Hobby 函数 60s；列表接口实测每次固定约 7s（per_page=1 也是 7.5s），全量 93036 条 = 187 页。
//      所以目录默认只收「按安装量降序的前 LIMIT_RECORDS=3000 条」（6 页并发 ≈ 8s），
//      详情/审计再按 MAX_REQUESTS / MAX_RUNTIME_MS 两个闸门裁尾，截断原因如实写进响应体。
//   4) 详情/审计很贵（每目标 2 个请求），所以会先把上一版 catalog-latest.json 读回来继承富集结果；
//      只有 refreshEnrich=1 才全部重抓。
//
// 触发鉴权：CRON_SECRET。没设置就直接 503 —— 一个任何人都能触发的采集端点等于开着额度给别人烧。

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { collect, DEFAULTS } from '../collector/collect.mjs';
import { publishCatalog, uploadBodies, validateCatalog } from '../collector/publish.mjs';
import { publishCatalogToGitHub } from '../collector/publish-github.mjs';
import { createHash } from 'node:crypto';

// 中文层：data/zh.json 由 tools/zh_merge.mjs 从各分片合并而来（{ entries: { [id]: {name_zh,intro,usage,notes} } }）。
// 优先走 JSON import（打包器会把它内联进函数），失败再读文件（本地直跑时）。都没有就当空表，不阻塞采集。
async function loadZhLayer() {
  try {
    const mod = await import('../data/zh.json', { with: { type: 'json' } });
    const entries = mod?.default?.entries || mod?.entries || {};
    return entries && typeof entries === 'object' ? entries : {};
  } catch {
    try {
      const text = await readFile(new URL('../data/zh.json', import.meta.url), 'utf8');
      const parsed = JSON.parse(text);
      return parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    } catch {
      return {};
    }
  }
}

export const runtime = 'nodejs';
// 实测这个部署上函数能跑满 300s（Fluid compute 的默认上限）；写 60 会让下面的闸门白白只用到 1/5。
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** 常量时间比较，避免用响应时间探测 secret。长度不同时也走一次比较再返回 false。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    // timingSafeEqual 要求等长：先跟自身比一次消耗掉同样的时间，再返回不等
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** cron 带 Authorization: Bearer $CRON_SECRET；手动跑也可以用 x-cron-secret。导出仅为测试。 */
export function isAuthorized(request, secret) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = request.headers.get('x-cron-secret') || '';
  return safeEqual(bearer, secret) || safeEqual(header, secret);
}

/**
 * 取上游所需的 OIDC token。正确渠道只有两个，都在 handler 内：
 *   ① 平台注入到 Request 的 x-vercel-oidc-token 头
 *   ② `@vercel/oidc` 的 getVercelOidcToken()
 * 都不要碰 process.env.VERCEL_OIDC_TOKEN（运行期不被保证）。
 * 导出仅为测试。
 */
export async function resolveOidcToken(request) {
  const fromHeader = request.headers.get('x-vercel-oidc-token');
  if (fromHeader) return { token: fromHeader.trim(), source: 'x-vercel-oidc-token header' };
  try {
    const mod = await import('@vercel/oidc');
    const token = await mod.getVercelOidcToken();
    if (token) return { token, source: '@vercel/oidc getVercelOidcToken()' };
  } catch (err) {
    return { token: null, source: null, why: `getVercelOidcToken() unavailable: ${err?.message || err}` };
  }
  return { token: null, source: null, why: 'no x-vercel-oidc-token header and getVercelOidcToken() returned nothing' };
}

/**
 * 依赖注入点：生产路径全部走默认值；测试用它把「拿 token」「加载 @vercel/blob」换成桩，
 * 否则本机有缓存的 OIDC token 时，这些分支根本走不到（测了个假绿）。
 */
export function makeHandler(overrides = {}) {
  return {
    GET: (request) => run(request, 'cron-or-manual-get', overrides),
    POST: (request) => run(request, 'manual-post', overrides),
  };
}

async function run(request, trigger, { resolveToken = resolveOidcToken, loadBlob = null } = {}) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const elapsed = () => Date.now() - startedAt;
  let stage = 'auth';
  let tokenSource = null;
  let stats = null;

  const fail = (status, error, extra = {}) => {
    // 失败绝不静默：带上 stage、耗时、以及已经跑出来的统计
    console.error(`[collect] stage=${stage} status=${status} ${elapsed()}ms error=${error}`);
    return json(status, {
      ok: false,
      stage,
      error,
      trigger,
      oidc_token_source: tokenSource,
      elapsed_ms: elapsed(),
      stats,
      ...extra,
    });
  };

  try {
    // ---- 1) 触发鉴权 ----
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      stage = 'config';
      return fail(503, 'CRON_SECRET is not set — refusing to run an unauthenticated collection endpoint', {
        fix: 'Add CRON_SECRET in Vercel → Settings → Environment Variables (any long random string), then redeploy.',
      });
    }
    stage = 'auth';
    if (!isAuthorized(request, secret)) {
      return fail(401, 'unauthorized: send "Authorization: Bearer <CRON_SECRET>" or "x-cron-secret: <CRON_SECRET>"');
    }

    // ---- 2) 参数：查询串覆盖环境变量，便于手动补跑 ----
    const pick = (name, fallback) => {
      const raw = url.searchParams.get(name);
      if (raw == null || raw === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    const options = {
      limitRecords: pick('limit', envInt('LIMIT_RECORDS', DEFAULTS.limitRecords)),
      listConcurrency: pick('listConcurrency', envInt('LIST_CONCURRENCY', DEFAULTS.listConcurrency)),
      enrich: pick('enrich', envInt('TOP_N', DEFAULTS.enrich)),
      concurrency: pick('concurrency', envInt('CONCURRENCY', DEFAULTS.concurrency)),
      maxRequests: pick('maxRequests', envInt('MAX_REQUESTS', DEFAULTS.maxRequests)),
      maxRuntimeMs: pick('runtimeMs', envInt('MAX_RUNTIME_MS', DEFAULTS.maxRuntimeMs)),
      view: url.searchParams.get('view') || process.env.SKILLS_VIEW || DEFAULTS.view,
      stage: url.searchParams.get('stage') === 'list' ? 'list' : 'all',
      refreshEnrich: url.searchParams.get('refreshEnrich') === '1',
      // 趋势只能从技能页 HTML 抓（/api/v1 不返回 weeklyInstalls），每个目标多 1 个请求；
      // 想省额度就传 trend=0，代价是这一维全空。
      fetchTrend: url.searchParams.get('trend') !== '0' && process.env.FETCH_TREND !== '0',
    };
    const dry = url.searchParams.get('dry') === '1';
    const prefix = process.env.BLOB_PREFIX || 'catalog';
    const access = process.env.BLOB_ACCESS || 'public';

    // ---- 3) 取 OIDC token（handler 内）----
    stage = 'token';
    const { token, source, why } = await resolveToken(request);
    tokenSource = source;
    if (!token) {
      return fail(500, `no Vercel OIDC token: ${why}`, {
        fix: 'Vercel project → Settings → Security → enable "OIDC Federation", then redeploy.',
      });
    }

    // ---- 3.5) 读回上一版目录，继承已经抓过的详情/审计（每个目标省 2 个请求）----
    // 失败不致命：拿不到就当成第一次跑，只是这一轮要多花请求。但要在响应里说清楚。
    let blob = null;
    let previousSkills = null;
    let previousCatalog = null;
    let previousInfo = { url: null, version: null, count: 0, error: null };
    stage = 'previous';
    const importBlob = loadBlob || (() => import('@vercel/blob'));
    try {
      blob = await importBlob();
      const { blobs } = await blob.list({ prefix: `${prefix}-latest.json`, limit: 1 });
      const target = blobs?.[0];
      if (target?.url) {
        const res = await fetch(target.url, { cache: 'no-store' });
        if (res.ok) {
          const prev = await res.json();
          if (Array.isArray(prev?.skills)) {
            previousSkills = prev.skills;
            previousCatalog = prev;
            previousInfo = { url: target.url, version: prev.version || null, count: prev.skills.length, error: null };
          } else {
            previousInfo = { url: target.url, version: prev?.version || null, count: 0, error: 'previous catalog has no skills[]' };
          }
        } else {
          previousInfo = { url: target.url, version: null, count: 0, error: `GET previous catalog ${res.status}` };
        }
      }
    } catch (err) {
      previousInfo = { url: null, version: null, count: 0, error: `previous catalog unavailable: ${err?.message || err}` };
    }
    console.log(`[collect] previous: ${previousInfo.count} skills${previousInfo.error ? ` (${previousInfo.error})` : ''}`);

    // ---- 4) 采集（与 --replay 同一份编排代码）----
    stage = 'collect';
    const zhLayer = await loadZhLayer();
    const zhCount = Object.keys(zhLayer).length;
    console.log(`[collect] zh layer: ${zhCount} entries`);
    const result = await collect({
      fetchImpl: globalThis.fetch,
      token,
      previous: previousSkills,
      zh: zhLayer,
      ...options,
      log: (msg) => console.log(`[collect] ${msg}`),
    });
    const { catalog } = result;
    stats = result.stats;
    console.log(
      `[collect] stage=collect ${elapsed()}ms count=${catalog.count} raw=${catalog.raw_count} ` +
        `requests=${stats.requests.used}/${stats.requests.max} truncated=${stats.truncated}`,
    );

    // ---- 5) 上传前的 schema 自检 ----
    stage = 'validate';
    const check = validateCatalog(catalog);
    if (!check.ok) {
      return fail(500, `catalog failed schema self-check (${check.errors.length} errors); nothing uploaded`, {
        errors: check.errors,
        warnings: check.warnings,
        catalog: check.stats,
      });
    }

    const summary = {
      ok: true,
      trigger,
      oidc_token_source: tokenSource,
      version: catalog.version,
      generated_at: catalog.generated_at,
      count: catalog.count,
      raw_count: catalog.raw_count,
      limit_records: stats.limit_records,
      list_total: stats.list_total,
      previous: previousInfo,
      inherited_enriched: stats.inherited_enriched,
      deduped: catalog.deduped,
      max_installs: catalog.max_installs,
      requests: stats.requests,
      enrich_targets: stats.enrich_targets,
      coverage: stats.coverage ?? { with_body: stats.with_body, with_hash: stats.with_hash, with_audit: stats.with_audit, flagged: stats.flagged },
      body_gate: stats.body_gate ?? null,
      truncated: stats.truncated,
      truncated_reasons: stats.truncated_reasons,
      warnings: check.warnings,
      collect_ms: stats.elapsed_ms,
      elapsed_ms: elapsed(),
    };

    if (dry) return json(200, { ...summary, dry_run: true, uploaded: null });

    // ---- 6) 版本化文件名 + latest 指针 ----
    stage = 'upload';
    const catalogStats = { version: catalog.version, count: catalog.count, raw_count: catalog.raw_count };
    let put;
    let list;
    let del;
    try {
      const blobApi = blob ? await Promise.resolve(blob) : await importBlob();
      ({ put, list, del } = blobApi);
    } catch (err) {
      return fail(500, `cannot load @vercel/blob (${err?.message || err}) — the deployment must have it in dependencies`, {
        stage_detail: 'import',
        catalog_stats: catalogStats,
      });
    }
    // ---- 5.5) 正文全文先落 Blob（body/<sha256>.md），再让目录声称它已入库 ----
    // 顺序不能反：目录里 body.v 有值就是在说「这份正文取得到」，先把文件传上去才成立。
    const bodies = result.bodies instanceof Map ? result.bodies : new Map();
    const bodyPrefix = process.env.BODY_PREFIX || 'body';
    const wantBodies = url.searchParams.get('bodies') !== '0';
    let bodyUpload = { uploaded: 0, failed: [], errors: [], skipped: !wantBodies || bodies.size === 0 };
    if (!bodyUpload.skipped) {
      bodyUpload = await uploadBodies({
        bodies,
        put,
        prefix: bodyPrefix,
        access,
        log: (msg) => console.log(`[collect] ${msg}`),
      });
      // 上传失败的那些，目录不许声称它有正文：抹掉 v，下一轮自动重抓（绝不留一个取不到的 sha）
      if (bodyUpload.failed.length) {
        const bad = new Set(bodyUpload.failed);
        for (const skill of catalog.skills) {
          if (skill.body?.sha256 && bad.has(skill.body.sha256)) delete skill.body.v;
        }
        console.log(`[collect] bodies: ${bodyUpload.failed.length} failed → those entries stay unmarked`);
      }
    }
    // 正文地址由 sha256 直接拼出来（<base>/<sha256>.md），所以目录只需一个 base：
    // 优先用这一轮 put() 真实返回的 origin，其次沿用上一版目录里的 base，都没有就不写。
    const sampleUrl = bodyUpload.urls?.values?.().next?.().value;
    if (process.env.BODY_BASE) catalog.body_base = process.env.BODY_BASE;
    else if (sampleUrl) catalog.body_base = `${new URL(sampleUrl).origin}/${bodyPrefix}`;
    else if (previousCatalog?.body_base) catalog.body_base = previousCatalog.body_base;

    const published = await publishCatalog({
      catalog,
      put,
      // 传 list/del 才会触发保留策略：只留最近 keep 个版本快照，避免 Blob 存储无限涨
      list,
      del,
      retain: Number(process.env.CATALOG_RETAIN || 14),
      prefix,
      access,
      log: (msg) => console.log(`[collect] ${msg}`),
    });
    // GitHub 是主分发路径（raw CDN + 单提交分支 + 小文件先行），Blob 留作回退。
    // 没配 token 就跳过；失败也只记在响应里——Blob 那份可能还在，不回滚。
    let github = { ok: false, stage: 'skipped', error: 'GH_TOKEN not set' };
    if (process.env.GH_TOKEN) {
      github = await publishCatalogToGitHub({
        catalog,
        token: process.env.GH_TOKEN,
        repo: process.env.GH_REPO || 'w4n63r/dsh-skills-center',
        branch: process.env.GH_BRANCH || 'catalog',
        sha256: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
        log: (msg) => console.log(`[collect] ${msg}`),
      });
      if (!github.ok) console.log(`[collect] github publish failed at ${github.stage}: ${github.error}`);
    }

    if (!published.ok) {
      return fail(500, `blob upload failed: ${(published.errors || []).join('; ')}`, {
        warnings: published.warnings,
        catalog_stats: catalogStats,
      });
    }

    console.log(`[collect] done ${elapsed()}ms → ${published.latest.url}`);
    return json(200, {
      ...summary,
      bodies: { count: bodies.size, uploaded: bodyUpload.uploaded ?? 0, failed: bodyUpload.failed?.length ?? 0, skipped: Boolean(bodyUpload.skipped), base: catalog.body_base || null },
      uploaded: {
        // 主分发路径：GitHub raw（插件默认读这个）
        github: github.ok
          ? { url: github.url, metaUrl: github.metaUrl, commit: github.commit, bytes: github.bytes }
          : { skipped: github.stage === 'skipped', stage: github.stage, error: github.error },
        // 回退路径：Blob（插件在主地址失败时才用）
        versioned: published.versioned,
        latest: published.latest,
      },
      elapsed_ms: elapsed(),
    });
  } catch (err) {
    // 任何未预期的异常都带着 stage 出去，否则线上只能看到 "Internal Server Error"
    return fail(500, `${err?.name || 'Error'}: ${err?.message || err}`, { stack: String(err?.stack || '').split('\n').slice(0, 4) });
  }
}

/** cron 触发（vercel.json 里的 /api/collect）。 */
export async function GET(request) {
  return run(request, 'cron-or-manual-get');
}

/** 手动补跑用；鉴权与环境变量与 GET 完全一致。 */
export async function POST(request) {
  return run(request, 'manual-post');
}
