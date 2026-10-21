// 冒烟测试：不装 DSH，用假 ctx 走一遍 apply → provider.list/get → 三个工具。
// 运行：node tests/smoke.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = await mkdtemp(join(tmpdir(), 'skills-center-'));
process.env.DSH_HOME = home;

const { apply, name } = await import('../lib/index.js');
const { readActivation, setActive } = await import('../lib/activation.js');
const { MAX_ACTIVE } = await import('../lib/paths.js');
// 必须在 DSH_HOME 设好之后再动态 import：静态 import 会被提升到模块体之前，
// 那些模块在 import 时就按「当时的」HOME 算好了路径，会去读真实用户目录。
const { DEFAULT_CATALOG_URL } = await import('../lib/sync.js');

// ---- 假 ctx：只实现 apply 用到的那几个面 ----
const captured = { providerFactory: null, tools: new Map(), disposed: 0, routes: [] };
const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => {
      captured.disposed += 1;
      dispose?.();
    };
  },
  skills: {
    registerProvider(factory) {
      captured.providerFactory = factory;
      return () => {};
    },
  },
  tools: {
    register(tool) {
      captured.tools.set(tool.name, tool);
      return () => {};
    },
  },
  webServer: {
    register(route) {
      captured.routes.push(route);
      return () => {};
    },
  },
};

apply(ctx, {});

assert.equal(name, 'dsh-skills-center');
assert.ok(captured.providerFactory, 'should register a provider factory');
assert.deepEqual([...captured.tools.keys()].sort(), ['skill_activate', 'skill_card', 'skill_search', 'skill_sync']);
assert.equal(captured.routes.length, 1);

// ---- 库存 fixture：挑一条目录里的技能，造出它的 SKILL.md ----
const { loadCatalog, searchSkills, getSkill, renderCard } = await import('../lib/catalog.js');
const cat = await loadCatalog();
assert.ok(cat.count >= 12, `catalog should hold sample data, got ${cat.count}`);
const skill = cat.skills.find((s) => s.slug === 'frontend-design') ?? cat.skills[0];

const libDir = join(home, 'skills-center', 'library', skill.source, skill.slug);
await mkdir(libDir, { recursive: true });
await writeFile(
  join(libDir, 'SKILL.md'),
  ['---', `name: ${skill.slug}`, 'description: test fixture', '---', '', '# Body', 'fixture body text', ''].join('\n'),
  'utf8',
);

// ---- provider：未激活时 list 为空 ----
let control = { invalidated: 0, invalidate() { this.invalidated += 1; }, signal: undefined };
let provider = captured.providerFactory(control);
assert.equal((await provider.list()).length, 0, 'nothing active → empty list');
assert.equal(await provider.get({ locator: { id: skill.id } }), undefined);

// ---- 激活后出现在 list 里，get 返回去掉 frontmatter 的正文 ----
const act = await setActive(skill.id, true);
assert.ok(act.ok);
const list = await provider.list();
assert.equal(list.length, 1);
const candidate = list[0];
assert.equal(candidate.name, skill.slug);
assert.equal(candidate.provider, 'dsh-skills-center');
assert.equal(candidate.resourceBase.kind, 'directory');
assert.ok(candidate.description.length > 0);

const got = await provider.get(candidate);
assert.ok(got, 'get should resolve the candidate');
assert.equal(got.content, '# Body\nfixture body text\n');
assert.ok(!got.content.includes('description: test fixture'), 'frontmatter must be stripped');

// ---- 照抄 host 的校验器（dsh-skill/lib/index.js:452-464 / :471-490），确认候选真能过 ----
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function hostValidateCandidate(c) {
  assert.equal(typeof c.name, 'string');
  assert.ok(SKILL_NAME.test(c.name), `host would throw: invalid name "${c.name}"`);
  assert.equal(typeof c.description, 'string');
  assert.ok(c.description.length > 0, 'host would throw: empty description');
  assert.equal(typeof c.invocation, 'object');
  assert.equal(typeof c.invocation.modelInvocable, 'boolean');
  assert.equal(typeof c.invocation.userInvocable, 'boolean');
  assert.equal(typeof c.source, 'string');
  assert.equal(typeof c.rank, 'number');
  assert.ok(Number.isFinite(c.rank), 'host would throw: non-finite rank');
  assert.equal(c.provider, 'dsh-skills-center', 'host would throw: provider name mismatch');
  assert.ok(c.path === undefined || typeof c.path === 'string');
}
function hostValidateDefinition(d) {
  assert.ok(SKILL_NAME.test(d.name));
  assert.ok(typeof d.description === 'string' && d.description.length > 0);
  assert.equal(typeof d.source, 'string');
  assert.equal(typeof d.provider, 'string');
  assert.equal(typeof d.content, 'string');
}
hostValidateCandidate(candidate);
hostValidateDefinition(got);
assert.equal(got.name, candidate.name, 'host compares names and silently un-serves on mismatch (dsh-skill:259-262)');
assert.deepEqual(got.resourceBase, candidate.resourceBase, 'resourceBase drives relative-path hints');
assert.ok(candidate.rank > 600, 'our rank must sit below every native root (bundled=600) so we never shadow them');

