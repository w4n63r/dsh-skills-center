#!/usr/bin/env node
// 采集入口（CLI）：/api/v1 → catalog.json
//
//   node collector/run.mjs                                  # 需要 VERCEL_OIDC_TOKEN / SKILLS_API_TOKEN（Vercel 外拿不到）
//   node collector/run.mjs --replay collector/fixtures/v1-sample.json   # 离线跑同一条代码路径
//   node collector/run.mjs --stage list                      # 只跑目录段（17 个请求，任何套餐都跑得完）
//   node collector/run.mjs --enrich 300 --max-requests 300 --runtime-ms 42000
//
// 线上跑的是 api/collect.js，它调用的也是 collector/collect.mjs，所以 --replay 验证过的就是线上的编排逻辑；
// 唯一差别是 token 从哪来（CLI 读环境变量，函数读 Request 头）。

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collect, DEFAULTS } from './collect.mjs';
import { loadReplayFixture } from './replay.mjs';

function parseArgs(argv) {
  const args = {
    out: 'data/catalog.json',
    enrich: DEFAULTS.enrich,
    concurrency: DEFAULTS.concurrency,
    maxRequests: DEFAULTS.maxRequests,
    maxRuntimeMs: DEFAULTS.maxRuntimeMs,
    stage: 'all',
    view: DEFAULTS.view,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--out') args.out = next();
    else if (key === '--enrich') args.enrich = Number(next());
    else if (key === '--concurrency') args.concurrency = Number(next());
    else if (key === '--max-requests') args.maxRequests = Number(next());
    else if (key === '--runtime-ms') args.maxRuntimeMs = Number(next());
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'usage: node collector/run.mjs [--out data/catalog.json] [--enrich 300] [--max-requests 300] ' +
        '[--runtime-ms 42000] [--concurrency 4] [--stage all|list] [--view all-time] [--replay fixture.json]\n',
    );
    return;
  }

  let fetchImpl = globalThis.fetch;
  let fixtureLabel = null;
  if (args.replay) {
    const { fetchImpl: replayFetch } = await loadReplayFixture(resolve(args.replay));
    fetchImpl = replayFetch;
    fixtureLabel = args.replay;
    log(`replay ${args.replay} (offline; no token needed)`);
  }

  // token 只在 CLI 这一侧读环境变量；函数里必须从 Request 头取（见 api/collect.js）
  const token = process.env.VERCEL_OIDC_TOKEN || process.env.SKILLS_API_TOKEN || null;
  if (!fetchImpl) throw new Error('no fetch available (node >= 18)');
  if (!args.replay && !token) {
    throw new Error(
      'VERCEL_OIDC_TOKEN is not set. /api/v1 needs a Vercel OIDC token, which the platform injects inside a deployment ' +
        '(enable OIDC Federation on the Vercel project, Settings → Security). For an offline dry run use ' +
        '--replay collector/fixtures/v1-sample.json.',
    );
  }

  const { catalog, stats } = await collect({
    fetchImpl,
    token,
    view: args.view,
    enrich: args.enrich,
    concurrency: args.concurrency,
    maxRequests: args.maxRequests,
    maxRuntimeMs: args.maxRuntimeMs,
    stage: args.stage,
    log,
  });

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(catalog, null, 0)}\n`, 'utf8');

  const summary = {
    out: outPath,
    fixture: fixtureLabel,
    version: catalog.version,
    count: catalog.count,
    raw_count: catalog.raw_count,
    deduped: catalog.deduped,
    max_installs: catalog.max_installs,
    requests: stats.requests,
    enrich_targets: stats.enrich_targets,
    with_body: stats.with_body,
    with_hash: stats.with_hash,
    with_audit: stats.with_audit,
    flagged: stats.flagged,
    truncated: stats.truncated,
    truncated_reasons: stats.truncated_reasons,
    elapsed_ms: stats.elapsed_ms,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`collector failed: ${err?.message || err}\n`);
  process.exit(1);
});
