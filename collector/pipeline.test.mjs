// 采集流水线的单测。跑法：node collector/pipeline.test.mjs（或 npm test 里一起跑）。
// 数据用真实测量值（2026-10-19 采到的 ai-video-generation 六个 fork、12 个技能的真实 installs），
// 不用编造的数字——否则测试只会证明代码符合我的想象。
import assert from 'node:assert/strict';
import { buildCatalog, clusterKey, dedupe, normalizeRecord, scoreRecord, trendPct, auditScore } from './pipeline.mjs';
import { bodyGateStats } from './collect.mjs'; // 纯函数，无网络/无副作用；只测水位门禁的算术

// ---- 趋势：8 周序列前后半段 ----
assert.equal(trendPct([100, 100, 100, 100, 100, 100, 100, 100]), 0, 'flat series is 0%');
assert.equal(trendPct([100, 100, 100, 100, 200, 200, 200, 200]), 100, 'doubling halves = +100%');
assert.equal(trendPct([200, 200, 200, 200, 100, 100, 100, 100]), -50, 'halving halves = -50%');
assert.equal(trendPct([10, 10]), null, 'too few points → null, not a made-up number');
assert.equal(trendPct([0, 0, 0, 0, 5, 5, 5, 5]), null, 'zero baseline can not produce a percentage');

// ---- 跨 owner fork 去重：ai-video-generation 至少有 6 个 owner 在发 ----
const forks = [
  ['101-skills/superpowers/ai-video-generation', 801414],
  ['magentosh/superpowers/ai-video-generation', 642000],
  ['qu-skills/superpowers/ai-video-generation', 484000],
  ['skills-shell/superpowers/ai-video-generation', 339000],
  ['its-a-skill-issue/superpowers/ai-video-generation', 333000],
  ['bankai-skills/superpowers/ai-video-generation', 318000],
].map(([id, installs]) => ({
  id,
  slug: 'ai-video-generation',
  installs,
  description: 'Generate AI videos from still images and text prompts.',
}));

const dedupedForks = dedupe(forks.map(normalizeRecord));
assert.equal(dedupedForks.length, 1, 'six forks must collapse into one entry');
assert.equal(dedupedForks[0].id, '101-skills/superpowers/ai-video-generation', 'canonical = highest installs');
assert.equal(dedupedForks[0].installs, 801414, 'canonical keeps its own installs for scoring');
assert.equal(dedupedForks[0].installs_merged, 2917414, 'merged total is display-only');
assert.equal(dedupedForks[0].aliases.length, 5);

// buildCatalog 的白名单会丢掉没写进去的字段：新增字段（星标、发布时间）必须在这里钉一下，
// 否则采集端解析对了、产物里却永远是空的（踩过一次：first_seen 有、stars 没有）。
{
  const built = buildCatalog(
    [
      { id: 'a/b/with-stars', slug: 'with-stars', name: 'with-stars', source: 'a/b', installs: 100, stars: 182200, first_seen: '2026-01-19' },
      { id: 'a/b/no-stars', slug: 'no-stars', name: 'no-stars', source: 'a/b', installs: 50 },
    ],
    { version: 'full-2026-10-20T00-00-00-000Z', generatedAt: '2026-10-20T00:00:00.000Z' },
  );
  const withStars = built.skills.find((s) => s.slug === 'with-stars');
  const noStars = built.skills.find((s) => s.slug === 'no-stars');
  assert.equal(withStars.stars, 182200, 'stars must survive buildCatalog');
  assert.equal(withStars.first_seen, '2026-01-19');
  assert.equal(noStars.stars, undefined, 'a missing star count must not become 0');
}

// hash 优先于 slug：不同 slug、同一份内容，也算同一个技能
const sameContent = [
  normalizeRecord({ id: 'a/skills-alpha', slug: 'alpha', installs: 900, description: 'x', hash: 'abc123' }),
  normalizeRecord({ id: 'b/skills-beta', slug: 'beta', installs: 100, description: 'y', hash: 'abc123' }),
];
assert.equal(clusterKey(sameContent[0]), clusterKey(sameContent[1]));
assert.equal(dedupe(sameContent).length, 1, 'same hash → same skill regardless of slug');