// ---- 上限：满 50 之后拒绝 ----
for (let i = 0; i < MAX_ACTIVE + 5; i += 1) {
  await setActive(`synthetic/overflow-${i}`, true);
}
const state = await readActivation();
assert.equal(state.active.length, MAX_ACTIVE, `activation must cap at ${MAX_ACTIVE}`);
const rejected = await setActive('synthetic/one-more', true);
assert.equal(rejected.ok, false);
assert.match(String(rejected.reason), /上限/);

// ---- 工具：search / card / activate ----
// dsh-tools 会按 output.schema 校验 execute 的返回值，并要求它能被 render 无损投影
// （dsh-tools:3637-3648）。任何 undefined 属性都会让整次调用失败：
//   Error: tool "skill_activate" returned invalid output: value is not lossless JSON
// 所以每个工具出口都必须是纯 JSON。这里逐个断言往返无损。
function assertLosslessJson(toolName, value) {
  let round;
  try {
    round = JSON.parse(JSON.stringify(value));
  } catch (e) {
    assert.fail(`${toolName} returned non-serializable value: ${e.message}`);
  }
  assert.deepEqual(round, value, `${toolName} output is not lossless JSON — undefined values break dsh-tools`);
  assert.notEqual(round, undefined, `${toolName} returned undefined`);
}

const tools = ['skill_search', 'skill_card', 'skill_activate'];
const search = await captured.tools.get('skill_search').execute({ query: '设计', limit: 3 });
assertLosslessJson('skill_search', search);
assert.ok(search.results.length > 0, 'Chinese keyword should hit the catalog');
assert.match(search.results[0].line, /装 [\d,]+/);
assert.match(search.results[0].line, /分类 \S+/, 'search lines carry the function category');

const blank = await captured.tools.get('skill_search').execute({ query: '', limit: 3 });
assertLosslessJson('skill_search', blank);
assert.equal(blank.results.length, 3, 'empty query lists top scored');

const card = await captured.tools.get('skill_card').execute({ id: skill.slug });
assertLosslessJson('skill_card', card);
assert.ok(card.ok);
for (const field of ['介绍 —', '用途 —', '注意事项 —', '安装数 —', '8 周趋势 —', '来源 —', '评分 —']) {
  assert.ok(card.text.includes(field), `card should expose ${field}`);
}
const missing = await captured.tools.get('skill_card').execute({ id: 'nope/nope' });
assertLosslessJson('skill_card', missing);
assert.equal(missing.ok, false);

const off = await captured.tools.get('skill_activate').execute({ id: skill.id, active: false });
assertLosslessJson('skill_activate', off);
assert.ok(off.ok);
assert.equal((await readActivation()).active.includes(skill.id), false);

const on = await captured.tools.get('skill_activate').execute({ id: skill.id, active: true });
assertLosslessJson('skill_activate', on);
assert.ok(on.ok);
assert.equal(on.needsDownload, false, 'library has the body, so it is really served');
assert.equal((await readActivation()).active.includes(skill.id), true);

// 库存里没有正文的技能：允许激活，但要如实告知 provider 不会暴露它
await writeFile(join(home, 'skills-center', 'activation.json'), JSON.stringify({ version: 1, active: [] }), 'utf8');
const noBody = cat.skills.find((s) => s.id !== skill.id);
const partial = await captured.tools.get('skill_activate').execute({ id: noBody.id, active: true });
assertLosslessJson('skill_activate', partial);
assert.ok(partial.ok);
assert.equal(partial.needsDownload, true);
assert.match(partial.libraryPath, /library[\\/]/);

// 排序检查：评分降序即榜单顺序
const top = await searchSkills('', 12);
assert.deepEqual(
  top.map((s) => s.slug),
  cat.skills.slice().sort((a, b) => b.score.S - a.score.S).map((s) => s.slug),
);

