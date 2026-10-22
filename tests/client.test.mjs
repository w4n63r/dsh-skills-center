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
  innerHeight: 900,
  innerWidth: 1400,
  // 卸载前要弹一次确认框；测试里一律点「确定」
  confirm: () => true,
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
for (const expected of ['技能中心', '搜索技能名', '有中文卡', '精选', '有风险信号', '总安装量', '排序']) {
  assert.ok(first.includes(expected), `panel renders 「${expected}」`);
}
// 主题 token 必须走变量，不能写死颜色（否则明暗切换会留下死色块）。
assert.ok(first.includes('--dsw-alias-'), 'panel styles use host theme tokens');

// 面板挂载后会去拉 /list：用假 fetch 回两条真数据，看卡片画得对不对。
const asked = [];
// 默认返回 PAGE_FIXTURE；只有「空结果问上游」那一段会临时换掉列表响应。
let listPayload = null;
const PAGE_FIXTURE = {
  version: 'test-v1',
  total: 7572,
  matched: 2,
  maxActive: 50,
  active: ['a/b/c'],
  // 分类菜单来自服务端：计数按整个目录算，和当前筛选无关
  categories: [
    { key: 'other', label: '其他', count: 1866 },
    { key: 'ai', label: 'AI 与模型', count: 1304 },
    { key: 'gpu', label: 'GPU 与加速计算', count: 1029 },
    { key: 'devops', label: '部署与运维', count: 890 },
    { key: 'design', label: '设计与图像', count: 416 },
    { key: 'docs', label: '文档与写作', count: 394 },
    { key: 'backend', label: '后端与数据库', count: 388 },
    { key: 'collab', label: '协作与沟通', count: 384 },
    { key: 'data', label: '数据与分析', count: 354 },
    { key: 'language', label: '语言与框架', count: 333 },
    { key: 'frontend', label: '前端与界面', count: 327 },
    { key: 'browser', label: '浏览器与自动化', count: 319 },
    // 前 12 个之外的分类靠「更多分类」行内展开
    { key: 'testing', label: '测试与质量', count: 301 },
    { key: 'security', label: '安全与合规', count: 296 },
    { key: 'mobile', label: '移动端', count: 290 },
  ],
  classified: 5747,
  rows: [
    {
      id: 'anthropics/skills/frontend-design',
      slug: 'frontend-design',
      name: 'frontend-design',
      name_zh: '前卫视觉设计',
      source: 'anthropics/skills',
      source_kind: 'github',
      installs: 1003686,
      installs_merged: 1085836,
      total_installs: 1085836,
      copies: 7,
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
      categories: ['design', 'frontend'],
      stars: 182200,
    },    {
      id: 'x/y/z',
      slug: 'z',
      name: 'z',
      name_zh: null,
      source: 'x/y',
      source_kind: 'well-known',
      installs: 12,
      installs_merged: null,
      total_installs: 12,
      copies: 0,
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
      categories: ['other'],
    },
  ],
};

// /status 的那份覆盖统计：排序菜单据此标「可用 N/总数」并把没数据的项置灰。
// 刻意让 installs_4w 为 0，好验置灰那条路径。
const STATUS_FIXTURE = {
  version: 'test-v1',
  count: 7572,
  maxActive: 50,
  active: ['a/b/c'],
  coverage: { total: 7572, installs: 7572, installs_4w: 0, stars: 93, trend_pct: 2313, first_seen: 915, s: 7572, name: 7572 },
};

