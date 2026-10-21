#!/usr/bin/env node
// 中文层规则中心：结构、长度、禁用词、tier，以及「usage 里提到的能力必须能在正文里找到」。
//
// 分片验收（人工 300 条的老用法不变）：
//   node tools/zh_validate.mjs tmp/zh-batches/batch-1.json data/zh/part-1.json
//
// 带正文溯源时（正文缓存在 bodies/<sha256>.md；位置见 resolveBodiesDir，也会自动认 ../bodies）：
//   node tools/zh_validate.mjs in.json part.json --catalog ~/.dsh/skills-center/catalog/catalog.json
//   node tools/zh_validate.mjs in.json part.json --bodies ~/.dsh/skills-center/bodies
//
// 检查项（任何一条不过就退出码 1，并逐条打印）：
//   1. JSON 形状 { id: { name_zh, intro, usage, notes } }
//   2. id 集合与输入分片完全一致（不许多、不许少、不许改名）
//   3. 四个字段都在，且都是字符串
//   4. name_zh 2–10 个字符；intro 60–500 字；usage 20–300 字；notes 0–300 字
//   5. 禁用词（用户明确要求不要的那批营销词）
//   6. intro 里不许留占位符（TODO/TBD/xxx/XXX/示例/待补）
//   7. tier 只能是 hand / auto（缺失按 hand，兼容没有 tier 的旧数据）
//   8. usage 里反引号包住的内容、URL、命令片段必须能在该技能正文里找到；
//      本地读不到正文（bodies/<sha256>.md 不存在）就跳过该条，记进 skipped_no_body，不算失败
//
// 规则以函数导出：validateEntry(entry, context) / validateCatalog(zh, options)。
// tools/zh_generate.mjs 直接 import 这两个函数，不复制规则。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANNED = ['专治', '逼出', '无死角', '一站式', '深度赋能', '赋能', '颠覆', '神器', '王炸', '闭眼入', '碾压', '吊打'];
export const PLACEHOLDERS = ['TODO', 'TBD', 'xxx', 'XXX', '示例', '待补'];
export const FIELDS = ['name_zh', 'intro', 'usage', 'notes'];
export const LENGTH_RULES = {
  name_zh: { min: 2, max: 10 },
  intro: { min: 60, max: 500 },
  usage: { min: 20, max: 300 },
  notes: { min: 0, max: 300 },
};
export const TIERS = ['hand', 'auto'];
export const DEFAULT_TIER = 'hand';
export const DEFAULT_CATALOG_PATH = resolve(homedir(), '.dsh', 'skills-center', 'catalog', 'catalog.json');

export const len = (s) => [...String(s)].length;
export const isSha256 = (s) => /^[0-9a-f]{64}$/i.test(String(s));

// ---- 能力词溯源：usage 里声称的东西，正文里得真出现过 ----

// 认哪些是命令开头（避免把英文散文里的 go / make 之类误判成命令）
const CMD_RUNNERS = [
  'npx', 'pnpx', 'bunx', 'uvx', 'pnpm', 'npm', 'yarn', 'bun', 'deno', 'corepack',
  'pip', 'pip3', 'uv', 'brew', 'cargo', 'rustup', 'go', 'git', 'gh', 'docker',
  'docker-compose', 'kubectl', 'helm', 'terraform', 'make', 'node', 'python', 'python3',
  'curl', 'wget', 'dotnet', 'mvn', 'gradle', 'java', 'codex', 'claude', 'gemini', 'dsh',
];
const CMD_VERBS = new Set([
  'install', 'add', 'uninstall', 'remove', 'rm', 'run', 'exec', 'x', 'dlx', 'ci', 'i',
  'create', 'init', 'new', 'clone', 'push', 'pull', 'fetch', 'checkout', 'commit',
  'build', 'test', 'start', 'dev', 'serve', 'deploy', 'publish', 'pack', 'link',
  'config', 'login', 'logout', 'audit', 'info', 'ls', 'list', 'search', 'view', 'open',
  'update', 'upgrade', 'generate', 'gen', 'apply', 'plan', 'sync', 'use', 'enable', 'disable',
]);
// 这些 runner 后面跟脚本/包路径也算命令（node tools/x.mjs、npx @scope/pkg）
const CMD_OPENERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'node', 'python', 'python3', 'deno', 'bun', 'make', 'uv']);
const CMD_ALT = [...CMD_RUNNERS].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
const CMD_RE = new RegExp(
  `(?:^|[^\\w/-])((?:${CMD_ALT})\\s+[^\\s，。；、,;:：!？?()（）"'\\[\\]]+(?:\\s+[^\\s，。；、,;:：!？?()（）"'\\[\\]]+)?)`,
  'g',
);
const BACKTICK_RE = /`([^`]+)`/g;
const URL_RE = /https?:\/\/[^\s`"'<>()（）【】、，。；]+/g;