// 卡片文本可渲染
assert.match(renderCard(getSkillSync(cat, skill.id)), /来源 —/);
function getSkillSync(c, id) {
  return c.skills.find((s) => s.id === id);
}

// 卡片取中文的三条路：有中文卡 / 只有英文描述 / 什么都没有。
// 这三种都不许出现占位符——文案规范里「只写能验的事实」是靠这里守住的。
{
  const base = { id: 'x/y/z', slug: 'z', name: 'z', source: 'x/y', installs: 10, score: {} };
  const withZh = renderCard({ ...base, zh: { name_zh: '中文名', intro: '中文介绍。', usage: '中文用途。', notes: '注意事项。' } });
  assert.match(withZh, /^z（中文名） — /);
  assert.match(withZh, /介绍 — 中文介绍。/);
  assert.ok(!withZh.includes('中文卡 — 未覆盖'));

  const enOnly = renderCard({ ...base, description_en: 'English description here.' });
  assert.match(enOnly, /介绍（上游英文原文）— English description here\./);
  assert.match(enOnly, /中文卡 — 未覆盖（只做安装量前 300 条）/);

  const bare = renderCard({ ...base });
  assert.match(bare, /介绍 — 上游没给描述/);

  for (const text of [withZh, enOnly, bare]) {
    assert.ok(!text.includes('缺中文'), `占位符回潮：${text.slice(0, 40)}`);
    assert.ok(!text.includes('需生成'), `占位符回潮：${text.slice(0, 40)}`);
  }
}

// ---- Web API：status / search / card / 404 ----
const route = captured.routes[0];
assert.equal(route.kind, 'prefix');
assert.equal(route.path, '/api/dsh-skills-center');
async function callApi(pathname, method) {
  let body = '';
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk) {
      body = chunk;
    },
  };
  await route.handler({ url: pathname, method }, res);
  return { code: res.statusCode, body: JSON.parse(body) };
}
const status = await callApi('/api/dsh-skills-center/status');
assert.equal(status.code, 200);
assert.equal(status.body.count, cat.count);
assert.equal(status.body.maxActive, MAX_ACTIVE);
assert.ok(Array.isArray(status.body.active));

// 排序菜单要如实标覆盖：/status 带全目录各排序键的可用条数，和数据现算的一遍逐键对齐
{
  const { coverageOf, totalInstalls, DEFAULT_SORT } = await import('../lib/catalog.js');
  const cov = status.body.coverage;
  assert.ok(cov, 'status carries the sort-key coverage');
  assert.equal(DEFAULT_SORT, 'installs', 'the default sort key is total installs');
  assert.deepEqual(cov, coverageOf(cat), 'coverage must match a fresh count over the loaded catalog');
  assert.equal(cov.total, cat.count);
  assert.equal(cov.name, cat.count, 'every row has a name to sort by');
  assert.equal(cov.installs, cat.skills.filter((s) => totalInstalls(s) != null).length);
  assert.ok(cov.s > 0);
}

const apiSearch = await callApi('/api/dsh-skills-center/search?q=design&limit=2');
assert.equal(apiSearch.code, 200);
assert.ok(apiSearch.body.results.length <= 2);

const apiCard = await callApi(`/api/dsh-skills-center/card?id=${encodeURIComponent(skill.id)}`);
assert.equal(apiCard.code, 200);
assert.equal(apiCard.body.id, skill.id);

// ---- GUI 面板的浏览接口：分页、关键词、筛选、排序方向、条数硬上限 ----
const apiList = await callApi('/api/dsh-skills-center/list?limit=2');
assert.equal(apiList.code, 200);
assert.equal(apiList.body.total, cat.count);
assert.equal(apiList.body.maxActive, MAX_ACTIVE);
assert.equal(apiList.body.dir, 'desc');
assert.ok(Array.isArray(apiList.body.active));
assert.ok(apiList.body.rows.length <= 2, 'limit is honoured');
for (const row of apiList.body.rows) {
  // 面板只靠这些字段画卡片，缺一个就渲染成空行或空标签
  for (const key of [
    'id', 'slug', 'name', 'source', 'source_kind', 'installs', 'installs_merged', 'total_installs', 'copies',
    'trend_pct', 'S', 'score',
    'verdict', 'flags', 'has_zh', 'description', 'official', 'curated', 'enriched', 'audit', 'install_hint',
  ]) {
    assert.ok(key in row, `row carries ${key}`);
  }
  assert.equal(typeof row.verdict, 'string');
  assert.equal(typeof row.description, 'string', 'empty description stays an empty string, never undefined');
  // 卡片上的装量显示的是总装量：没有合并值时必须退回主条目装量，而不是显示成空
  assert.equal(row.total_installs, row.installs_merged ?? row.installs);
  assert.equal(typeof row.copies, 'number');
}