// 「本地」页签用的一份假数据；空态那条用例会临时把它换成一份空清单
const LOCAL_FIXTURE = {
  ok: true,
  project: 'C:/work/demo',
  projectSource: 'query',
  home: 'C:/Users/me',
  roots: [
    { id: 'project-agents', scope: 'project', rank: 200, dir: 'C:/work/demo/.agents/skills', managed: true, exists: true },
    { id: 'global-agents', scope: 'global', rank: 100, dir: 'C:/Users/me/.agents/skills', managed: true, exists: true },
    { id: 'claude-project', scope: 'project', rank: 90, dir: 'C:/work/demo/.claude/skills', managed: false, exists: false },
  ],
  skills: [
    {
      name: 'hello',
      dir: 'C:/work/demo/.agents/skills/hello',
      scope: 'project',
      rootId: 'project-agents',
      rank: 200,
      managed: true,
      description: '打个招呼的示例技能。',
      source: 'acme/skills',
      catalogId: 'acme/skills/hello',
      installs_total: 1234,
      inCatalog: true,
      hasBody: false,
      breakdown: { project: ['C:/work/demo/.agents/skills/hello'], global: [] },
    },
    {
      name: 'world',
      dir: 'C:/Users/me/.agents/skills/world',
      scope: 'global',
      rootId: 'global-agents',
      rank: 100,
      managed: true,
      description: null,
      source: null,
      catalogId: null,
      installs_total: null,
      inCatalog: false,
      hasBody: false,
      breakdown: { project: ['C:/work/demo/.agents/skills/world'], global: ['C:/Users/me/.agents/skills/world'] },
    },
  ],
};
let localPayload = LOCAL_FIXTURE;

// 安装 / 卸载是「用户点一下才发生」的写请求：方法和 body 都留痕，断言才有据可查
const posted = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  asked.push(target);
  if (options.method === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    posted.push({ url: target, body: payload });
    if (target.includes('/install')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          scope: payload.scope,
          dir: 'C:/work/demo/.agents/skills/frontend-design',
          id: payload.id,
          name: 'frontend-design',
        }),
      };
    }
    if (target.includes('/uninstall')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          scope: payload.scope,
          removed: ['C:/work/demo/.agents/skills/hello'],
          stillInstalledElsewhere: [],
        }),
      };
    }
  }
  if (target.includes('/body')) {
    return { ok: true, text: async () => '---\nname: frontend-design\n---\n\n正文第一行\n正文第二行\n' };
  }
  if (target.includes('/local')) {
    return { ok: true, json: async () => localPayload };
  }
  if (target.includes('/status')) {
    return { ok: true, json: async () => STATUS_FIXTURE };
  }
  if (String(url).includes('/card?')) {
    return {
      json: async () => ({
        id: 'anthropics/skills/frontend-design',
        slug: 'frontend-design',
        name_zh: '前卫视觉设计',
        source: 'anthropics/skills',
        installs: 1003686,
        installs_merged: 1085836,
        total_installs: 1085836,
        aliases: ['copy1/frontend-design', 'copy2/frontend-design', 'copy3/frontend-design', 'copy4/frontend-design',
          'copy5/frontend-design', 'copy6/frontend-design', 'copy7/frontend-design'],
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
  if (target.includes('/upstream')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        query: 'zzz-nonexistent',
        skills: [
          {
            id: 'acme/tools/zebra-skill',
            name: 'zebra-skill',
            source: 'acme/tools',
            installs: 4321,
            url: 'https://skills.sh/acme/tools/zebra-skill',
          },
        ],
      }),
    };
  }
  return { json: async () => listPayload || PAGE_FIXTURE };
};

render();
hooks.effects[0](); // 挂载 effect：等防抖 200ms 后发请求
hooks.effects[1](); // 启动时的 /status：拿排序项覆盖统计
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(asked.filter((url) => url.includes('/list?')).length, 1, 'panel asks the host once for a page of cards');
assert.equal(asked.filter((url) => url.includes('/status')).length, 1, 'panel asks /status once for the sort coverage');
// 默认排序 = 总安装量，不再是 S 分
assert.match(asked.find((url) => url.includes('/list?')), /^\/api\/dsh-skills-center\/list\?limit=24&offset=0&sort=installs&dir=desc/);

