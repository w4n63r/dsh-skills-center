// 采集流水线的单测。跑法：node collector/pipeline.test.mjs（或 npm test 里一起跑）。
// 数据用真实测量值（2026-10-19 采到的 ai-video-generation 六个 fork、12 个技能的真实 installs），
// 不用编造的数字——否则测试只会证明代码符合我的想象。
import assert from 'node:assert/strict';
import { buildCatalog, clusterKey, dedupe, normalizeRecord, scoreRecord, trendPct, auditScore } from './pipeline.mjs';

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

console.log(`pipeline ok — ${scored.count} skills scored, forks merged ${forks.length}→${dedupedForks.length}`);