// 默认排序 = 总安装量降序（installs_merged ?? installs）；显式 sort=s 仍按 S 分
{
  const total = (row) => (row.total_installs ?? row.installs ?? -1);
  const byInstalls = await callApi('/api/dsh-skills-center/list?limit=50');
  assert.equal(byInstalls.body.sort, 'installs', 'the /list default sort is total installs');
  const installs = byInstalls.body.rows.map(total);
  assert.deepEqual(installs, installs.slice().sort((a, b) => b - a), 'default order is total installs descending');

  const byScore = await callApi('/api/dsh-skills-center/list?limit=50&sort=s');
  assert.equal(byScore.body.sort, 's', 'sort=s is still accepted');
  const scores = byScore.body.rows.map((row) => (row.S == null ? -1 : Number(row.S)));
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), 'sort=s still ranks by the S score');
}

// 近 30 天安装量：目录里没有现成的 installs_4w 字段，排序只能由 weekly_series 现算。
// 比较器曾经读 s.installs_4w（7821 条全都没有），整项排序空转，界面却照报「可用 2939 条」。
// 打包样例里一条周量都没有，所以这里临时往 DSH_HOME 写一份小目录，真跑一遍排序再删掉。
{
  const dir = join(home, 'skills-center', 'catalog');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'catalog.json');
  const mk = (slug, series) => ({
    id: `x/y/${slug}`,
    slug,
    name: slug,
    installs: 1,
    score: { S: 0.5 },
    weekly_series: series,
  });
  await writeFile(
    file,
    JSON.stringify({
      version: 'test-installs4w',
      skills: [mk('no-series', null), mk('tiny', [1, 1, 1, 1]), mk('big', [999, 999, 999, 999, 5, 5, 5, 5])],
    }),
  );
  const { browseSkills: browse4w, coverageOf: cov4w } = await import('../lib/catalog.js');
  const four = await browse4w({ sort: 'installs4w', limit: 10 });
  assert.equal(four.sort, 'installs4w');
  assert.deepEqual(
    four.rows.map((r) => r.slug),
    ['big', 'tiny', 'no-series'],
    'the 4-week sort sums the last four weekly points; rows without a series go last',
  );
  assert.deepEqual(four.rows.map((r) => r.installs_4w), [20, 4, null]);
  const covered = cov4w(await loadCatalog());
  assert.equal(covered.installs_4w, 2, 'coverage counts the same thing the comparator sorts by');
  assert.equal(covered.stars, 0);
  await rm(file, { force: true });
  const back = await loadCatalog();
  assert.equal(back.count, cat.count, 'removing the temp catalog falls back to the bundled sample');
}

const apiListQuery = await callApi('/api/dsh-skills-center/list?q=design&limit=5');
assert.equal(apiListQuery.code, 200);
assert.ok(apiListQuery.body.matched <= apiListQuery.body.total);
assert.ok(apiListQuery.body.rows.length > 0, 'keyword search finds rows');
assert.ok(
  apiListQuery.body.rows.every((row) => `${row.slug} ${row.name_zh || ''} ${row.description}`.length > 0),
);

// 功能分类：菜单随 /list 一起下发（计数按整个目录算），且能按分类过滤
assert.ok(Array.isArray(apiList.body.categories) && apiList.body.categories.length > 0, 'list returns the category menu');
assert.ok(apiList.body.categories.every((c) => c.key && c.label && typeof c.count === 'number'));
assert.equal(typeof apiList.body.classified, 'number');
for (const row of apiList.body.rows) {
  assert.ok(Array.isArray(row.categories) && row.categories.length > 0, 'every row carries its categories');
}
{
  const frontend = apiList.body.categories.find((c) => c.key === 'frontend') || apiList.body.categories[0];
  const apiListCategory = await callApi(`/api/dsh-skills-center/list?category=${frontend.key}&limit=5`);
  assert.equal(apiListCategory.code, 200);
  assert.equal(apiListCategory.body.category, frontend.key);
  assert.ok(apiListCategory.body.matched > 0, 'category filter matches rows');
  assert.ok(apiListCategory.body.matched <= frontend.count, 'filtered count cannot exceed the menu count');
  assert.ok(
    apiListCategory.body.rows.every((row) => row.categories.includes(frontend.key)),
    'category filter only returns rows in that category',
  );
  // 分类计数不随关键词变化：菜单要稳定，否则点一下菜单就洗牌
  assert.deepEqual(
    apiListCategory.body.categories.map((c) => c.count),
    apiList.body.categories.map((c) => c.count),
  );
}