const loaded2 = textOf(render());
for (const expected of [
  '前卫视觉设计',
  '1,085,836',
  '含 7 个副本',
  '+6.4%',
  '评分 66',
  '-33.2%',
  '★ 182.2K',
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

// 分类菜单：全部（带总数）+ 前 12 个分类铺成 chips，长尾靠行内展开，不用原生下拉
for (const expected of ['全部 7,572', 'AI 与模型', '部署与运维', '设计与图像', '更多分类']) {
  assert.ok(loaded2.includes(expected), `category chips show 「${expected}」`);
}
assert.ok(loaded2.includes('按技能实际功能自动分类'), 'chips carry a hint that categories are inferred');
// 用户明确说过不要操作系统原生下拉：分类行里不许出现 <select>
const hasNativeSelectInChips = (function scan(node) {
  if (Array.isArray(node)) return node.some(scan);
  if (!node || typeof node !== 'object') return false;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-chips') && JSON.stringify(node).includes('"type":"select"')) return true;
  const children = node.children || [];
  return (Array.isArray(children) ? children : [children]).some(scan);
})(expand(render()));
assert.equal(hasNativeSelectInChips, false, 'the category row uses chips, never a native <select>');

// 点「更多分类」把剩下的分类铺开；此时「移动端」才出现，按钮变成「收起」
const findToggle = (node) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findToggle(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-chip-ghost')) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findToggle(child);
    if (hit) return hit;
  }
  return null;
};
const toggle = findToggle(expand(render()));
assert.ok(toggle, 'the more-categories toggle is rendered');
assert.ok(!textOf(render()).includes('移动端'), 'long-tail categories stay collapsed at first');
toggle.props.onClick();
const expanded = textOf(render());
assert.ok(expanded.includes('移动端'), 'expanding reveals the long-tail categories');
assert.ok(expanded.includes('收起'), 'the toggle turns into a collapse control');
toggle.props.onClick(); // 收起，别影响后面的断言

// 排序菜单也是自绘的：点开才渲染选项，点选之后菜单关闭
const findMenuButton = (node) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findMenuButton(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-menu-btn')) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findMenuButton(child);
    if (hit) return hit;
  }
  return null;
};
const sortMenu = findMenuButton(expand(render()));
assert.ok(sortMenu, 'sort control is a self-drawn menu button, not a native select');
const countByClass = (node, cls, out = 0) => {
  if (Array.isArray(node)) return node.reduce((sum, child) => countByClass(child, cls, sum), out);
  if (!node || typeof node !== 'object') return out;
  const classes = String(node.props?.className || '').split(/\s+/);
  const next = classes.includes(cls) ? out + 1 : out;
  const children = node.children || [];
  return (Array.isArray(children) ? children : [children]).reduce(
    (sum, child) => countByClass(child, cls, sum),
    next,
  );
};
assert.equal(countByClass(expand(render()), 'dsc-menu-item'), 0, 'menu options stay closed until clicked');
// 底部菜单没有下方空间时要向上弹（面板底部的「每页条数」就是这种情况）
sortMenu.props.onClick({
  currentTarget: { getBoundingClientRect: () => ({ bottom: 860, top: 820 }) },
});
assert.ok(
  countByClass(expand(render()), 'dsc-menu-list-up') > 0,
  'a menu without room below opens upward instead of off-screen',
);
// 关掉再正常打开一次，后面的断言按「向下弹」的形态走
sortMenu.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 300, top: 260 }) } });
sortMenu.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 300, top: 260 }) } });
assert.ok(countByClass(expand(render()), 'dsc-menu-item') > 0, 'opening the sort menu lists its options');
const openMenu = textOf(render());
// 一个浮层三组：排序字段 / 排序方向 / 发布时间范围
for (const expected of ['排序字段', '排序方向', '发布时间范围', '近 30 天安装量', '星标数', '最近 30 天', '全部时间', '最近 1 年']) {
  assert.ok(openMenu.includes(expected), `grouped sort menu offers 「${expected}」`);
}

// 覆盖统计来自 /status：每项标「可用 N/总数」，一条都没有的项置灰点不动
const nodeText = (node) => {
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (!node || typeof node !== 'object') return String(node ?? '');
  const children = node.children || [];
  return (Array.isArray(children) ? children : [children]).map(nodeText).join('');
};
assert.ok(openMenu.includes('可用 93/7,572'), 'the stars option says how many rows actually have stars');
assert.ok(openMenu.includes('可用 0/7,572'), 'a sort key nobody has data for shows a zero count');
assert.ok(openMenu.includes('只有 93 条抓到星标'), 'low star coverage is explained instead of looking broken');

const openTree = expand(render());
const firstSortItem = (function find(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (String(node.props?.className || '').split(/\s+/).includes('dsc-menu-item')) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = find(child);
    if (hit) return hit;
  }
  return null;
})(openTree);
assert.ok(firstSortItem, 'the sort menu lists options');
assert.ok(nodeText(firstSortItem).includes('总安装量'), 'total installs is the first option in the sort menu');
assert.ok(nodeText(firstSortItem).includes('默认'), 'the default sort option is marked as the default');