// 不同内容绝不合并（宁可留重复，也不要把两个技能揉成一个）
assert.equal(
  dedupe([
    normalizeRecord({ id: 'a/one', slug: 'one', installs: 10, description: 'A', hash: 'h1' }),
    normalizeRecord({ id: 'b/two', slug: 'two', installs: 20, description: 'B', hash: 'h2' }),
  ]).length,
  2,
);

// ---- 审计打分（上游字段是 audits:[{provider,status}]）----
assert.equal(auditScore(null), 0.5, 'no audit data → neutral 0.5, never 0');
assert.equal(auditScore({ audits: [] }), 0.5);
assert.equal(
  auditScore({ audits: [{ status: 'pass' }, { status: 'pass' }, { status: 'warn' }, { status: 'pass' }] }),
  0.75,
);
assert.equal(
  auditScore({ audits: [{ status: 'pass' }, { status: 'fail' }, { status: 'warn' }, { status: 'fail' }] }),
  0.25,
  'fail must stay in the denominator — dropping it would launder a bad skill into a good score',
);

// ---- 打分：对数归一，且排序必须与直觉一致 ----
const scored = buildCatalog(
  [
    { id: 'mattpocock/skills/grill-me', slug: 'grill-me', installs: 1385556, description: 'a', weeklyInstalls: [1, 1, 1, 1, 1, 1, 1, 1] },
    { id: 'anthropics/skills/frontend-design', slug: 'frontend-design', installs: 1003686, description: 'b', curated: true, weeklyInstalls: [1, 1, 1, 1, 2, 2, 2, 2] },
    { id: 'nobody/tiny-skill', slug: 'tiny-skill', installs: 30000, description: 'c', weeklyInstalls: [9, 9, 9, 9, 9, 9, 9, 9] },
  ],
  { version: 'test-1' },
);
assert.equal(scored.count, 3);
assert.equal(scored.skills[0].id, 'anthropics/skills/frontend-design', 'curated + growing beats raw installs');
const head = scored.skills.find((s) => s.slug === 'grill-me');
const tail = scored.skills.find((s) => s.slug === 'tiny-skill');
assert.ok(head.score.S > tail.score.S);
// 139 万 vs 3 万 是 46 倍差，但 H 分不能因此差 46 倍，否则腰部技能全部归零
assert.ok(head.score.H - tail.score.H < 0.35, `log normalization too steep: ${head.score.H} vs ${tail.score.H}`);
assert.ok(tail.score.H > 0.5, 'a 30k-install skill must still score meaningfully on H');
assert.ok(scored.skills.every((s) => s.score.S >= 0 && s.score.S <= 1), 'S must stay in [0,1]');

// ---- flags：真实踩过的三个坑 ----
const flagged = buildCatalog(
  [
    {
      id: 'mattpocock/skills/grill-me',
      slug: 'grill-me',
      installs: 1,
      description: 'a',
      bodyLength: 39,
      body_excerpt: 'Call the Skill tool with "grilling".',
    },
    {
      id: 'prisma/skills/prisma-postgres',
      slug: 'prisma-postgres',
      installs: 1,
      description: 'b',
      bodyLength: 369,
      body_excerpt: 'This compatibility entry contains no setup recipes.',
    },
    {
      id: 'designed-by-ai/skills/design-mobile-apps',
      slug: 'design-mobile-apps',
      installs: 1,
      description: 'c',
      body_excerpt: 'requires $SLEEK_API_KEY to be set',
    },
  ],
  { version: 'test-2' },
).skills;
const bySlug = (slug) => flagged.find((s) => s.slug === slug);
assert.ok(bySlug('grill-me').flags.includes('pointer'), 'thin forwarding shell must be flagged');
assert.ok(bySlug('grill-me').flags.includes('thin_body'));
assert.ok(bySlug('prisma-postgres').flags.includes('deprecated'));
assert.ok(bySlug('design-mobile-apps').flags.includes('needs_api_key'));
assert.ok(!bySlug('design-mobile-apps').flags.includes('deprecated'), 'flags must not leak across records');