const apiListZh = await callApi('/api/dsh-skills-center/list?zh=1&limit=50');assert.equal(apiListZh.code, 200);
assert.ok(apiListZh.body.rows.every((row) => row.has_zh === true), 'zh=1 keeps only rows with a Chinese card');

const apiListOfficial = await callApi('/api/dsh-skills-center/list?filter=official&limit=20');
assert.equal(apiListOfficial.code, 200);
assert.equal(apiListOfficial.body.filter, 'official');
assert.ok(apiListOfficial.body.rows.length > 0, 'the sample catalog has official entries');
assert.ok(
  apiListOfficial.body.rows.every((row) => row.official === true || row.curated === true),
  'filter=official keeps only official/curated rows',
);

// official 已并进 curated：两个筛选键必须给出完全一样的结果，老链接传 official 也不能 400/空
{
  const curated = await callApi('/api/dsh-skills-center/list?filter=curated&limit=500');
  const official = await callApi('/api/dsh-skills-center/list?filter=official&limit=500');
  assert.equal(curated.code, 200);
  assert.equal(curated.body.filter, 'curated');
  assert.equal(official.body.matched, curated.body.matched, 'official and curated select the same rows');
  assert.deepEqual(official.body.rows.map((r) => r.id), curated.body.rows.map((r) => r.id));
  assert.ok(
    curated.body.rows.every((row) => row.curated === true || row.official === true),
    'filter=curated keeps only curated rows',
  );
}

const apiListRisky = await callApi('/api/dsh-skills-center/list?filter=risky&limit=20');
assert.equal(apiListRisky.code, 200);
assert.ok(
  apiListRisky.body.rows.every((row) => row.flags.length > 0 || (row.audit && (row.audit.warn > 0 || row.audit.fail > 0))),
  'filter=risky keeps only rows with a flag or a warn/fail audit',
);

// 升序要把最差的排前面：跟降序的第一条不能是同一条
const apiListAsc = await callApi('/api/dsh-skills-center/list?limit=2&sort=installs&dir=asc');
assert.equal(apiListAsc.code, 200);
assert.equal(apiListAsc.body.dir, 'asc');
assert.ok(apiListAsc.body.rows[0].installs <= apiListAsc.body.rows[1].installs, 'asc really ascends');
assert.notEqual(apiListAsc.body.rows[0].id, apiList.body.rows[0].id, 'direction actually flips the order');

// 安装命令只在 GitHub 来源上给，域名来源（open.feishu.cn 这类）必须为空。
// 样例目录里全是 github，所以这条直接对 rowOf 下断言，不靠样例数据凑。
const { rowOf, weeklySum, SORT_KEYS } = await import('../lib/catalog.js');

// 卡片文本里的装量 = 总装量：有副本且和主条目不同时两个数都要写出来
{
  const withCopies = renderCard({
    id: 'a/b/c', slug: 'c', name: 'c', source: 'a/b', installs: 100, installs_merged: 130, aliases: ['x/1', 'x/2'],
    score: {},
  });
  assert.match(withCopies, /安装数 — 130（主条目 100，含 2 个副本）/);
  const noCopies = renderCard({ id: 'a/b/d', slug: 'd', name: 'd', source: 'a/b', installs: 100, score: {} });
  assert.match(noCopies, /安装数 — 100/);
  assert.ok(!noCopies.includes('副本'), 'no copies → no copies line');
}

// 「近 30 天安装量」= 8 周周量的最近 4 周之和（上游不给 30 天口径，这是我们自己算的）
assert.equal(weeklySum([10, 10, 10, 10, 20, 20, 20, 20], 4), 80, 'last four weeks are summed');
assert.equal(weeklySum([10, 10, 10, 10, 20, 20, 20, 20], 4, true), 40, 'the previous window is available too');
assert.equal(weeklySum([1, 2, 3], 4), null, 'not enough weeks means null, not a guess');
assert.equal(weeklySum(null, 4), null);
{
  const withSeries = rowOf({
    id: 'a/b/c',
    slug: 'c',
    source: 'a/b',
    kind: 'github',
    installs: 1,
    weekly_series: [1, 1, 1, 1, 2, 2, 2, 2],
    score: {},
  });
  assert.equal(withSeries.installs_4w, 8);
  assert.equal(withSeries.installs_prev4w, 4);
  // 发布时间来自技能页的 First Seen；没有就是 null，不填假日期
  assert.equal(withSeries.first_seen, null);
  assert.equal(
    rowOf({ id: 'a/b/c', slug: 'c', source: 'a/b', installs: 1, first_seen: '2026-01-19', score: {} }).first_seen,
    '2026-01-19',
  );
  // 星标数（仓库级，来自技能页）：有就是数字，没有就是 null，不写 0
  assert.equal(rowOf({ id: 'a/b/c', slug: 'c', source: 'a/b', installs: 1, stars: 182200, score: {} }).stars, 182200);
  assert.equal(rowOf({ id: 'a/b/c', slug: 'c', source: 'a/b', installs: 1, score: {} }).stars, null);
  assert.ok(SORT_KEYS.includes('stars'), 'stars is a sort key');
}

