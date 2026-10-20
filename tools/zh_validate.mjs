#!/usr/bin/env node
// 中文层分片的验收脚本：结构对不上就别合并进目录。
//
//   node tools/zh_validate.mjs tmp/zh-batches/batch-1.json data/zh/part-1.json
//
// 检查项（任何一条不过就退出码 1，并逐条打印）：
//   1. JSON 能解析，形状是 { id: { name_zh, intro, usage, notes } }
//   2. id 集合与输入分片完全一致（不许多、不许少、不许改名）
//   3. 每个 id 的四个字段都在，且都是字符串
//   4. name_zh 2–10 个字符；intro 60–500 字；usage 20–300 字；notes 0–300 字
//   5. 禁用词（用户明确要求不要的那批营销词）
//   6. intro/usage 里不许留占位符（TODO/TBD/xxx/示例）

import { readFile } from 'node:fs/promises';

const BANNED = ['专治', '逼出', '无死角', '一站式', '深度赋能', '赋能', '颠覆', '神器', '王炸', '闭眼入', '碾压', '吊打'];
const PLACEHOLDERS = ['TODO', 'TBD', 'xxx', 'XXX', '示例', '待补'];

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('usage: node tools/zh_validate.mjs <batch.json> <part.json>');
  process.exit(2);
}

const errors = [];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const wanted = new Set((input.skills || []).map((s) => s.id));

let part;
try {
  part = JSON.parse(await readFile(outputPath, 'utf8'));
} catch (error) {
  console.error(`${outputPath}: not valid JSON — ${error.message}`);
  process.exit(1);
}

const len = (s) => [...String(s)].length;

for (const id of wanted) {
  const entry = part[id];
  if (!entry) {
    errors.push(`${id}: 缺少条目`);
    continue;
  }
  for (const key of ['name_zh', 'intro', 'usage', 'notes']) {
    if (typeof entry[key] !== 'string') errors.push(`${id}: ${key} 不是字符串`);
  }
  if (typeof entry.name_zh === 'string') {
    const n = len(entry.name_zh);
    if (n < 2 || n > 10) errors.push(`${id}: name_zh 长度 ${n}，要求 2–10`);
  }
  if (typeof entry.intro === 'string') {
    const n = len(entry.intro);
    if (n < 60 || n > 500) errors.push(`${id}: intro 长度 ${n}，要求 60–500`);
    for (const word of PLACEHOLDERS) if (entry.intro.includes(word)) errors.push(`${id}: intro 含占位符 "${word}"`);
    for (const word of BANNED) if (entry.intro.includes(word)) errors.push(`${id}: intro 含禁用词 "${word}"`);
  }
  if (typeof entry.usage === 'string') {
    const n = len(entry.usage);
    if (n < 20 || n > 300) errors.push(`${id}: usage 长度 ${n}，要求 20–300`);
    for (const word of BANNED) if (entry.usage.includes(word)) errors.push(`${id}: usage 含禁用词 "${word}"`);
  }
  if (typeof entry.notes === 'string') {
    const n = len(entry.notes);
    if (n > 300) errors.push(`${id}: notes 长度 ${n}，要求 ≤300`);
    for (const word of BANNED) if (entry.notes.includes(word)) errors.push(`${id}: notes 含禁用词 "${word}"`);
  }
  for (const word of BANNED) if (typeof entry.name_zh === 'string' && entry.name_zh.includes(word)) errors.push(`${id}: name_zh 含禁用词 "${word}"`);
}

for (const id of Object.keys(part)) {
  if (!wanted.has(id)) errors.push(`${id}: 输入分片里没有这个 id（不许自己加）`);
}

if (errors.length) {
  console.error(`${errors.length} 个问题：`);
  for (const line of errors) console.error('  ' + line);
  process.exit(1);
}
console.log(`ok — ${wanted.size} 条全部通过（${outputPath}）`);
