#!/usr/bin/env node
// 机器生成层：把「还没有中文卡」的技能排好队交给写手/模型回填，再校验、合并进 data/zh/part-N.json。
//
// 子命令：
//   node tools/zh_generate.mjs plan  --catalog <catalog.json> --from 0 --count 50 [--batch 25] [--out tmp/zh-batches]
//   node tools/zh_generate.mjs check --input tmp/zh-batches/in-0-50.json --written tmp/zh-batches/out-0-50.json
//   node tools/zh_generate.mjs apply --input tmp/zh-batches/in-0-50.json --written tmp/zh-batches/out-0-50.json --part data/zh/part-7.json
//
// 分工：
//   plan  只挑素材、不写文案。排序 = 总安装量（installs_merged ?? installs）降序；
//         已经有人工中文卡的（目录里的 zh/name_zh、data/zh/part-*.json 里的 id）直接跳过。
//         正文从 bodies/<sha256>.md 读，取前 3000 字符当 body_excerpt；读不到就是 null。
//         1200 → 3000（2026-10-22）：写手反馈摘录常在目录/开头就断掉，导致 usage 只能复述
//         description；校验用的正文仍是全量（check 自己读 bodies），摘录只影响写手能看到多少。
//   check 校验回填文件 { entries: { <id>: { name_zh, intro, usage, notes, tier } } }，
//         规则全部 import 自 tools/zh_validate.mjs（不复制）；tier 缺省补 auto，非法值报错。
//         回填里多出输入之外的 id、或某条不合格 → 逐条打印并非 0 退出；
//         只是「写少了」（输入里有、回填里没有）默认只提醒，加 --require-all 才当错误。
//   apply 校验通过后合并进 part-N.json：同 id 覆盖（保留 tier），已有键序不动、新键按 id 排序追加，
//         重复执行写出的字节完全一样（幂等）。
//
// 正文缓存：--bodies 指定；不指定就按「目录同级 bodies/ → 上一级 bodies/」找（后者是仓库约定，
// 即 lib/paths.js 的 BODY_CACHE_DIR = ~/.dsh/skills-center/bodies，zh_fetch_bodies.mjs 也写这里）。
// 没有正文缓存时 check 不做 usage 溯源（skipped_no_body），不算失败。

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverBodyContext, makeBodyReader, validateEntry } from './zh_validate.mjs';

const USAGE = `usage:
  node tools/zh_generate.mjs plan  --catalog <catalog.json> [--bodies <dir>] --from <n> --count <m> [--batch 25] [--out tmp/zh-batches] [--parts data/zh]
  node tools/zh_generate.mjs check --input <in.json> --written <out.json> [--catalog <catalog.json>] [--bodies <dir>] [--require-all]
  node tools/zh_generate.mjs apply --input <in.json> --written <out.json> --part <part-N.json> [--catalog <catalog.json>] [--bodies <dir>] [--require-all]`;

const PLAN_FLAGS = { catalog: null, bodies: null, from: '0', count: null, batch: null, out: 'tmp/zh-batches', parts: 'data/zh' };
const CHECK_FLAGS = { input: null, written: null, catalog: null, bodies: null, 'require-all': false };
const APPLY_FLAGS = { input: null, written: null, part: null, catalog: null, bodies: null, 'require-all': false };