// 总装量与副本数：合并值优先，缺合并值退回主条目装量（不是当成没数据）
{
  const merged = rowOf({
    id: 'a/b/c', slug: 'c', source: 'a/b', installs: 10, installs_merged: 25, aliases: ['x/1', 'x/2'], score: {},
  });
  assert.equal(merged.total_installs, 25, 'merged installs win');
  assert.equal(merged.copies, 2, 'aliases are the republished copies');
  assert.equal(merged.installs, 10, 'the canonical count stays on the row');
  const plain = rowOf({ id: 'a/b/d', slug: 'd', source: 'a/b', installs: 7, score: {} });
  assert.equal(plain.total_installs, 7, 'no merged value falls back to the canonical count');
  assert.equal(plain.copies, 0);
}
assert.match(
  rowOf({ id: 'a/b/c', slug: 'c', source: 'a/b', kind: 'github', installs: 1, score: {} }).install_hint,
  /^npx skills add a\/b --skill c$/,
);
assert.equal(
  rowOf({ id: 'open.feishu.cn/x', slug: 'x', source: 'open.feishu.cn', kind: 'well-known', installs: 1, score: {} })
    .install_hint,
  null,
  'no install command is invented for non-GitHub sources',
);
assert.deepEqual(
  rowOf({ id: 'a/b/c', slug: 'c', source: 'a/b', installs: 1, score: {}, audit: { audits: [{ provider: 'Snyk', status: 'pass' }, { provider: 'Runlayer', status: 'fail' }] } }).audit,
  { judged: 2, pass: 1, warn: 0, fail: 1 },
  'audit counts feed the card badge',
);

const apiListCap = await callApi('/api/dsh-skills-center/list?limit=99999');
assert.equal(apiListCap.code, 200);
assert.ok(apiListCap.body.rows.length <= 500, 'limit has a hard cap so one request cannot return the whole catalog');

const api404 = await callApi('/api/dsh-skills-center/nope');
assert.equal(api404.code, 404);
assert.equal(api404.body.error, 'not_found');

// ---- 榜单页：GET 根路径给 HTML，目录内联在里面 ----
async function callRaw(pathname, method) {
  let body = '';
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk) {
      body = chunk;
    },
  };
  await route.handler({ url: pathname, method }, res);
  return { code: res.statusCode, headers: res.headers, body };
}
const page = await callRaw('/api/dsh-skills-center/');
assert.equal(page.code, 200);
assert.match(page.headers['content-type'], /text\/html/);
assert.ok(page.body.includes('<table'), 'ranking page renders a table');
assert.ok(page.body.includes(skill.slug), 'page inlines catalog rows');
assert.ok(page.body.includes('"count":' + cat.count), 'page carries the row count');
// 榜单页的表格默认按总装量列排，表头要写清是哪一列
assert.match(page.body, /data-k="installs"[^>]*>总安装量</, 'the table names the default sort column');
assert.match(page.body, /sortKey = 'installs'/, 'the table starts sorted by total installs');
// 内联 JSON 里不能出现裸 </script>，否则页面会被截断
assert.ok(!page.body.includes('</script><'), 'inline data is script-safe');

