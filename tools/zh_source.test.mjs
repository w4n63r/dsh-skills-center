// zh_source 的单测：--offset/--limit 分页、总安装量降序、total 与输出字段。
// 只读临时目录里的假目录；条目自带 description_en + trend_pct，脚本不会去抓 detail，
// 再把 globalThis.fetch 换成计数桩，证明整条流程一次网络都没打。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, pickSkills, run } from './zh_source.mjs';

const NAME = 'zh_source';
const dir = await mkdtemp(join(tmpdir(), 'dsc-zh-source-'));
process.env.SKILLS_API_TOKEN = 'test-token-never-used';

try {
  // 装量乱序；两条带 installs_merged（合并 fork 后的总量），排序必须按 merged 走
  const skills = [
    { id: 's/three', slug: 'three', name: 'three', source: 's', installs: 400, installs_merged: 450, trend_pct: 1, description_en: 'three' },
    { id: 's/five', slug: 'five', name: 'five', source: 's', installs: 200, trend_pct: 1, description_en: 'five' },
    { id: 's/one', slug: 'one', name: 'one', source: 's', installs: 1, installs_merged: 900, trend_pct: 1, description_en: 'one' },
    { id: 's/six', slug: 'six', name: 'six', source: 's', installs: 100, trend_pct: 1, description_en: 'six' },
    { id: 's/four', slug: 'four', name: 'four', source: 's', installs: 300, trend_pct: 1, description_en: 'four' },
    { id: 's/two', slug: 'two', name: 'two', source: 's', installs: 500, trend_pct: 1, description_en: 'two' },
  ];
  const catalogPath = join(dir, 'catalog.json');
  await writeFile(catalogPath, `${JSON.stringify({ version: 'test-1', count: skills.length, skills })}\n`, 'utf8');

  // ---- 1) 排序：总安装量降序，installs_merged 优先于 installs ----
  const all = pickSkills(skills, { offset: 0, limit: 300 });
  assert.deepEqual(
    all.picked.map((s) => s.id),
    ['s/one', 's/two', 's/three', 's/four', 's/five', 's/six'],
    'sorted by installs_merged ?? installs, descending',
  );
  assert.equal(all.total, 6, 'total is the whole set, not the page');
  assert.equal(all.offset, 0);
  assert.equal(all.limit, 300);
  assert.equal(skills[0].id, 's/three', 'pickSkills must not mutate the input array');

  // ---- 2) 分页：首/中/尾/越界 ----
  const head = pickSkills(skills, { offset: 0, limit: 2 });
  assert.deepEqual(head.picked.map((s) => s.id), ['s/one', 's/two']);
  const mid = pickSkills(skills, { offset: 2, limit: 2 });
  assert.deepEqual(mid.picked.map((s) => s.id), ['s/three', 's/four']);
  const tail = pickSkills(skills, { offset: 4, limit: 2 });
  assert.deepEqual(tail.picked.map((s) => s.id), ['s/five', 's/six']);
  assert.equal(tail.total, 6, 'total stays the full count on the last page');
  const past = pickSkills(skills, { offset: 10, limit: 2 });
  assert.deepEqual(past.picked, [], 'offset past the end yields an empty page');

  // ---- 3) 参数：默认 --top 300，--limit 是别名且优先 ----
  const defaults = parseArgs([]);
  assert.equal(defaults.top, 300);
  assert.equal(defaults.limit, 300);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.out, 'data/zh-source.json');
  assert.equal(parseArgs(['--top', '10']).limit, 10, '--top still sets the size');
  assert.equal(parseArgs(['--top', '10', '--limit', '4']).limit, 4, '--limit wins over --top');
  assert.equal(parseArgs(['--offset', '7', '--limit', '2']).offset, 7);
  assert.throws(() => parseArgs(['--offset', '-1']), /--offset/);
  assert.throws(() => parseArgs(['--limit', 'abc']), /--limit/);
  assert.throws(() => parseArgs(['--nope']), /unknown arg/);

  // ---- 4) 整条 run()：输出 offset/limit/total，rank 用全集排名，且零网络 ----
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('offline: zh_source test must not hit the network');
  };
  const outPath = join(dir, 'zh-source.json');
  let payload;
  try {
    payload = await run(['--catalog', catalogPath, '--out', outPath, '--offset', '1', '--limit', '2']);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetches, 0, 'no detail/page fetch when the catalog already has description and trend');
  assert.equal(payload.offset, 1);
  assert.equal(payload.limit, 2);
  assert.equal(payload.total, 6);
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.skills.map((s) => s.id), ['s/two', 's/three']);
  assert.equal(payload.skills[0].rank, 2, 'rank counts from the full ordering, not the page');
  assert.equal(payload.skills[1].rank, 3);
  assert.equal(payload.skills[0].installs, 500, 'installs is the merged total');
  assert.equal(payload.skills[0].installs_own, 500);

  const onDisk = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(onDisk.offset, 1);
  assert.equal(onDisk.limit, 2);
  assert.equal(onDisk.total, 6);
  assert.equal(onDisk.count, 2);
  assert.equal(onDisk.catalog_version, 'test-1');

  console.log(`${NAME} ok — 分页/排序/total 正确，--limit 优先于 --top，整条 run() 零网络`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
