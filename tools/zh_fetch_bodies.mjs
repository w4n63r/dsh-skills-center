#!/usr/bin/env node
// 把技能正文抓到本地缓存（`$DSH_HOME/skills-center/bodies/<sha256>.md`），给中文层写手当素材用。
// 正文按内容寻址：目录条目只带 body.sha256，正文在 body_base/<sha256>.md；缓存和插件面板共用同一份。
//
// usage:
//   node tools/zh_fetch_bodies.mjs [--catalog <path>] [--zh data/zh.json] [--from 0] [--count 25]
//                                  [--concurrency 6] [--out <cacheDir>]
//
// 默认按总安装量（installs_merged ?? installs）降序、跳过已有中文卡的条目，取 [from, from+count) 抓。
// 抓不到不抛：计入 failed 并把 sha 打出来，退出码仍为 0（写手据此决定跳过哪几条）。

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const CENTER = join(DSH_HOME, 'skills-center');
const DEFAULT_CATALOG = join(CENTER, 'catalog', 'catalog.json');
const DEFAULT_OUT = join(CENTER, 'bodies');
const DEFAULT_BASE = 'https://raw.githubusercontent.com/w4n63r/dsh-skills-center/bodies';

const USAGE = `usage:
  node tools/zh_fetch_bodies.mjs [--catalog <path>] [--zh data/zh.json] [--from 0] [--count 25] [--concurrency 6] [--out <cacheDir>]`;

function parseFlags(argv) {
  const out = { catalog: DEFAULT_CATALOG, zh: 'data/zh.json', from: 0, count: 25, concurrency: 6, out: DEFAULT_OUT, parts: 'data/zh' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected arg: ${key}`);
    const name = key.slice(2);
    if (!Object.prototype.hasOwnProperty.call(out, name)) throw new Error(`unknown arg: ${key}`);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) throw new Error(`${key} 需要一个值`);
    out[name] = name === 'catalog' || name === 'zh' || name === 'out' || name === 'parts' ? next : Number(next);
    i += 1;
  }
  if (!Number.isInteger(out.from) || out.from < 0) throw new Error('--from 必须是不小于 0 的整数');
  if (!Number.isInteger(out.count) || out.count < 0) throw new Error('--count 必须是不小于 0 的整数');
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) throw new Error('--concurrency 必须是不小于 1 的整数');
  return out;
}

async function loadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// 已有中文卡的 id：data/zh.json 的 entries + data/zh/part-*.json 的 entries 都要算。
async function translatedIds({ zhPath, partsDir }) {
  const ids = new Set();
  const zh = await loadJson(zhPath);
  for (const id of Object.keys(zh?.entries ?? {})) ids.add(id);
  let files = [];
  try {
    files = (await readdir(partsDir)).filter((name) => /^part-\d+\.json$/.test(name));
  } catch {
    files = [];
  }
  for (const file of files) {
    const part = await loadJson(join(partsDir, file));
    for (const id of Object.keys(part?.entries ?? {})) ids.add(id);
  }
  return ids;
}

const totalInstalls = (skill) => (Number.isFinite(skill?.installs_merged) ? skill.installs_merged : skill?.installs ?? 0);
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

// 兜底来源：skills.sh 的公开下载接口（60 次/小时/IP）。它给的是同一份 SKILL.md，
// 但必须用目录里的 sha256 验过才收 —— 缓存是内容寻址的，塞错字节比没有更糟。
async function fetchFromSkillsSh(skill) {
  const source = String(skill?.source || '');
  if (!/^[^/]+\/[^/]+$/.test(source)) return null;
  try {
    const res = await fetch(`https://skills.sh/api/download/${source}/${skill.slug}`);
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const md = files.find((f) => /(^|\/)SKILL\.md$/i.test(String(f?.path || ''))) || files[0];
    const contents = typeof md?.contents === 'string' ? md.contents : '';
    if (!contents) return null;
    return sha256Hex(contents) === skill.body.sha256 ? contents : null;
  } catch {
    return null;
  }
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseFlags(argv);
  const catalog = await loadJson(args.catalog);
  if (!catalog || !Array.isArray(catalog.skills)) throw new Error(`读不到目录：${args.catalog}`);
  const base = String(catalog.body_base || '').replace(/\/+$/, '') || DEFAULT_BASE;
  await mkdir(args.out, { recursive: true });
  const done = await translatedIds({ zhPath: args.zh, partsDir: args.parts });

  const queue = catalog.skills
    .filter((skill) => skill?.body?.sha256 && !done.has(skill.id))
    .sort((a, b) => totalInstalls(b) - totalInstalls(a))
    .slice(args.from, args.from + args.count);

  const result = { total: queue.length, cached: 0, skipped: 0, viaSkills: 0, failed: [], bytes: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const skill = queue[cursor++];
      const sha = skill.body.sha256;
      const path = join(args.out, `${sha}.md`);
      if (existsSync(path)) {
        result.skipped += 1;
        continue;
      }
      try {
        let text = null;
        const res = await fetch(`${base}/${sha}.md`);
        if (res.ok) {
          text = await res.text();
        } else {
          // 主存储每轮只补 120 份，缺的那些用 skills.sh 下载接口补；字节对不上 sha256 就不收。
          text = await fetchFromSkillsSh(skill);
          if (text == null) {
            result.failed.push({ id: skill.id, sha, status: res.status });
            continue;
          }
          result.viaSkills += 1;
        }
        await writeFile(path, text, 'utf8');
        result.cached += 1;
        result.bytes += Buffer.byteLength(text);
      } catch (err) {
        result.failed.push({ id: skill.id, sha, error: String(err?.message || err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(queue.length, 1)) }, worker));

  console.log(
    `bodies: ${result.cached} fetched (${result.viaSkills} via skills.sh), ${result.skipped} already cached, ` +
      `${result.failed.length} failed (${result.total} in range, ${(result.bytes / 1024).toFixed(1)}KB) → ${args.out}`,
  );
  for (const item of result.failed.slice(0, 10)) console.log(`  failed ${item.id} ${item.sha.slice(0, 12)} ${item.status ?? item.error}`);
  if (!queue.length) console.log('  范围内没有需要抓的条目（都已有中文卡，或 count 为 0）');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (err) {
    console.error(`${err?.message || err}\n\n${USAGE}`);
    process.exit(1);
  }
}
