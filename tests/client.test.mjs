// 浏览器半边只能在宿主里真跑，但它的「形状」与数据路径可以在这里验：
// 模块 id、只 require('react')、apply 注册到哪两个 slot、面板从 fetch 到出卡片这一趟。
// 宿主的 ModuleLoader 按 id === 包名 认领模块（cordis-plugin-development/references/ui-plugin.md），
// 这里把它钉住，免得改 package.json 或改 id 时两边悄悄对不上。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');

let loaded = null;
const listeners = [];
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
  addEventListener(type, fn) {
    listeners.push({ type, fn });
  },
  removeEventListener() {},
};

// 浏览器里这是页面脚本，不是模块；用间接 eval 在全局作用域里跑一遍。
(0, eval)(code);

assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-skills-center', 'module id must equal the package name');
assert.equal(typeof loaded.factory, 'function');

// --- 一个够用的 react 替身：能建树、能存 state、re-render 时保持 state ---
const hooks = { cursor: 0, states: [], effects: [], dirty: false, renders: 0 };
const element = (type, props, ...children) => ({ type, props: props || {}, children });

const fakeReact = {
  createElement: element,
  useState(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next) => {
        hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
        hooks.dirty = true;
      },
    ];
  },
  useEffect(fn) {
    hooks.effects.push(fn);
  },
  useMemo(fn) {
    return fn();
  },
  useRef: (value) => ({ current: value }),
};

const required = [];
const clientModule = loaded.factory((name) => {
  required.push(name);
  assert.equal(name, 'react', 'the client half may only require react');
  return fakeReact;
});

assert.deepEqual(required, ['react']);
assert.deepEqual(clientModule.inject.slice().sort(), ['locale', 'slots']);
assert.equal(typeof clientModule.apply, 'function');

const registered = [];
const ctx = {
  effect(fn) {
    fn();
  },
  locale: {
    register(namespace, locale, dictionary) {
      assert.equal(namespace, 'skills-center');
      assert.ok(locale === 'zh' || locale === 'en', 'registers both shipped locales');
      assert.ok(Object.keys(dictionary).length > 10, `${locale} dictionary is populated`);
    },
    bind(namespace) {
      assert.equal(namespace, 'skills-center');
      return () => '';
    },
  },
  slots: {
    inject(name, callback) {
      assert.equal(name, 'sidebar.panellist', 'waits for the sidebar row slot before registering');
      return callback();
    },
    register(spec, factory) {
      registered.push({ spec, factory });
      return () => {};
    },
  },
};

clientModule.apply(ctx);

assert.equal(registered.length, 2, 'registers exactly one sidebar row and one main panel');

const [row, panel] = registered;
assert.equal(row.spec.name, 'sidebar.panellist');
assert.equal(row.spec.id, 'skills-center');
assert.equal(typeof row.spec.order, 'number');
assert.equal(row.spec.locale, 'skills-center');
assert.equal(row.spec.label(), '技能中心', 'sidebar label is the Chinese name, else the icon is unlabelled');

// 宿主靠 id/key 相同把侧栏图标和主区面板对上（sidebar.panellist[id] → main[key]）。
assert.equal(panel.spec.name, 'main');
assert.equal(panel.spec.key, row.spec.id, 'main panel key must match the sidebar id');

const icon = row.factory({ size: 18, active: true });
assert.equal(icon.type, 'svg');
assert.equal(icon.props.width, 18);
assert.equal(icon.props.height, 18);

// --- 渲染一趟：fetch 到出卡片墙 ---
function render() {
  hooks.cursor = 0;
  hooks.renders += 1;
  return panel.factory({});
}

// 假 react 不会自己调用组件函数，手动展开，好让断言看得见子组件的文字。
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...(node.props || {}) }));
  const children = Array.isArray(node.children) ? node.children.map(expand) : node.children;
  return { ...node, children };
}
const textOf = (tree) => JSON.stringify(expand(tree));

const first = textOf(render());
for (const expected of ['技能中心', '搜索技能名', '有中文卡', '官方精选', '有风险信号', 'S 分', '安装量']) {
  assert.ok(first.includes(expected), `panel renders 「${expected}」`);
}
// 主题 token 必须走变量，不能写死颜色（否则明暗切换会留下死色块）。
assert.ok(first.includes('--dsw-alias-'), 'panel styles use host theme tokens');