// 榜单页的中文列必须取 s.zh.intro（采集端写的就是这个字段；
// 早先这里读 s.intro_zh，线上中文列全空，靠这条守）
{
  const { rankingPayload } = await import('../lib/page.js');
  const payload = rankingPayload({
    version: 'v',
    count: 1,
    shown: 1,
    active: [],
    skills: [{ id: 'a/b/c', slug: 'c', name_zh: '中文名', zh: { intro: '中文介绍。' }, installs: 1, score: { S: 0.5 } }],
  });
  assert.equal(payload.rows[0].name, '中文名');
  assert.equal(payload.rows[0].intro, '中文介绍。');
  assert.equal(payload.rows[0].installs, 1, 'no merged value → the column falls back to the canonical count');
  assert.equal(payload.rows[0].copies, 0);
  // 表格默认按总装量列排，所以这一列必须是合并后的量，且副本数要单独带出来
  const withCopies = rankingPayload({
    version: 'v',
    count: 1,
    shown: 1,
    active: [],
    skills: [{
      id: 'a/b/d', slug: 'd', name: 'd', source: 'a/b', installs: 100, installs_merged: 130, aliases: ['x/1', 'x/2'],
      score: { S: 0.5 },
    }],
  });
  assert.equal(withCopies.rows[0].installs, 130);
  assert.equal(withCopies.rows[0].copies, 2);
}

// ---- 远端目录同步（skill_sync）：还没同步过时 status 必须如实说没有 ----
assert.equal(status.body.synced, null, 'no sync yet → no meta');

const fixtureDir = join(home, 'fixtures');
await mkdir(fixtureDir, { recursive: true });
const remoteCatalog = {
  version: 'sync-test-1',
  generatedAt: '2026-10-19T00:00:00.000Z',
  skills: [
    {
      id: 'acme/tools/deploy-helper',
      slug: 'deploy-helper',
      name: 'deploy-helper',
      source: 'acme/tools',
      installs: 1234,
      trend_pct: 12.5,
      score: { S: 0.42, H: 0.3, T: 0.6, C: 1, A: 1 },
      flags: [],
      zh: { intro: '把部署脚本收敛成一条命令。', usage: '部署前跑一次。', notes: '需要仓库写权限。' },
    },
    {
      id: 'acme/tools/log-triage',
      slug: 'log-triage',
      name: 'log-triage',
      source: 'acme/tools',
      installs: 99,
      trend_pct: null,
      score: { S: 0.11, H: 0.1, T: 0.1, C: 0, A: 0.5 },
      flags: ['thin_body'],
      zh: { intro: '按错误签名给日志分组。', usage: '排障起步。', notes: '' },
    },
  ],
};
const server = createServer((req, res) => {
  if (req.url === '/catalog.json') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(remoteCatalog));
    return;
  }
  if (req.url === '/truncated.json') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end('{"version": "broken", "skills": [ {');
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"nope"}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const remoteUrl = `http://127.0.0.1:${server.address().port}/catalog.json`;
const syncTool = captured.tools.get('skill_sync');

const synced = await syncTool.execute({ url: remoteUrl });
assertLosslessJson('skill_sync', synced);
assert.equal(synced.ok, true, `sync should succeed: ${synced.reason}`);
assert.equal(synced.changed, true);
assert.equal(synced.count, 2);
assert.equal(synced.version, 'sync-test-1');
assert.match(synced.file, /catalog[\\/]catalog\.json$/);

const afterSync = await loadCatalog();
assert.equal(afterSync.version, 'sync-test-1', 'synced catalog must win over the bundled sample');
assert.equal(afterSync.count, 2);
assert.equal(afterSync.skills[1].slug, 'log-triage');

// 同一份内容再拉一次：不重写、不制造无谓的 mtime 变化
const again = await syncTool.execute({ url: remoteUrl });
assertLosslessJson('skill_sync', again);
assert.equal(again.ok, true);
assert.equal(again.changed, false);
assert.equal(again.reason, 'unchanged');

// 坏 payload：报错且旧目录原地不动（宁可旧，不可坏）
const broken = await syncTool.execute({ url: remoteUrl.replace('catalog.json', 'truncated.json') });
assertLosslessJson('skill_sync', broken);
assert.equal(broken.ok, false);
assert.match(broken.reason, /not_json/);
assert.equal((await loadCatalog()).version, 'sync-test-1', 'a broken payload must not clobber the good catalog');

// 404 也如实报出来，而不是当成成功
const missingRemote = await syncTool.execute({ url: remoteUrl.replace('catalog.json', 'gone.json') });
assertLosslessJson('skill_sync', missingRemote);
assert.equal(missingRemote.ok, false);
assert.match(missingRemote.reason, /http_404/);