// ---- 归一化：坏记录直接丢，不要让它们进目录 ----
assert.equal(normalizeRecord(null), null);
assert.equal(normalizeRecord({ id: 'no-slash' }), null, 'id 必须是 source/slug 形状');
const normalized = normalizeRecord({ id: 'anthropics/skills/frontend-design', installs: 1003686 });
// source = id 去掉最后一段（owner/repo），卡片上的「来源」和安装命令都靠它
assert.equal(normalized.source, 'anthropics/skills');
assert.equal(normalized.slug, 'frontend-design');
assert.equal(normalized.installs, 1003686);
// 两段 id（域名来源）不许被切坏
assert.equal(normalizeRecord({ id: 'open.feishu.cn/lark-drive' }).source, 'open.feishu.cn');

// ---- 正文元数据：目录只带 length/sha256；全文与摘录都不进 catalog（payload 预算）----
{
  const sha = 'a'.repeat(64);
  const once = normalizeRecord({
    id: 'a/b/body-skill',
    slug: 'body-skill',
    installs: 10,
    description: 'x',
    bodyLength: 1234,
    body_sha256: sha,
  });
  assert.equal(once.body_length, 1234, 'bodyLength → body_length on the first pass');
  assert.equal(once.body_sha256, sha, 'body_sha256 must survive the first normalize pass');
  const twice = normalizeRecord(once);
  assert.equal(twice.body_length, 1234, 'body_length must survive the second pass (collect.mjs normalizes twice)');
  assert.equal(twice.body_sha256, sha, 'body_sha256 must survive the second pass');
  const built = buildCatalog(
    [{ id: 'a/b/body-skill', slug: 'body-skill', installs: 10, description: 'x', bodyLength: 1234, body_sha256: sha }],
    { version: 'test-body' },
  ).skills[0];
  assert.deepEqual(built.body, { length: 1234, sha256: sha }, 'catalog carries body metadata (length + sha256)');
  // body_v 是「这份正文已经存进 Blob」的印章：只有真的入库了才允许带上，否则目录会声称一份取不到的正文
  const stored = buildCatalog(
    [{ id: 'a/b/body-skill', slug: 'body-skill', installs: 10, description: 'x', bodyLength: 1234, body_sha256: sha, body_v: 1 }],
    { version: 'test-body' },
  ).skills[0];
  assert.deepEqual(stored.body, { length: 1234, sha256: sha, v: 1 }, 'body_v must reach the catalog when the text is stored');
  assert.ok(!('body_excerpt' in built), 'body_excerpt must stay out of the catalog');
  const noBody = buildCatalog([{ id: 'a/b/no-body', slug: 'no-body', installs: 5, description: 'y' }], { version: 'test-body' }).skills[0];
  assert.equal(noBody.body, undefined, 'a record without a body must not invent one');
}

// ---- 收录过滤：默认关闭；开启后按 no_body → thin_body → no_description 分类记账 ----
{
  const gateRecords = [
    { id: 'a/b/full', slug: 'full', installs: 100, description: 'has everything', bodyLength: 900, body_sha256: 'h1' },
    { id: 'a/b/no-body', slug: 'no-body', installs: 90, description: 'no body at all' },
    { id: 'a/b/no-sha', slug: 'no-sha', installs: 80, description: 'body but no sha256', bodyLength: 900 },
    { id: 'a/b/thin', slug: 'thin', installs: 70, description: 'too short', bodyLength: 120, body_sha256: 'h2' },
    { id: 'a/b/no-desc', slug: 'no-desc', installs: 60, bodyLength: 900, body_sha256: 'h3' },
  ];
  const off = buildCatalog(gateRecords, { version: 'test-gate' });
  assert.equal(off.count, 5, 'requireBody defaults to false — the gate must not silently shrink the catalog');
  assert.deepEqual(off.dropped, { no_body: 0, thin_body: 0, no_description: 0 }, 'a closed gate reports all zeroes');
  const on = buildCatalog(gateRecords, { version: 'test-gate', requireBody: true });
  assert.equal(on.count, 1, 'only the complete record survives');
  assert.equal(on.skills[0].slug, 'full');
  assert.deepEqual(
    on.dropped,
    { no_body: 2, thin_body: 1, no_description: 1 },
    'each record is counted once, by the first matching rule (no sha256 is no_body, not thin_body)',
  );
  assert.equal(on.raw_count, 5, 'raw_count still counts every normalized record');
  // 300 是门槛本身：恰好 300 通过，299 丢；上限可覆盖
  const edge = (length, opts) =>
    buildCatalog(
      [{ id: 'a/b/edge', slug: 'edge', installs: 1, description: 'd', bodyLength: length, body_sha256: 'h' }],
      { version: 'test-gate', requireBody: true, ...opts },
    );
  assert.equal(edge(300).count, 1, 'length == minBodyLength passes');
  assert.equal(edge(299).dropped.thin_body, 1, 'length < minBodyLength is thin_body');
  assert.equal(edge(900, { minBodyLength: 5000 }).count, 0, 'minBodyLength is overridable');
}