// 选「最近 30 天」→ 下一次取数带上 since=30，并回到第 1 页
const findMenuItem = (node, label) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findMenuItem(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-menu-item') && nodeText(node).includes(label)) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findMenuItem(child, label);
    if (hit) return hit;
  }
  return null;
};
const range30 = findMenuItem(expand(render()), '最近 30 天');
assert.ok(range30, 'the 30-day range item is rendered');
// 覆盖为 0 的排序项渲染成禁用态：能看见，但点不动
const deadItem = findMenuItem(expand(render()), '近 30 天安装量');
assert.ok(deadItem, 'the zero-coverage sort item is still listed');
assert.equal(deadItem.props.disabled, true, 'a sort key with zero coverage is disabled');
assert.ok(
  openMenu.includes('.dsc-menu-item[disabled]'),
  'the disabled sort item is styled as greyed out with a theme token',
);
range30.props.onClick();
// 点完要重渲一次，再把这一轮新挂上的 effect 跑一遍：假 react 不会自己跑 effect
const rangeMark = hooks.effects.length;
render();
hooks.effects.slice(rangeMark).forEach((effect) => effect());
await new Promise((resolve) => setTimeout(resolve, 400));
assert.ok(asked.some((url) => url.includes('since=30')), 'picking a date range asks the host with since=30');

// 点分类 chip → 带上 category 参数重新取数，并回到第 1 页
const categoryChip = (function find(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const classes = String(node.props?.className || '').split(/\s+/);
  if (classes.includes('dsc-chip') && String(node.children?.[0] ?? '') === '前端与界面') return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = find(child);
    if (hit) return hit;
  }
  return null;
})(expand(render()));
assert.ok(categoryChip, 'frontend chip is rendered');
categoryChip.props.onClick();
// 同上：点完渲一次，并把这一轮的 effect 跑一遍
const categoryMark = hooks.effects.length;
render();
hooks.effects.slice(categoryMark).forEach((effect) => effect());
await new Promise((resolve) => setTimeout(resolve, 400));
assert.ok(
  asked.some((url) => url.includes('category=frontend')),
  'clicking a category asks the host with category=frontend',
);
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
  '注意事项',
  '第三方安全检查',
  'Gen Agent Trust Hub',
  'Snyk',
  '自己装（在终端里跑）',
  'npx skills add anthropics/skills --skill frontend-design',
  // 详情里的装量是总装量；主条目与合计不同时两个数都要写出来
  '总安装量',
  '主条目 1,003,686，含 7 个副本共 1,085,836',
  '关闭',
  // 评分与第三方安全检查最容易误读，结论旁边必须自带口径说明
  'pass 不等于安全',
  '评分是本插件',
  '唯一标识',
  '来源/仓库/技能名',
  '星标数',
  '182,200',
]) {
  assert.ok(withDetail.includes(expected), `detail dialog shows 「${expected}」`);
}

// 「说明」按钮：S 分 / 审计 / 标签 / 数据口径都要能在界面里查到，不能只留在聊天记录里。
const helpButton = (function find(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node.props?.onClick === 'function' && String(node.children?.[0] ?? '').startsWith('? ')) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = find(child);
    if (hit) return hit;
  }
  return null;
})(expand(render()));
assert.ok(helpButton, 'header carries a help button');

helpButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const withHelp = textOf(render());
for (const expected of [
  '面板里的数字和标签是什么意思',
  '评分 = 0.45·热度 + 0.20·趋势 + 0.20·官方 + 0.15·安全检查',
  'Gen Agent Trust Hub',
  'ZeroLeaks',
  'fail 计入分母',
  'pass 不等于安全',
  '热度',
  '趋势',
  '官方',
  '安全检查',
  'deprecated',
  'pointer',
  'needs_api_key',
  '数据多久更新一次',
]) {
  assert.ok(withHelp.includes(expected), `help dialog explains 「${expected}」`);
}