// 没有来源时不许假装成功：现在缺省地址是插件托管的固定入口，所以「没 url」不再等于失败，
// 但一定要请求那个默认地址（线上 302 到 Blob 的 catalog-latest.json）。这里把 fetch 换成桩，
// 断言的正是「到底向哪个地址发请求」，不依赖网络。
const realFetch = globalThis.fetch;
let defaultAsked = null;
globalThis.fetch = async (url) => {
  defaultAsked = String(url);
  return new Response(JSON.stringify(remoteCatalog), { status: 200, headers: { 'content-type': 'application/json' } });
};
let noUrl;
try {
  noUrl = await syncTool.execute({ force: true });
} finally {
  globalThis.fetch = realFetch;
}
assertLosslessJson('skill_sync', noUrl);
assert.equal(defaultAsked, DEFAULT_CATALOG_URL, 'no url argument must fall back to the hosted default endpoint');
assert.equal(noUrl.ok, true, JSON.stringify(noUrl));
assert.equal(noUrl.version, remoteCatalog.version, 'the default endpoint is parsed like any other source');

// 本地文件 / file:// 也走同一条代码路径（离线验证采集产物）
const localCatalogPath = join(fixtureDir, 'catalog.local.json');
await writeFile(localCatalogPath, JSON.stringify({ ...remoteCatalog, version: 'sync-test-2' }), 'utf8');
const fromFile = await syncTool.execute({ url: localCatalogPath });
assertLosslessJson('skill_sync', fromFile);
assert.equal(fromFile.ok, true);
assert.equal(fromFile.via, 'file');
assert.equal(fromFile.version, 'sync-test-2');
assert.equal(fromFile.previous.version, 'sync-test-1', 'previous version must be reported');

// 同步后 status 要能查到来源与 hash；POST /sync 路由可用
const statusAfter = await callApi('/api/dsh-skills-center/status');
assert.equal(statusAfter.code, 200);
assert.equal(statusAfter.body.count, 2);
assert.equal(statusAfter.body.synced.version, 'sync-test-2');
assert.match(statusAfter.body.synced.sha256, /^[0-9a-f]{64}$/);

const routeGet = await callApi('/api/dsh-skills-center/sync', 'GET');
assert.equal(routeGet.code, 405, 'sync changes files on disk, so GET must be refused');

const routePost = await callApi(
  `/api/dsh-skills-center/sync?url=${encodeURIComponent(remoteUrl)}&force=1`,
  'POST',
);
assert.equal(routePost.code, 200);
assert.equal(routePost.body.ok, true);
assert.equal(routePost.body.version, 'sync-test-1', 'POST sync pulls the remote catalog again');

await new Promise((resolve) => server.close(resolve));


// ---- 恶意/畸形目录：host 的 validateCandidate 会 throw，且不在 list 的 try 里，
// 一个坏候选能让所有 provider 的目录当场消失。我们的 list 必须自己滤掉。 ----
const hostile = [
  { id: 'a/good-one', slug: 'good-one', source: 'a', description_en: 'fine', zh: { intro: '好的那条' } },
  { id: 'a/Bad_Slug', slug: 'Bad_Slug', source: 'a', description_en: 'uppercase + underscore' },
  { id: 'a/no-desc', slug: 'no-desc', source: 'a', description_en: '', zh: {} },
  { id: 'b/dup', slug: 'dup', source: 'b', description_en: 'first dup' },
  { id: 'b/DUP', slug: 'DUP', source: 'b', description_en: 'second dup, same normalized name' },
  { id: 'c/../escape', slug: 'x y', source: 'c', description_en: 'spaces normalize to dashes' },
];
const catDir = join(home, 'skills-center', 'catalog');
await mkdir(catDir, { recursive: true });
await writeFile(
  join(catDir, 'catalog.json'),
  JSON.stringify({ version: 'hostile-test', count: hostile.length, skills: hostile }),
  'utf8',
);
for (const s of hostile) {
  const dir = join(home, 'skills-center', 'library', s.source, s.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${s.slug}\n---\n\nbody for ${s.slug}\n`, 'utf8');
}
const hostileProvider = captured.providerFactory({ invalidate() {}, signal: undefined });
await writeFile(join(home, 'skills-center', 'activation.json'), JSON.stringify({ version: 1, active: hostile.map((s) => s.id) }), 'utf8');
const hostileList = await hostileProvider.list(); // 绝不抛
for (const c of hostileList) hostValidateCandidate(c);
const names = hostileList.map((c) => c.name).sort();
assert.deepEqual(names, ['bad-slug', 'dup', 'good-one', 'x-y'], `unexpected candidates: ${names}`);
assert.equal(hostileList.find((c) => c.name === 'dup').description, 'first dup', 'normalized duplicate keeps the first');

await rm(home, { recursive: true, force: true });
console.log('smoke ok — catalog', cat.count, '| top:', list[0].name, '| tools:', [...captured.tools.keys()].join(','));
