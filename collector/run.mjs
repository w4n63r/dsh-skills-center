#!/usr/bin/env node
// 全量采集入口：/api/v1 → data/catalog.json
//
//   node collector/run.mjs                       # 需要 VERCEL_OIDC_TOKEN（Vercel 里由平台注入）
//   node collector/run.mjs --enrich 300          # 只给 top 300（并入 curated）抓详情与审计
//   node collector/run.mjs --replay fixture.json # 离线跑同一条代码路径，不联网
//   node collector/run.mjs --stage list          # 只跑第一段，便于在函数时限内分片
//
// 为什么要分「目录层」和「详情层」：列表接口一次就能给 8420 条（17 个请求），但 hash、
// 正文、审计要逐条打 detail+audit。全量 8420 条 = 1.7 万个请求，既超时限也没必要——
// 真正需要中文卡片与红旗判断的只有头部。所以：全量只做目录，头部做详情。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient, mapLimit, PER_PAGE, MIN_INTERVAL_MS } from './fetch.mjs';
import { buildCatalog, normalizeRecord } from './pipeline.mjs';

function parseArgs(argv) {
  const args = { out: 'data/catalog.json', enrich: 300, concurrency: 4, stage: 'all', view: 'all-time' };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--out') args.out = next();
    else if (key === '--enrich') args.enrich = Number(next());
    else if (key === '--concurrency') args.concurrency = Number(next());
    else if (key === '--stage') args.stage = next();
    else if (key === '--view') args.view = next();
    else if (key === '--replay') args.replay = next();
    else if (key === '--verbose') args.verbose = true;
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`unknown arg: ${key}`);
  }
  return args;
}

const log = (msg) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** 预聚类：详情还没抓，先用 slug 归并同名技能，避免 fork 挤占 top 名额。 */
function preCluster(records) {
  const byKey = new Map();
  for (const rec of records) {
    const key = `${rec.slug}|${(rec.name || '').toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rec);
  }
  const clusters = [...byKey.values()].map((members) => {
    members.sort((a, b) => b.installs - a.installs);
    return { lead: members[0], members, merged: members.reduce((s, m) => s + m.installs, 0) };
  });
  clusters.sort((a, b) => b.merged - a.merged);
  return clusters;
}

async function loadReplay(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    let body = {};
    if (u.pathname === '/api/v1/skills') {
      const page = Number(u.searchParams.get('page') || 1);
      const per = Number(u.searchParams.get('per_page') || PER_PAGE);
      const slice = (raw.list || []).slice((page - 1) * per, page * per);
      body = { skills: slice, total: (raw.list || []).length };
    } else if (u.pathname === '/api/v1/skills/curated') {
      body = { skills: raw.curated || [] };
    } else if (u.pathname.startsWith('/api/v1/skills/audit/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/v1/skills/audit/'.length));
      body = (raw.audits || {})[id] || {};
    } else if (u.pathname.startsWith('/api/v1/skills/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/v1/skills/'.length));
      body = (raw.details || {})[id] || {};
    }
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** detail + audit 的返回揉成一条记录，字段名对不上就留空，绝不瞎猜。 */
function mergeDetail(record, detail, audit) {
  const files = Array.isArray(detail?.files) ? detail.files : [];
  const skillMd = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path || '')) || files[0];
  const body = typeof skillMd?.contents === 'string' ? skillMd.contents : null;
  return {
    ...record,
    hash: detail?.hash || record.hash || null,
    bodyLength: body ? body.length : null,
    body_excerpt: body ? body.slice(0, 4000) : null,
    file_count: files.length || null,
    audit: audit?.audits?.length ? audit : record.audit,
    weeklyInstalls: detail?.weeklyInstalls || record.weekly_series || null,
    firstSeen: detail?.firstSeen || record.first_seen || null,
    curated: record.curated,
    official: record.official,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      `usage: node collector/run.mjs [--out data/catalog.json] [--enrich 300] [--replay fixture.json] [--stage all|list|enrich] [--view all-time]\n`,
    );
    return;
  }
  const outPath = resolve(args.out);
  const replay = args.replay ? await loadReplay(resolve(args.replay)) : null;
  const token = process.env.VERCEL_OIDC_TOKEN || process.env.SKILLS_API_TOKEN || null;
  if (!replay && !token) {
    throw new Error(
      'VERCEL_OIDC_TOKEN is not set. /api/v1 needs a Vercel OIDC token, which the platform only injects inside a deployment ' +
        '(enable OIDC Federation on the Vercel project). For an offline dry run, use --replay <fixture.json>.',
    );
  }
  const client = createClient({ token, fetchImpl: replay });

  log(`listing ${args.view} …`);
  const listRaw = await client.listAll({
    view: args.view,
    onPage: (p) => log(`  page ${p.page}: +${p.got} (${p.accumulated}${p.total ? `/${p.total}` : ''})`),
  });
  log(`list: ${listRaw.length} records`);

  log('fetching curated …');
  const curatedRaw = await client.curated();
  log(`curated: ${curatedRaw.length} records`);

  const curatedIds = new Set(curatedRaw.map((r) => r.id));
  const records = [...listRaw, ...curatedRaw].map((raw) => normalizeRecord(raw)).filter(Boolean);
  for (const rec of records) rec.curated = curatedIds.has(rec.id) ? true : rec.curated;
  // 列表里已标 curated 的也算
  const catalogStage = buildCatalog(records, { version: `dir-${stamp()}`, generatedAt: new Date().toISOString() });
  log(`directory stage: ${catalogStage.count} entries after dedupe (${catalogStage.deduped} merged)`);

  if (args.stage === 'list') {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(catalogStage, null, 0)}\n`, 'utf8');
    log(`wrote ${outPath} (list-only)`);
    return;
  }

  // 详情层：按「预聚类后的合并安装量」取头部，并强制并入所有 curated
  const clusters = preCluster(records);
  const enrichTargets = new Map();
  for (const cluster of clusters.slice(0, args.enrich)) enrichTargets.set(cluster.lead.id, cluster.lead);
  for (const rec of records) if (rec.curated) enrichTargets.set(rec.id, rec);
  const targets = [...enrichTargets.values()];
  const calls = targets.length * 2;
  log(`enrich: ${targets.length} ids → ~${calls} requests ≈ ${Math.ceil((calls * MIN_INTERVAL_MS) / 1000)}s`);

  const enriched = new Map();
  await mapLimit(targets, args.concurrency, async (rec) => {
    const [detail, audit] = await Promise.all([client.detail(rec.id), client.audit(rec.id).catch(() => null)]);
    enriched.set(rec.id, mergeDetail(rec, detail, audit));
  });
  log(`enrich done: ${enriched.size}/${targets.length} ids (${targets.length - enriched.size} failed, kept list-level data)`);

  const finalRecords = records.map((rec) => enriched.get(rec.id) || rec);
  const catalog = buildCatalog(finalRecords, {
    version: `full-${stamp()}`,
    generatedAt: new Date().toISOString(),
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(catalog, null, 0)}\n`, 'utf8');
  log(
    `wrote ${outPath}: ${catalog.count} entries, ${catalog.deduped} merged, ` +
      `${finalRecords.filter((r) => r.body_length).length} with body, ${catalog.skills.filter((s) => s.flags?.length).length} flagged`,
  );
}

main().catch((err) => {
  process.stderr.write(`collector failed: ${err?.message || err}\n`);
  process.exit(1);
});