function parseFlags(argv, spec) {
  const out = { ...spec };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected arg: ${key}`);
    const name = key.slice(2);
    if (!Object.prototype.hasOwnProperty.call(out, name)) throw new Error(`unknown arg: ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

function toCount(value, name, { min = 0, fallback = null } = {}) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} 必须是不小于 ${min} 的整数，收到 ${JSON.stringify(value)}`);
  return n;
}

export const totalInstalls = (skill) => Number(skill?.installs_merged ?? skill?.installs ?? 0) || 0;

export function sortByInstalls(skills) {
  return [...skills].sort((a, b) => totalInstalls(b) - totalInstalls(a) || String(a.id).localeCompare(String(b.id)));
}

// 已经有人工中文卡的 id：目录里的 zh/name_zh + data/zh/part-*.json
export async function collectExistingIds({ partsDir = 'data/zh', skills = [] } = {}) {
  const ids = new Set();
  for (const skill of skills) {
    if (skill?.zh?.name_zh || skill?.name_zh) ids.add(skill.id);
  }
  const dir = resolve(partsDir);
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => /^part-.*\.json$/.test(f)).sort();
  } catch {
    return ids;
  }
  for (const file of files) {
    try {
      const part = JSON.parse(await readFile(join(dir, file), 'utf8'));
      for (const id of Object.keys(part)) ids.add(id);
    } catch (error) {
      console.error(`注意：${join(dir, file)} 读不了，plan 当它里面没有中文卡 — ${error.message}`);
    }
  }
  return ids;
}

export function buildPlanRows(slice, { bodyBase = null, bodies = new Map() } = {}) {
  return slice.map((skill) => {
    const sha = skill?.body?.sha256 || null;
    const body = sha ? bodies.get(skill.id) ?? null : null;
    return {
      id: skill.id,
      name: skill.name || skill.slug || skill.id,
      source: skill.source ?? null,
      installs: skill.installs ?? null,
      total_installs: totalInstalls(skill),
      description_en: skill.description_en ?? null,
      body_url: bodyBase && sha ? `${String(bodyBase).replace(/\/$/, '')}/${sha}.md` : null,
      body_excerpt: body ? body.slice(0, 3000) : null,
    };
  });
}

export async function plan(argv) {
  const opts = parseFlags(argv, PLAN_FLAGS);
  if (!opts.catalog) {
    console.error(USAGE);
    console.error('plan 必须给 --catalog <path>');
    return 2;
  }
  const from = toCount(opts.from, '--from', { min: 0, fallback: 0 });
  const count = toCount(opts.count, '--count', { min: 0, fallback: null });
  const batch = toCount(opts.batch, '--batch', { min: 1, fallback: null });

  const catalogPath = resolve(opts.catalog);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  if (!skills.length) {
    console.error(`${catalogPath}: 没有 skills`);
    return 1;
  }

  const have = await collectExistingIds({ partsDir: opts.parts, skills });
  const eligible = sortByInstalls(skills.filter((s) => !have.has(s.id)));
  const total = eligible.length;
  const slice = eligible.slice(from, count == null ? undefined : from + count);
  if (!slice.length) {
    console.error(`没有可生成的条目：目录 ${skills.length} 条，已有中文卡 ${have.size} 条，待生成 ${total} 条，--from ${from} 越界`);
    return 1;
  }

  const context = await discoverBodyContext({ catalogPath });
  // --bodies 显式指定时用它：插件把正文缓存在 skills-center/bodies，目录却在 skills-center/catalog/ 下，两者不是兄弟目录。
  const bodiesDir = opts.bodies ? resolve(opts.bodies) : context.bodiesDir;
  const reader = makeBodyReader({ bodiesDir, bodyHashes: context.bodyHashes });
  const bodies = new Map();
  for (const skill of slice) bodies.set(skill.id, await reader(skill.id));
  if (!existsSync(bodiesDir)) {
    console.error(`注意：没有正文缓存 ${bodiesDir}，body_excerpt 全部为 null（正文地址仍在 body_url 里）`);
  }

  const outDir = resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  const chunkSize = batch || slice.length;
  const files = [];
  for (let i = 0; i < slice.length; i += chunkSize) {
    const chunk = slice.slice(i, i + chunkSize);
    const start = from + i;
    const end = start + chunk.length;
    const rows = buildPlanRows(chunk, { bodyBase: context.bodyBase, bodies });
    const payload = {
      generated_at: new Date().toISOString(),
      catalog: catalogPath,
      catalog_version: catalog.version ?? null,
      offset: start,
      total,
      count: rows.length,
      skills: rows,
    };
    const path = join(outDir, `in-${start}-${end}.json`);
    await writeFile(path, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
    const withBody = rows.filter((r) => r.body_excerpt).length;
    console.log(`wrote ${path}: ${rows.length} 条（${withBody} 条带正文摘录）`);
    files.push({ path, offset: start, count: rows.length, with_body: withBody });
  }
  console.log(
    `plan：目录 ${skills.length} 条，跳过已有中文卡 ${skills.length - total} 行（已知 id ${have.size} 个），待生成 ${total} 条，本次 ${slice.length} 条 → ${files.length} 个文件`,
  );
  return 0;
}

// 回填文件 → 校验结果（check 与 apply 共用）
export async function checkWritten({ input, written, context = {}, requireAll = false }) {
  const wanted = new Set((input.skills || []).map((s) => s.id));
  const errors = [];
  const normalized = {};
  const tierCounts = { hand: 0, auto: 0 };
  const skippedNoBody = [];
  const missing = [...wanted].filter((id) => !written?.entries || !(id in written.entries));

  if (!written || typeof written !== 'object' || Array.isArray(written) || !written.entries || typeof written.entries !== 'object' || Array.isArray(written.entries)) {
    errors.push('回填文件形状必须是 { entries: { "<id>": { name_zh, intro, usage, notes, tier } } }');
    return { ok: false, errors, normalized, missing, skipped_no_body: skippedNoBody, tierCounts, wantedCount: wanted.size };
  }

  const readBody = makeBodyReader({ bodiesDir: context.bodiesDir ?? null, bodyHashes: context.bodyHashes ?? null });

  for (const [id, raw] of Object.entries(written.entries)) {
    if (!wanted.has(id)) {
      errors.push(`${id}: 不在输入文件里（输入共 ${wanted.size} 条）`);
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${id}: 条目不是对象`);
      continue;
    }
    const entry = {
      name_zh: raw.name_zh,
      intro: raw.intro,
      usage: raw.usage,
      notes: raw.notes ?? '',
      tier: raw.tier == null || raw.tier === '' ? 'auto' : raw.tier,
    };
    const result = validateEntry(entry, { id, body: await readBody(id) });
    errors.push(...result.errors);
    if (result.skipped_no_body) skippedNoBody.push(id);
    if (result.ok) {
      normalized[id] = { name_zh: entry.name_zh, intro: entry.intro, usage: entry.usage, notes: entry.notes, tier: result.tier };
      tierCounts[result.tier] += 1;
    }
  }

  if (requireAll) for (const id of missing) errors.push(`${id}: 输入里有、回填文件里没有`);

  return { ok: errors.length === 0, errors, normalized, missing, skipped_no_body: skippedNoBody, tierCounts, wantedCount: wanted.size };
}