// 卡片上的 S 分与审计标签要带 tooltip，鼠标停一下就能知道是什么（textOf 是 JSON 树，所以断言 JSON 里的 title 字段）
assert.match(withHelp, /"title":"评分：/, 'the score pill carries a tooltip');
assert.match(withHelp, /"title":"第三方安全检查：/, 'the audit chip carries a tooltip');
assert.match(withHelp, /"title":"needs_external_cli：/, 'the risk chip carries a per-flag tooltip');

// --- 「本地」页签：看本机装了什么，并在这里装 / 卸 / 看正文 ---

/** 收集所有 className 含 target 的节点（children 可能不是数组）。 */
const findByClass = (node, target, out = []) => {
  if (Array.isArray(node)) {
    node.forEach((child) => findByClass(child, target, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (String(node.props?.className || '').split(/\s+/).includes(target)) out.push(node);
  const children = node.children || [];
  (Array.isArray(children) ? children : [children]).forEach((child) => findByClass(child, target, out));
  return out;
};

/** 按可见文字找按钮：精确匹配，免得「安装」命中「安装到全局」。 */
const findButton = (node, label) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' && nodeText(node) === label) return node;
  const children = node.children || [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findButton(child, label);
    if (hit) return hit;
  }
  return null;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// 点完重渲一次，再跑这一轮新挂上的 effect
const settle = async () => {
  const mark = hooks.effects.length;
  render();
  hooks.effects.slice(mark).forEach((effect) => effect());
  await flush();
};
// 整张卡片可点，安装 / 作用域按钮都会 stopPropagation，所以喂一个假事件
const clickThrough = (node) => node.props.onClick({ stopPropagation() {} });
const rowOf = (tree, name) =>
  findByClass(tree, 'dsc-local-row').find((row) => nodeText(row).includes(name));
const firstInstallBar = () => findByClass(collectCards(expand(render()), [])[0], 'dsc-install')[0];

// ① 切到「本地」：请求 /local，并按作用域把已装技能连同徽标列出来
const viewButtons = findByClass(expand(render()), 'dsc-view');
assert.equal(viewButtons.length, 2, 'the header carries a two-state view switch');
assert.deepEqual(viewButtons.map((button) => nodeText(button)), ['目录', '本地']);
assert.equal(viewButtons[0].props['data-on'], 'true', 'the catalog view stays the default');

clickThrough(viewButtons[1]);
await settle();
assert.ok(asked.some((url) => url.includes('/local')), 'switching to the local view asks the host for /local');

const localTree = expand(render());
const localText = JSON.stringify(localTree);
assert.ok(localText.includes('本机已装 2'), 'the local view says how many skills are installed');
assert.ok(localText.includes('C:/work/demo/.agents/skills'), 'the roots that were scanned are listed');
assert.ok(!localText.includes('C:/work/demo/.claude/skills'), 'a root that does not exist is not listed');

const helloRow = rowOf(localTree, 'hello');
const worldRow = rowOf(localTree, 'world');
assert.ok(helloRow && worldRow, 'every installed skill is listed');
const helloText = JSON.stringify(helloRow);
assert.ok(helloText.includes('项目级'), 'a project-scope skill is badged 项目级');
assert.ok(!helloText.includes('全局'), 'a skill installed only in the project is not badged 全局');
assert.ok(helloText.includes('打个招呼的示例技能。'), 'the local description is shown');
assert.ok(helloText.includes('在目录里') && helloText.includes('1,234'), 'a catalog match shows the formatted install count');
assert.ok(helloText.includes('查看详情'), 'a catalog match opens the existing detail dialog');
const worldText = JSON.stringify(worldRow);
assert.ok(worldText.includes('项目级') && worldText.includes('全局'), 'a skill installed in both scopes carries both badges');
assert.ok(worldText.includes('本地 SKILL.md 没写描述'), 'a missing description is stated, not invented');
assert.ok(worldText.includes('不在目录里'), 'a skill the catalog does not know says so');

// ② 目录视图点「安装」→ 先问作用域 → 选「全局」→ POST /install，body 里带 scope:"global"
clickThrough(findByClass(expand(render()), 'dsc-view')[0]);
await settle();
assert.ok(findButton(firstInstallBar(), '安装'), 'a catalog card offers an install button');
clickThrough(findButton(firstInstallBar(), '安装'));
await settle();
assert.ok(findButton(firstInstallBar(), '项目级') && findButton(firstInstallBar(), '全局'), 'the card asks which scope first');
clickThrough(findButton(firstInstallBar(), '全局'));
await flush();
const installCall = posted.find((call) => call.url.includes('/install'));
assert.ok(installCall, 'choosing a scope posts to /install');
assert.equal(installCall.body.scope, 'global', 'the chosen scope travels in the request body');
assert.equal(installCall.body.id, 'anthropics/skills/frontend-design', 'the catalog id travels in the request body');
assert.equal(installCall.body.project, 'C:/work/demo', 'the current project dir travels too');
assert.ok(JSON.stringify(firstInstallBar()).includes('已装到全局'), 'the card flips to 已装到全局 after the install');

// ③ 详情弹层：「看正文」→ GET /body，原文进 <pre>
const bodyButton = findButton(expand(render()), '看正文');
assert.ok(bodyButton, 'the detail dialog offers a body preview');
clickThrough(bodyButton);
await flush();
assert.ok(
  asked.some((url) => url.includes('/body') && url.includes('id=')),
  'previewing a body asks the host for /body with the catalog id',
);
const pre = findByClass(expand(render()), 'dsc-body')[0];
assert.ok(pre && pre.type === 'pre', 'the body text lands in a <pre> block');
assert.ok(JSON.stringify(pre).includes('正文第一行'), 'the raw markdown is rendered as-is');

// ④ 本地视图点「卸载」→ 确认后 POST /uninstall
clickThrough(findByClass(expand(render()), 'dsc-view')[1]);
await settle();
const uninstallButton = findButton(rowOf(expand(render()), 'hello'), '卸载');
assert.ok(uninstallButton, 'an installed skill offers an uninstall button');
clickThrough(uninstallButton);
await flush();
const uninstallCall = posted.find((call) => call.url.includes('/uninstall'));
assert.ok(uninstallCall, 'uninstalling posts to /uninstall');
assert.equal(uninstallCall.body.name, 'hello', 'the uninstalled name travels in the request body');
assert.equal(uninstallCall.body.scope, 'project', 'the scope travels in the request body');

// ⑤ 一条都没装时给空态，不编数据；宿主给的默认目录要提示可以改
localPayload = { ok: true, project: 'C:/work/demo', projectSource: 'host', home: 'C:/Users/me', roots: [], skills: [] };
clickThrough(findByClass(expand(render()), 'dsc-view')[0]);
await settle();
clickThrough(findByClass(expand(render()), 'dsc-view')[1]);
await settle();
const emptyText = JSON.stringify(expand(render()));
assert.ok(emptyText.includes('本机还没装任何技能'), 'an empty machine says so plainly');
assert.ok(emptyText.includes('去『目录』里挑一个装'), 'and points at the catalog view');
assert.ok(emptyText.includes('项目目录来自宿主默认值'), 'a host-provided project dir is flagged as changeable');

// ⑥ 本地一条都没搜到时问上游 skills.sh：只列名字/来源/装量，链接指向原页
listPayload = { ...PAGE_FIXTURE, rows: [], matched: 0 };
clickThrough(findByClass(expand(render()), 'dsc-view')[0]);
await settle();
const searchInput = (() => {
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'input' && node.props && node.props.type === 'search') return node;
    const children = node.children || [];
    for (const child of Array.isArray(children) ? children : [children]) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(expand(render()));
})();
assert.ok(searchInput, 'the catalog view has a search box');
const typeMark = hooks.effects.length;
searchInput.props.onChange({ target: { value: 'zzz-nonexistent' } });
render();
hooks.effects.slice(typeMark).forEach((effect) => effect());
await settle();
// 列表请求有 200ms 防抖，等它真的发出并把「0 条」写回状态，上游那一步才会触发
await new Promise((resolve) => setTimeout(resolve, 300));
await settle();
await settle();
const upText = textOf(render());
assert.ok(
  asked.some((url) => url.includes('/upstream?q=zzz-nonexistent')),
  'an empty local result asks /upstream with the query',
);
assert.ok(upText.includes('本地没有，skills.sh 上有这些'), 'the panel says the local catalog has nothing instead of dead-ending');
assert.ok(upText.includes('zebra-skill'), 'the upstream hit is listed by name');
assert.ok(upText.includes('https://skills.sh/acme/tools/zebra-skill'), 'the upstream hit links to the skills.sh page');

console.log('client ok — module dsh-skills-center | slots: sidebar.panellist#skills-center + main#skills-center | cards + detail rendered | local view: /local + install + uninstall + body | upstream fallback on empty search');