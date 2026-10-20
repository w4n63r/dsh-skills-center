// 浏览器半边只能在宿主里真跑，但它的「形状」与数据路径可以在这里验：
// 模块 id、只 require('react')、apply 注册到哪两个 slot、面板从 fetch 到出表格这一趟。
// 宿主的 ModuleLoader 按 id === 包名 认领模块（cordis-plugin-development/references/ui-plugin.md），
// 这里把它钉住，免得改 package.json 或改 id 时两边悄悄对不上。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};

// 浏览器里这是页面脚本，不是模块；用间接 eval 在全局作用域里跑一遍。
(0, eval)(code);

assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-skills-center', 'module id must equal the package name');
assert.equal(typeof loaded.factory, 'function');

// --- 一个够用的 react 替身：能建树、能存 state、能在 re-render 时保持 state ---
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

// --- 渲染一趟：fetch 到出表格 ---
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
for (const expected of ['技能中心', '安装数', '8 周', '判断', '读取中…', '点左边任意一行看完整卡片。']) {
  assert.ok(first.includes(expected), `panel renders 「${expected}」`);
}
// 主题 token 必须走变量，不能写死颜色（否则明暗切换会留下死色块）。
assert.ok(first.includes('--dsw-alias-'), 'panel styles use host theme tokens');

// 面板的第一次 effect 会去拉 /list：用假的 fetch 回两条真数据，看表格画得对不对。
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  return {
    json: async () => ({
      version: 'test-v1',
      total: 7572,
      matched: 2,
      maxActive: 50,
      active: ['a/b/c'],
      rows: [
        {
          id: 'anthropics/skills/frontend-design',
          slug: 'frontend-design',
          name_zh: '前卫视觉设计',
          installs: 1003686,
          trend_pct: 6.4,
          S: 0.6618,
          verdict: '官方维护',
          flags: [],
          has_zh: true,
        },
        {
          id: 'x/y/z',
          slug: 'z',
          name_zh: null,
          installs: 12,
          trend_pct: -33.2,
          S: 0.31,
          verdict: '看情况（审计存疑）',
          flags: ['needs_external_cli'],
          has_zh: false,
        },
      ],
    }),
  };
};

render();
hooks.effects[0](); // 挂载 effect：等防抖 180ms 后发请求
await new Promise((resolve) => setTimeout(resolve, 260));
assert.equal(asked.length, 1, 'panel asks the host once for a page of rows');
assert.match(asked[0], /^\/api\/dsh-skills-center\/list\?limit=400/);
assert.ok(asked[0].includes('sort=S'));

const loaded2 = textOf(render());
for (const expected of [
  '前卫视觉设计',
  '1,003,686',
  '+6.4%',
  '0.662',
  '-33.2%',
  '看情况（审计存疑）',
  'needs_external_cli',
  'test-v1',
  '已激活 1/50',
]) {
  assert.ok(loaded2.includes(expected), `table shows 「${expected}」`);
}
assert.ok(loaded2.includes('dsc-up'), 'rising trend is coloured by class, not by inline colour');

console.log('client ok — module dsh-skills-center | slots: sidebar.panellist#skills-center + main#skills-center | rows rendered');