async function loadInput(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

// catalog / bodies 来源：--catalog、--bodies 优先，其次输入文件里 plan 记下的 catalog
async function bodyContext(opts, input) {
  const catalogPath = opts.catalog || input?.catalog || null;
  const context = await discoverBodyContext({ catalogPath });
  const bodiesDir = opts.bodies ? resolve(opts.bodies) : context.bodiesDir;
  return { ...context, bodiesDir };
}

function reportContext(bodiesDir) {
  if (bodiesDir && !existsSync(bodiesDir)) {
    console.error(`注意：没有正文缓存 ${bodiesDir}，跳过 usage 溯源检查（skipped_no_body，不算失败）`);
  }
}

export async function check(argv) {
  const opts = parseFlags(argv, CHECK_FLAGS);
  if (!opts.input || !opts.written) {
    console.error(USAGE);
    console.error('check 必须给 --input 和 --written');
    return 2;
  }
  const input = await loadInput(opts.input);
  const written = await loadInput(opts.written);
  const context = await bodyContext(opts, input);
  reportContext(context.bodiesDir);

  const result = await checkWritten({ input, written, context, requireAll: Boolean(opts['require-all']) });
  if (!result.ok) {
    console.error(`${result.errors.length} 个问题：`);
    for (const line of result.errors) console.error('  ' + line);
    if (result.missing.length) console.error(`（另有 ${result.missing.length} 条输入里有、回填里没有，未按错误计）`);
    return 1;
  }
  console.log(`check ok — ${Object.keys(result.normalized).length}/${result.wantedCount} 条通过`);
  console.log(`tier：hand ${result.tierCounts.hand} / auto ${result.tierCounts.auto}`);
  if (result.skipped_no_body.length) console.log(`skipped_no_body：${result.skipped_no_body.length} 条没有正文，未做 usage 溯源`);
  if (result.missing.length) {
    console.log(`注意：输入里有 ${result.missing.length} 条没写（不算失败，apply 只合并写好的）：`);
    for (const id of result.missing.slice(0, 20)) console.log('  - ' + id);
    if (result.missing.length > 20) console.log(`  …还有 ${result.missing.length - 20} 条`);
  }
  return 0;
}

const entryKey = (entry) => JSON.stringify([entry.name_zh, entry.intro, entry.usage, entry.notes ?? '', entry.tier ?? 'hand']);

export async function apply(argv) {
  const opts = parseFlags(argv, APPLY_FLAGS);
  if (!opts.input || !opts.written || !opts.part) {
    console.error(USAGE);
    console.error('apply 必须给 --input、--written 和 --part');
    return 2;
  }
  const input = await loadInput(opts.input);
  const written = await loadInput(opts.written);
  const context = await bodyContext(opts, input);
  reportContext(context.bodiesDir);

  const result = await checkWritten({ input, written, context, requireAll: Boolean(opts['require-all']) });
  if (!result.ok) {
    console.error(`${result.errors.length} 个问题，未写 ${opts.part}：`);
    for (const line of result.errors) console.error('  ' + line);
    return 1;
  }

  const partPath = resolve(opts.part);
  let part = {};
  let existed = true;
  try {
    part = JSON.parse(await readFile(partPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existed = false;
  }
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    console.error(`${partPath}: 顶层必须是 { id: {...} } 对象`);
    return 1;
  }

  // 幂等：已有键保持原顺序（覆盖的也留在原位），新键按 id 排序追加
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const merged = {};
  for (const id of Object.keys(part)) {
    const before = part[id];
    if (!(id in result.normalized)) {
      merged[id] = before;
      continue;
    }
    const entry = result.normalized[id];
    if (entryKey(before) === entryKey(entry)) unchanged += 1;
    else updated += 1;
    merged[id] = entry;
  }
  const fresh = Object.keys(result.normalized).filter((id) => !(id in part)).sort();
  for (const id of fresh) {
    merged[id] = result.normalized[id];
    added += 1;
  }

  await mkdir(dirname(partPath), { recursive: true });
  await writeFile(partPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(
    `apply: ${partPath} 共 ${Object.keys(merged).length} 条（${existed ? '原有文件' : '新建文件'}；新增 ${added}、覆盖 ${updated}、未变 ${unchanged}）`,
  );
  return 0;
}

export async function run(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'plan') return plan(rest);
  if (command === 'check') return check(rest);
  if (command === 'apply') return apply(rest);
  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(String(error?.stack || error));
    process.exitCode = 2;
  }
}