// ---- official 与 curated 合并：目录只发 curated，official 不再出现 ----
{
  assert.equal(normalizeRecord({ id: 'a/b/legacy', official: true }).official, true, 'normalizeRecord still reads raw.official');
  const built = buildCatalog(
    [
      { id: 'a/b/official-only', slug: 'official-only', installs: 30, description: 'a', official: true },
      { id: 'a/b/plain', slug: 'plain', installs: 20, description: 'b' },
    ],
    { version: 'test-curated' },
  );
  const official = built.skills.find((s) => s.slug === 'official-only');
  const plain = built.skills.find((s) => s.slug === 'plain');
  assert.equal(official.curated, true, 'official ⊂ curated: an official record must still read as curated');
  assert.ok(!('official' in official), 'the catalog must not emit the official field any more');
  assert.equal(official.score.C, 1, 'C must still reward official/curated');
  assert.equal(plain.curated, undefined, 'a non-curated record must not gain a curated flag');
}

// ---- 正文水位门禁：按合并后装量取前 N 条，看覆盖率与 strict ----
{
  const rows = [
    { id: 'a/b/top', slug: 'top', installs: 900, description: 'x', bodyLength: 900, body_sha256: 'h1', body_v: 1 },
    { id: 'c/d/top', slug: 'top', installs: 100, description: 'x', bodyLength: 900, body_sha256: 'h1', body_v: 1 },
    // 抓过 detail、也有正文指纹，但正文没入库（body_v 缺）= 历史上「抓完就丢」的那种记录：
    // 能算「抓到了」，不能算「已入库」——门禁只能按后者开。
    { id: 'e/f/old', slug: 'old', installs: 200, description: 'w', bodyLength: 800, body_sha256: 'h9' },
    { id: 'a/b/mid', slug: 'mid', installs: 50, description: 'y' },
    { id: 'a/b/tail', slug: 'tail', installs: 10, description: 'z' },
  ];
  const gate = bodyGateStats(rows, 2);
  assert.equal(gate.head_total, 2, 'waterline caps the head');
  assert.equal(gate.head_with_body, 2, 'fetched counts as fetched even when the body was not stored');
  assert.equal(gate.head_stored, 1, 'only body_v counts as stored');
  assert.equal(gate.coverage, 0.5);
  assert.equal(gate.strict, false, 'coverage below 95% keeps the filter off');
  assert.equal(bodyGateStats(rows, 3).head_stored, 1);
  assert.equal(bodyGateStats([], 2000).coverage, 0, 'an empty catalog cannot claim coverage');
  assert.equal(bodyGateStats([], 2000).strict, false);
  const allStored = rows.map((r) => (r.bodyLength ? { ...r, body_v: 1 } : r));
  assert.equal(bodyGateStats(allStored, 2).coverage, 1, 'every head record stored → coverage 1');
  assert.equal(bodyGateStats(allStored, 2).strict, true, 'coverage ≥95% turns the filter on');
}

console.log(`pipeline ok — ${scored.count} skills scored, forks merged ${forks.length}→${dedupedForks.length}`);
