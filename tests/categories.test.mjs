// 功能分类是关键词规则，最怕的是「泛词误伤」和「词边界没管住」。
// 这个测试把两类坑都钉住：该归对的要归对，不该命中的（latest≠test、docker≠doc、skill≠ai）必须不命中。
import assert from 'node:assert/strict';
import { CATEGORIES, CATEGORY_LABELS, classify, categoryCounts } from '../lib/categories.js';

const skill = (slug, extra = {}) => ({ id: `o/r/${slug}`, slug, name: slug, source: 'o/r', ...extra });

// ---- 1) 该归对的 ----
const cases = [
  ['frontend-design', ['design', 'frontend']],
  ['vercel-react-best-practices', ['frontend']],
  ['prisma-postgres', ['backend']],
  ['react-native-app', ['mobile']],
  ['ios-widget-kit', ['mobile']],
  ['azure-compliance', ['security']],
  ['remotion-best-practices', ['media']],
  ['playwright-e2e', ['testing']],
  ['code-review-checklist', ['review']],
  ['dotnet-best-practices', ['language']],
  ['kubernetes-deploy', ['devops']],
  ['xlsx-report', ['office']],
  ['stripe-checkout', ['commerce']],
  ['clerk-webhooks', ['security']],
  ['nda-review', ['legal']],
  ['roadmap-update', ['product']],
  ['slack-standup', ['collab']],
  ['nvidia-cuda-guide', ['gpu']],
  ['seo-brief', ['marketing']],
  ['sentry-triage', ['debug']],
  ['postgres-migration-plan', ['backend']],
];
for (const [slug, expected] of cases) {
  const got = classify(skill(slug));
  for (const key of expected) {
    assert.ok(got.includes(key), `${slug} 应归到 ${CATEGORY_LABELS[key]}，实际 ${got.map((k) => CATEGORY_LABELS[k]).join('/')}`);
  }
}

// ---- 2) 词边界与泛词：这几条是踩过的坑 ----
const mustNotMatch = [
  ['latest-updates', 'testing', 'latest 里含 test，但那是子串'],
  ['docker-helper', 'docs', 'docker 里含 doc，但那是子串'],
  ['contest-runner', 'testing', 'contest 里含 test'],
  ['find-skills', 'ai', '词表里不许放泛词 skill，否则什么都归 AI'],
  ['list-agents', 'ai', 'agent 也是泛词'],
];
for (const [slug, forbidden, why] of mustNotMatch) {
  const got = classify(skill(slug));
  assert.ok(!got.includes(forbidden), `${slug} 不该归到 ${CATEGORY_LABELS[forbidden]}（${why}），实际 ${got.join('/')}`);
}

// AI 分类本身还是要能命中真东西
assert.ok(classify(skill('prompt-optimizer')).includes('ai'));
assert.ok(classify(skill('rag-blueprint')).includes('ai'));

// ---- 3) 兜底与上限 ----
assert.deepEqual(classify(null), ['other']);
assert.deepEqual(classify({}), ['other']);
assert.deepEqual(classify(skill('zzz-unknown-thing')), ['other']);
const many = classify({ ...skill('react-test-deploy-design'), zh: { intro: '写文档、做营销、跑数据' } }, { max: 3 });
assert.equal(many.length, 3, '最多三个标签');

// ---- 4) 计数：总和会大于条数（一条技能进多个分类），且每个 key 都在表里 ----
const counts = categoryCounts([skill('frontend-design'), skill('prisma-postgres'), skill('zzz-unknown')]);
assert.equal(counts.total, 3);
assert.equal(counts.classified, 2, '两个能分类，一个落到其他');
const sum = Object.values(counts.counts).reduce((a, b) => a + b, 0);
assert.ok(sum >= counts.classified, '多标签会让计数总和 >= 已分类条数');
assert.deepEqual(Object.keys(counts.counts).sort(), CATEGORIES.map((c) => c.key).sort());
assert.equal(typeof counts.counts.other, 'number');

console.log(
  `categories ok — ${CATEGORIES.length} 个分类，${cases.length} 条归类断言 + ${mustNotMatch.length} 条词边界断言`,
);