export function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function looksLikeCommand(fragment) {
  const tokens = String(fragment).trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const runner = tokens[0].toLowerCase();
  if (!CMD_RUNNERS.includes(runner)) return false;
  const second = tokens[1].toLowerCase();
  if (CMD_VERBS.has(second)) return true;
  return CMD_OPENERS.has(runner) && /[/.@]/.test(tokens[1]);
}

// usage 里所有「需要正文兜底」的片段：反引号内容 / URL / 命令片段
export function extractUsageProbes(usage) {
  const text = String(usage ?? '');
  const probes = [];
  const seen = new Set();
  const add = (kind, raw) => {
    const value = String(raw ?? '').trim().replace(/[.。，,;；:：]+$/, '');
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    probes.push({ kind, text: value });
  };
  for (const match of text.matchAll(URL_RE)) add('url', match[0]);
  for (const match of text.matchAll(BACKTICK_RE)) add('code', match[1]);
  const masked = text.replace(BACKTICK_RE, (full) => ' '.repeat(full.length));
  for (const match of masked.matchAll(CMD_RE)) {
    if (looksLikeCommand(match[1])) add('command', match[1]);
  }
  return probes;
}

// URL 允许用「host+path」的简写命中正文（正文里的链接常带 query，usage 里常省掉）
function probeVariants(probe) {
  const base = normalizeForMatch(probe.text);
  const out = [base];
  if (probe.kind === 'url') {
    const stripped = base.replace(/^https?:\/\//, '');
    out.push(stripped, stripped.replace(/\/$/, ''));
    const match = base.match(/^https?:\/\/([^/?#]+)([^?#]*)/);
    if (match) {
      const hostPath = `${match[1]}${match[2] || ''}`;
      out.push(hostPath, hostPath.replace(/\/$/, ''));
    }
  }
  return out.filter(Boolean);
}

const PROBE_LABEL = {
  code: (text) => `\`${text}\``,
  url: (text) => `URL ${text}`,
  command: (text) => `命令片段 ${text}`,
};

// 返回错误信息数组（不带 id 前缀，调用方用 validateEntry 加）
export function checkUsageTrace(usage, body) {
  const hay = normalizeForMatch(body);
  if (!hay) return [];
  const errors = [];
  for (const probe of extractUsageProbes(usage)) {
    if (probeVariants(probe).some((variant) => hay.includes(variant))) continue;
    errors.push(`usage 里的 ${PROBE_LABEL[probe.kind](probe.text)} 在正文里找不到`);
  }
  return errors;
}

export function normalizeTier(value, fallback = DEFAULT_TIER) {
  if (value == null || value === '') return fallback;
  return TIERS.includes(value) ? value : null;
}

// context: { id?, body? }；body 为字符串时跑 usage 溯源，否则记 skipped_no_body
export function validateEntry(entry, context = {}) {
  const id = context.id ?? null;
  const errors = [];
  const push = (message) => errors.push(id ? `${id}: ${message}` : message);

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { id, ok: false, errors: [...errors, ...(id ? [`${id}: 条目不是对象`] : ['条目不是对象'])], tier: DEFAULT_TIER, skipped_no_body: false };
  }

  const tierValue = normalizeTier(entry.tier, DEFAULT_TIER);
  if (tierValue == null) push(`tier ${JSON.stringify(entry.tier)} 非法（只能是 hand / auto）`);

  for (const key of FIELDS) {
    if (typeof entry[key] !== 'string') push(`${key} 不是字符串`);
  }

  for (const [key, rule] of Object.entries(LENGTH_RULES)) {
    if (typeof entry[key] !== 'string') continue;
    const n = len(entry[key]);
    if (n < rule.min || n > rule.max) push(`${key} 长度 ${n}，要求 ${rule.min}–${rule.max}`);
  }

  if (typeof entry.intro === 'string') {
    for (const word of PLACEHOLDERS) if (entry.intro.includes(word)) push(`intro 含占位符 "${word}"`);
  }
  for (const key of FIELDS) {
    if (typeof entry[key] !== 'string') continue;
    for (const word of BANNED) if (entry[key].includes(word)) push(`${key} 含禁用词 "${word}"`);
  }

  let skippedNoBody = false;
  if (typeof entry.usage === 'string') {
    const body = context.body;
    if (typeof body === 'string' && body.trim()) {
      for (const message of checkUsageTrace(entry.usage, body)) push(message);
    } else {
      skippedNoBody = true;
    }
  }

  return { id, ok: errors.length === 0, errors, tier: tierValue ?? DEFAULT_TIER, skipped_no_body: skippedNoBody };
}

// 从目录挑正文：目录里每条是 body: { length, sha256, v }
export function makeBodyReader({ bodiesDir = null, bodyHashes = null, readBody = null } = {}) {
  const cache = new Map();
  const hashes = bodyHashes instanceof Map ? bodyHashes : new Map(Object.entries(bodyHashes || {}));
  return async function readBodyFor(id) {
    if (typeof readBody === 'function') return readBody(id);
    if (!bodiesDir) return null;
    const sha = hashes.get(id) || (isSha256(id) ? id : null);
    if (!sha) return null;
    if (cache.has(sha)) return cache.get(sha);
    let value = null;
    try {
      value = await readFile(join(bodiesDir, `${sha}.md`), 'utf8');
    } catch {
      value = null;
    }
    cache.set(sha, value);
    return value;
  };
}

// 正文缓存位置（按优先级）：
//   1. <catalog 所在目录>/bodies     — 任务书写的「目录同目录的 bodies/<sha256>.md」
//   2. <catalog 所在目录>/../bodies  — 仓库约定：lib/paths.js 的 BODY_CACHE_DIR = ~/.dsh/skills-center/bodies
//      （tools/zh_fetch_bodies.mjs 默认也写这里）
// 两个都在就先 1；都不在就返回 1 让调用方提示。--bodies 可以显式指路。
export function resolveBodiesDir(catalogPath) {
  const beside = join(dirname(catalogPath), 'bodies');
  const center = join(dirname(dirname(catalogPath)), 'bodies');
  if (existsSync(beside)) return beside;
  if (existsSync(center)) return center;
  return beside;
}

// 读目录，顺手算出正文缓存位置
export async function discoverBodyContext({ catalogPath = null } = {}) {
  const path = resolve(catalogPath || DEFAULT_CATALOG_PATH);
  if (!existsSync(path)) {
    return { catalogPath: path, catalog: null, bodiesDir: join(dirname(path), 'bodies'), bodyHashes: new Map(), bodyBase: null };
  }
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  const bodyHashes = new Map();
  for (const skill of Array.isArray(catalog.skills) ? catalog.skills : []) {
    if (skill?.id && skill?.body?.sha256) bodyHashes.set(skill.id, skill.body.sha256);
  }
  return {
    catalogPath: path,
    catalog,
    bodiesDir: resolveBodiesDir(path),
    bodyHashes,
    bodyBase: catalog.body_base || null,
  };
}

// options:
//   wanted      期望的 id 集合（不传就只验内容，不验集合）
//   strictSet   默认 true：zh 里多出来的 id 报错（输入分片里没有 = 不许自己加）
//   bodiesDir / bodyHashes / readBody  正文来源；都没有就整批 skipped_no_body
export async function validateCatalog(zh, options = {}) {
  const errors = [];
  const skippedNoBody = [];
  const tierCounts = { hand: 0, auto: 0 };

  if (!zh || typeof zh !== 'object' || Array.isArray(zh)) {
    return { ok: false, count: 0, errors: ['中文层顶层必须是 { id: {...} } 对象'], skipped_no_body: [], tierCounts, entries: null };
  }

  const wanted = options.wanted ? new Set(options.wanted) : null;
  const strictSet = options.strictSet !== false;
  const readBody = makeBodyReader({
    bodiesDir: options.bodiesDir ?? null,
    bodyHashes: options.bodyHashes ?? null,
    readBody: options.readBody ?? null,
  });

  for (const [id, entry] of Object.entries(zh)) {
    const body = await readBody(id);
    const result = validateEntry(entry, { id, body });
    errors.push(...result.errors);
    if (result.skipped_no_body) skippedNoBody.push(id);
    tierCounts[result.tier] += 1;
  }

  if (wanted) {
    for (const id of wanted) if (!(id in zh)) errors.push(`${id}: 缺少条目`);
    if (strictSet) {
      for (const id of Object.keys(zh)) if (!wanted.has(id)) errors.push(`${id}: 输入分片里没有这个 id（不许自己加）`);
    }
  }

  return { ok: errors.length === 0, count: Object.keys(zh).length, errors, skipped_no_body: skippedNoBody, tierCounts, entries: zh };
}

// ---- CLI ----

function parseCliArgs(argv) {
  const out = { input: null, part: null, bodies: null, catalog: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--bodies') out.bodies = argv[++i];
    else if (key === '--catalog') out.catalog = argv[++i];
    else if (key.startsWith('--')) throw new Error(`unknown arg: ${key}`);
    else if (!out.input) out.input = key;
    else if (!out.part) out.part = key;
    else throw new Error(`unexpected arg: ${key}`);
  }
  return out;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (!args.input || !args.part) {
    console.error('usage: node tools/zh_validate.mjs <batch.json> <part.json> [--catalog <catalog.json>] [--bodies <dir>]');
    return 2;
  }

  const input = JSON.parse(await readFile(args.input, 'utf8'));
  const wanted = new Set((input.skills || []).map((s) => s.id));

  let part;
  try {
    part = JSON.parse(await readFile(args.part, 'utf8'));
  } catch (error) {
    console.error(`${args.part}: not valid JSON — ${error.message}`);
    return 1;
  }

  const context = args.bodies
    ? { bodiesDir: args.bodies, bodyHashes: (await discoverBodyContext({ catalogPath: args.catalog })).bodyHashes }
    : await discoverBodyContext({ catalogPath: args.catalog });
  if (context.bodiesDir && !existsSync(context.bodiesDir)) {
    console.error(`注意：没有正文缓存 ${context.bodiesDir}，跳过 usage 溯源检查（不算失败）`);
  }

  const result = await validateCatalog(part, {
    wanted,
    bodiesDir: context.bodiesDir,
    bodyHashes: context.bodyHashes,
  });

  if (!result.ok) {
    console.error(`${result.errors.length} 个问题：`);
    for (const line of result.errors) console.error('  ' + line);
    return 1;
  }

  console.log(`ok — ${wanted.size} 条全部通过（${args.part}）`);
  console.log(`tier：hand ${result.tierCounts.hand} / auto ${result.tierCounts.auto}`);
  if (result.skipped_no_body.length) {
    console.log(`skipped_no_body：${result.skipped_no_body.length} 条没有正文，未做 usage 溯源`);
  }
  return 0;
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