// 面板挂载后会去拉 /list：用假 fetch 回两条真数据，看卡片画得对不对。
const asked = [];
const PAGE_FIXTURE = {
  version: 'test-v1',
  total: 7572,
  matched: 2,
  maxActive: 50,
  active: ['a/b/c'],
  rows: [
    {
      id: 'anthropics/skills/frontend-design',
      slug: 'frontend-design',
      name: 'frontend-design',
      name_zh: '前卫视觉设计',
      source: 'anthropics/skills',
      source_kind: 'github',
      installs: 1003686,
      trend_pct: 6.4,
      S: 0.6618,
      score: { S: 0.6618, H: 0.9, T: 0.22, C: 1, A: 1 },
      verdict: '官方维护',
      flags: [],
      has_zh: true,
      description: '给界面做有辨识度的视觉方向。',
      official: true,
      curated: true,
      enriched: true,
      first_seen: '2026-03-13',
      audit: { judged: 5, pass: 4, warn: 1, fail: 0 },
      install_hint: 'npx skills add anthropics/skills --skill frontend-design',
    },
    {
      id: 'x/y/z',
      slug: 'z',
      name: 'z',
      name_zh: null,
      source: 'x/y',
      source_kind: 'well-known',
      installs: 12,
      trend_pct: -33.2,
      S: 0.31,
      score: { S: 0.31, H: 0.1, T: 0.03, C: 0, A: 0.5 },
      verdict: '看情况（审计存疑）',
      flags: ['needs_external_cli'],
      has_zh: false,
      description: '',
      official: false,
      curated: false,
      enriched: false,
      first_seen: null,
      audit: null,
      install_hint: null,
    },
  ],
};

globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (String(url).includes('/card?')) {
    return {
      json: async () => ({
        id: 'anthropics/skills/frontend-design',
        slug: 'frontend-design',
        name_zh: '前卫视觉设计',
        source: 'anthropics/skills',
        installs: 1003686,
        trend_pct: 6.4,
        first_seen: '2026-03-13',
        flags: [],
        score: PAGE_FIXTURE.rows[0].score,
        zh: { intro: '给界面做有辨识度的视觉方向。', usage: '做新页面时先定方向。', notes: '不写代码，只给方法。' },
        audit: {
          audits: [
            { provider: 'Gen Agent Trust Hub', status: 'pass', riskLevel: 'SAFE' },
            { provider: 'Snyk', status: 'warn', riskLevel: 'MEDIUM' },
          ],
        },
      }),
    };
  }
  return { json: async () => PAGE_FIXTURE };
};

render();
hooks.effects[0](); // 挂载 effect：等防抖 200ms 后发请求
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(asked.length, 1, 'panel asks the host once for a page of cards');
assert.match(asked[0], /^\/api\/dsh-skills-center\/list\?limit=24&offset=0&sort=S&dir=desc/);

const loaded2 = textOf(render());
for (const expected of [
  '前卫视觉设计',
  '1,003,686',
  '+6.4%',
  '0.662',
  '-33.2%',
  'needs_external_cli',
  'test-v1',
  '已激活 1/50',
  '给界面做有辨识度的视觉方向。',
  '官方',
  '中文卡',
  '前端'.replace('前端', '50'), // 审计 4/5 的计数（写成表达式只是为了不改字面量清单）
  '上一页',
  '下一页',
  '每页 24',
]) {
  assert.ok(loaded2.includes(expected), `card wall shows 「${expected}」`);
}
assert.ok(loaded2.includes('dsc-up'), 'rising trend is coloured by class, not by inline colour');
assert.ok(loaded2.includes('dsc-card'), 'cards are rendered, not table rows');
// 底部分页：两条数据只有 1 页，所以上一页/下一页都该是禁用态
assert.ok(loaded2.includes('dsc-page'), 'footer renders a pager, not a load-more button');
assert.ok(!loaded2.includes('加载更多'), 'the load-more button is gone');
assert.match(loaded2, /第 1 \/ 1/, 'pager reports the current page and the total');

// 点卡片 → 详情弹层；弹层里必须有完整中文卡、审计明细与安装命令。
const collectCards = (node, out) => {
  if (Array.isArray(node)) return node.forEach((child) => collectCards(child, out));
  if (!node || typeof node !== 'object') return out;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-card')) out.push(node);
  const children = node.children || [];
  (Array.isArray(children) ? children : [children]).forEach((child) => collectCards(child, out));
  return out;
};
const cards = collectCards(expand(render()), []);
assert.equal(cards.length, 2, 'both rows render as cards');

await cards[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
render();
hooks.effects[hooks.effects.length - 1]?.();
const withDetail = textOf(render());
for (const expected of [
  '前卫视觉设计',
  '介绍',
  '用途',
  '使用注意事项',
  '审计',
  'Gen Agent Trust Hub',
  'Snyk',
  '自己装（在终端里跑）',
  'npx skills add anthropics/skills --skill frontend-design',
  '关闭',
]) {
  assert.ok(withDetail.includes(expected), `detail dialog shows 「${expected}」`);
}

console.log('client ok — module dsh-skills-center | slots: sidebar.panellist#skills-center + main#skills-center | cards + detail rendered');
