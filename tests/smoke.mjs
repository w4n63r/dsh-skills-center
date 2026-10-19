// 冒烟测试：不装 DSH，用假 ctx 走一遍 apply → provider.list/get → 三个工具。
// 运行：node tests/smoke.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = await mkdtemp(join(tmpdir(), 'skills-center-'));
process.env.DSH_HOME = home;

const { apply, name } = await import('../lib/index.js');
const { readActivation, setActive } = await import('../lib/activation.js');
const { MAX_ACTIVE } = await import('../lib/paths.js');

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
assert.deepEqual([...captured.tools.keys()].sort(), ['skill_activate', 'skill_card', 'skill_search']);
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
const search = await captured.tools.get('skill_search').execute({ query: '设计', limit: 3 });
assert.ok(search.results.length > 0, 'Chinese keyword should hit the catalog');
assert.match(search.results[0].line, /装 [\d,]+/);

const blank = await captured.tools.get('skill_search').execute({ query: '', limit: 3 });
assert.equal(blank.results.length, 3, 'empty query lists top scored');

const card = await captured.tools.get('skill_card').execute({ id: skill.slug });
assert.ok(card.ok);
for (const field of ['介绍 —', '用途 —', '使用注意事项 —', '安装数 —', '8 周趋势 —', '来源 —']) {
  assert.ok(card.text.includes(field), `card should expose ${field}`);
}
const missing = await captured.tools.get('skill_card').execute({ id: 'nope/nope' });
assert.equal(missing.ok, false);

const off = await captured.tools.get('skill_activate').execute({ id: skill.id, active: false });
assert.ok(off.ok);
assert.equal((await readActivation()).active.includes(skill.id), false);

// 库存里没有正文的技能：允许激活，但要如实告知 provider 不会暴露它
const noBody = cat.skills.find((s) => s.id !== skill.id);
const partial = await captured.tools.get('skill_activate').execute({ id: noBody.id, active: true });
assert.ok(partial.ok);
assert.equal(partial.needsDownload, true);
assert.match(partial.libraryPath, /library[\\/]/);

// 排序检查：S 分降序即榜单顺序
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

// ---- Web API：status / search / card / 404 ----
const route = captured.routes[0];
assert.equal(route.kind, 'prefix');
assert.equal(route.path, '/api/dsh-skills-center');
async function callApi(pathname) {
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
  await route.handler({ url: pathname }, res);
  return { code: res.statusCode, body: JSON.parse(body) };
}
const status = await callApi('/api/dsh-skills-center/status');
assert.equal(status.code, 200);
assert.equal(status.body.count, cat.count);
assert.equal(status.body.maxActive, MAX_ACTIVE);
assert.ok(Array.isArray(status.body.active));

const apiSearch = await callApi('/api/dsh-skills-center/search?q=design&limit=2');
assert.equal(apiSearch.code, 200);
assert.ok(apiSearch.body.results.length <= 2);

const apiCard = await callApi(`/api/dsh-skills-center/card?id=${encodeURIComponent(skill.id)}`);
assert.equal(apiCard.code, 200);
assert.equal(apiCard.body.id, skill.id);

const api404 = await callApi('/api/dsh-skills-center/nope');
assert.equal(api404.code, 404);
assert.equal(api404.body.error, 'not_found');

await rm(home, { recursive: true, force: true });
console.log('smoke ok — catalog', cat.count, '| top:', list[0].name, '| tools:', [...captured.tools.keys()].join(','));
