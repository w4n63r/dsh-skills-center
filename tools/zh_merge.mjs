#!/usr/bin/env node
// 把各片中文层合并成 data/zh.json（采集端用 JSON import 内联进函数，随采集写进目录）。
//
//   node tools/zh_merge.mjs [--out data/zh.json]
//
// 合并规则：
//   - 每个 data/zh/part-*.json 先各自校验（缺字段/超长/禁用词 → 直接失败，不写文件）
//   - 同一个 id 出现在两片里 → 失败（宁可停下来看，也不静默取后者）
//   - 输出 { generated_at, count, sources:[…], entries:{ [id]:{name_zh,intro,usage,notes,tier} } }
//     tier 原样保留（hand / auto，缺失按 hand），合并阶段没有正文缓存所以不跑 usage 溯源。
//
// 「校验」复用 tools/zh_validate.mjs 的规则，但按合并后的全集跑一遍，避免只验分片、漏掉跨片问题。

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { validateEntry } from './zh_validate.mjs';

const args = { out: 'data/zh.json', dir: 'data/zh', batchDir: 'tmp/zh-batches' };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === '--out') args.out = process.argv[++i];
  else if (key === '--dir') args.dir = process.argv[++i];
  else if (key === '--batches') args.batchDir = process.argv[++i];
  else throw new Error(`unknown arg: ${key}`);
}

const wanted = new Map(); // id -> 所属分片文件名
try {
  // zh_generate plan 写的是 in-<from>-<to>.json，老的批次分片叫 batch-*.json：两种都要认，
  // 否则每跑一批新数据都得手工拷一份，忘了拷就报「不在任何一个输入分片里」。
  const batchFiles = (await readdir(args.batchDir)).filter((f) => /^(batch|in)-.*\.json$/.test(f)).sort();
  for (const file of batchFiles) {
    const batch = JSON.parse(await readFile(join(args.batchDir, file), 'utf8'));
    for (const skill of batch.skills || []) wanted.set(skill.id, file);
  }
} catch (error) {
  console.error(`cannot read batches from ${args.batchDir}: ${error.message}`);
}

const partFiles = (await readdir(args.dir)).filter((f) => /^part-.*\.json$/.test(f)).sort();
if (!partFiles.length) {
  console.error(`no part files in ${args.dir}`);
  process.exit(1);
}

const entries = {};
const sources = [];
const errors = [];
const seenIn = new Map();

for (const file of partFiles) {
  const path = join(args.dir, file);
  let part;
  try {
    part = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    errors.push(`${file}: 不是合法 JSON — ${error.message}`);
    continue;
  }
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    errors.push(`${file}: 顶层必须是 { id: {...} } 对象`);
    continue;
  }
  for (const [id, entry] of Object.entries(part)) {
    if (seenIn.has(id)) {
      errors.push(`${id}: 同时出现在 ${seenIn.get(id)} 和 ${file}`);
      continue;
    }
    seenIn.set(id, file);
    if (!entry || typeof entry !== 'object') {
      errors.push(`${id}: 条目不是对象`);
      continue;
    }
    if (wanted.size && !wanted.has(id)) errors.push(`${id}: 不在任何一个输入分片里`);
    // 结构/长度/禁用词/tier 规则全部来自 tools/zh_validate.mjs；合并阶段没有正文，usage 溯源自动跳过
    const checked = validateEntry(entry, { id });
    for (const message of checked.errors) errors.push(message);
    entries[id] = {
      name_zh: entry.name_zh,
      intro: entry.intro,
      usage: entry.usage,
      notes: entry.notes || '',
      tier: checked.tier,
    };
  }
  sources.push({ file, count: Object.keys(part).length });
}

if (errors.length) {
  console.error(`${errors.length} 个问题，未写 ${args.out}：`);
  for (const line of errors.slice(0, 60)) console.error('  ' + line);
  if (errors.length > 60) console.error(`  …还有 ${errors.length - 60} 条`);
  process.exit(1);
}

const missing = [...wanted.keys()].filter((id) => !(id in entries));
const outPath = resolve(args.out);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  `${JSON.stringify({ generated_at: new Date().toISOString(), count: Object.keys(entries).length, sources, entries }, null, 1)}\n`,
  'utf8',
);

console.log(`wrote ${outPath}: ${Object.keys(entries).length} entries from ${partFiles.length} part(s)`);
if (missing.length) {
  console.log(`注意：分片里有 ${missing.length} 条还没人写（不算错误，合并时缺就是缺）：`);
  for (const id of missing.slice(0, 20)) console.log('  - ' + id);
}
