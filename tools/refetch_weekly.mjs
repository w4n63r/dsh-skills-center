#!/usr/bin/env node
// 重抓 8 周安装量序列并修正 trend_pct。
//
// 为什么要重抓：tools/probe_catalog.py 当初用「,」直接 split，把 65310 这种带千分位的数
// 拆成了 65 和 310 两个数，于是 16 个碎片被当成 8 周序列的前后半段——前端趋势全错。
// 真实格式是 aria-label="Weekly installs: 65,310, 62,524, 57,027, 53,625, 48,139, 48,386, 58,939, 52,386"。
//
// 跑法：node tools/refetch_weekly.mjs   → 写 samples/weekly.json
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const ids = JSON.parse(await readFile('samples/digest.json', 'utf8')).map((r) => r.id);
const out = {};

function fetchPage(id) {
  // node 自带 fetch 不走系统代理，这里必须用 curl
  return execFileSync(
    'curl',
    ['-sL', '--max-time', '30', '-A', 'Mozilla/5.0', `https://www.skills.sh/${id}`],
    { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 },
  );
}

/** 'Weekly installs: 65,310, 62,524, …' → [65310, 62524, …]；千分位必须是逗号+三位数。 */
export function parseWeekly(label) {
  const m = label.match(/Weekly installs:\s*(.+)$/);
  if (!m) return [];
  return (m[1].match(/\d{1,3}(?:,\d{3})*|\d+/g) || []).map((n) => Number(n.replace(/,/g, '')));
}

export function trend(series) {
  if (series.length < 4) return null;
  const cut = Math.floor(series.length / 2);
  const first = series.slice(0, cut).reduce((a, b) => a + b, 0);
  const second = series.slice(cut).reduce((a, b) => a + b, 0);
  if (first <= 0) return null;
  return Math.round(((second - first) / first) * 1000) / 10;
}

for (const id of ids) {
  const html = fetchPage(id);
  const label = html.match(/aria-label="(Weekly installs[^"]*)"/)?.[1];
  const series = label ? parseWeekly(label) : [];
  out[id] = {
    series,
    trend_pct: trend(series),
    previous_trend_pct: JSON.parse(await readFile('samples/digest.json', 'utf8')).find((r) => r.id === id)?.trend_pct ?? null,
  };
  process.stderr.write(`${id}: ${series.join(',') || '(none)'} → ${out[id].trend_pct}%\n`);
}

await writeFile('samples/weekly.json', `${JSON.stringify(out, null, 2)}\n`, 'utf8');
process.stderr.write(`wrote samples/weekly.json (${Object.keys(out).length} ids)\n`);
