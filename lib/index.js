// dsh-skills-center — 插件入口。
// 只做「目录 + 判断 + 激活」三件事；在线搜索与安装交给 skills-manager / npx skills。
import { createProvider, libraryPathFor } from './provider.js';
import { searchSkills, getSkill, renderCard, verdictOf, loadCatalog, browseSkills, categoriesOf, coverageOf, totalInstalls, DEFAULT_SORT } from './catalog.js';
import { CATEGORY_LABELS } from './categories.js';
import { setActive, readActivation } from './activation.js';
import { checkForUpdate, syncCatalog, readSyncMeta, SYNC_URL_ENV } from './sync.js';
import { rankingPayload, renderRankingPage } from './page.js';
import { MAX_ACTIVE, BODY_CACHE_DIR } from './paths.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const fileExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// 安装器内核单独一个模块：它只做「列目录 + 拼命令 + 校验落点」，跑进程的适配器由路由注入。
// 模块缺失时不要让整个插件挂掉——只在调用安装/卸载时如实回 501。
const loadInstaller = async () => {
  try {
    return await import('./installer.js');
  } catch {
    return null;
  }
};

// 全局根按 DSH 约定推导：~/.dsh/skills 与 ~/.agents/skills。
// DSH_HOME 指到别处时取它的上一级当 home（约定目录名就是 .dsh）。
const rootsHome = () => (process.env.DSH_HOME ? dirname(process.env.DSH_HOME) : homedir());

// Web 路由里没有 session，拿不到「当前会话工作目录」；宿主的 defaultDirectory 就是它的兜底值。
const defaultProjectDir = (ctx) => (ctx && ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd();

// 宿主没有通用的「跑命令」服务，但有 subprocess 抽象服务：由它解析可执行文件、托管进程与回收输出。
const subprocessSpawn = (ctx) => async ({ argv, cwd }) => {
  const sp = ctx && ctx.subprocess;
  if (!sp) return { exitCode: null, stdout: '', stderr: 'subprocess service is unavailable' };
  // installer 的 argv 是 npx 的参数表（以 `-y skills@1.7.4` 开头），可执行文件由这里解析。
  const exe = await sp.resolveExecutable('npx');
  const handle = sp.spawn({
    argv: [exe, ...argv],
    cwd,
    graceMs: 15000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });
  const done = await handle.done;
  return {
    exitCode: done.exitCode,
    stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
    stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
  };
};

const readJsonBody = async (req) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// 正文按内容寻址：<sha256>.md 的名字就是它的指纹，命中缓存就是命中同一份字节，不需要失效判断。
const readBodyCache = async (sha) => {
  try {
    return await readFile(join(BODY_CACHE_DIR, `${sha}.md`), 'utf8');
  } catch {
    return null;
  }
};

const writeBodyCache = async (sha, text) => {
  try {
    await mkdir(BODY_CACHE_DIR, { recursive: true });
    await writeFile(join(BODY_CACHE_DIR, `${sha}.md`), text, 'utf8');
  } catch {
    // 缓存写不进去不该让请求失败：正文已经拿到了，下次再抓一遍而已。
  }
};

export const name = 'dsh-skills-center';
// subprocess：装/卸技能走官方 CLI；workingDirectory：Web 路由没有 session，只能拿宿主的默认目录兜底。
export const inject = ['tools', 'skills', 'webServer', 'subprocess', 'workingDirectory'];

const asText = (text) => [{ type: 'text', text }];

// dsh-tools 会按 output.schema 校验 execute 的返回值，且要求 render 无损投影回原值
// (dsh-tools:3637-3648)。一个 undefined 属性就不是合法 JSON（JSON.stringify 会静默删掉它），
// 表现为 "tool returned invalid output: value is not lossless JSON"。
// 所以出口统一过一遍 JSON 往返，把 undefined / 不可序列化的东西提前清干净。
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function oneLine(skill) {
  const trend = skill.trend_pct == null ? '' : ` ${skill.trend_pct > 0 ? '+' : ''}${skill.trend_pct}%`;
  const rating = Math.round((skill.score?.S ?? 0) * 100);
  const cats = (skill.categories || []).map((key) => CATEGORY_LABELS[key]).filter(Boolean);
  const category = cats.length ? ` · 分类 ${cats.join('/')}` : '';
  return `${skill.slug}${skill.name_zh ? `（${skill.name_zh}）` : ''} — ${verdictOf(skill)} · 装 ${skill.installs ?? '—'}${trend} · 评分 ${rating}${category}`;
}

export function apply(ctx, config = {}) {
  let invalidateProvider = () => {};

  // 分类是按关键词算的：整目录算一遍约 1.5s。启动时空转一次，用户点开面板时就已经在缓存里了。
  // 失败不影响任何功能——真到查询那一步还会再算一次。
  void loadCatalog()
    .then((catalog) => categoriesOf(catalog))
    .catch(() => {});

  // 「远端有没有新版」：HEAD + If-None-Match，不下载正文（6MB）。启动查一次，之后每 6 小时一次。
  // 查不到就当不知道，绝不因为它挡住任何功能。
  let remoteState = { checkedAt: null, updateAvailable: false, reason: 'pending' };
  const checkRemote = async () => {
    try {
      const result = await checkForUpdate();
      remoteState = {
        checkedAt: result.checkedAt || new Date().toISOString(),
        updateAvailable: Boolean(result.updateAvailable),
        reason: result.ok ? (result.updateAvailable ? 'update_available' : 'up_to_date') : result.reason || 'unknown',
      };
    } catch (error) {
      remoteState = { checkedAt: new Date().toISOString(), updateAvailable: false, reason: String(error?.message || error) };
    }
    return remoteState;
  };
  void checkRemote();
  const timer = setInterval(() => void checkRemote(), 6 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearInterval(timer), 'skills-center: remote update check');

  // 1) 技能 provider：激活集合决定系统提示里出现哪些技能
  if (ctx.skills && typeof ctx.skills.registerProvider === 'function') {
    const factory = createProvider(config);
    ctx.effect(
      () =>
        ctx.skills.registerProvider((control) => {
          invalidateProvider = () => control.invalidate?.();
          return factory(control);
        }),
      'skills-center skill provider',
    );
  }

  // 2) 召回提示：光有工具不够，模型得先想起来去查。
  // 文本故意是静态字符串：section 的 provider 每次组装系统提示都会重跑，动态文本会把
  // prompt cache 每步打掉一次；这里只承诺「目录存在」，不含条数之类的易变事实。
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt;
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'dsh-skills-center',
          order: 850,
          text: [
            'A local catalog of skills.sh skills is available in this session.',
            'Before answering "how do I do X" / "is there a skill or plugin for X", call `skill_search` once — many entries carry a Chinese card; then `skill_card` for the details of a hit.',
            'Do not claim a skill exists unless it came from these tools.',
          ].join('\n'),
        }),
      'skills-center recall hint',
    );
  }

  // 2b) 更硬的一条召回：把「技能中心」注册成宿主的运行时技能。
  // 宿主每一步都会把可被模型调用的技能列表（名字 + 描述）拼进提示，所以模型在会话一开始
  // 就能看见这个入口，而不是等它想起去调 skill_search。走宿主自己的注入通道，不碰消息流。
  const skills = (typeof ctx.get === 'function' ? ctx.get('skills') : null) || ctx.skills;
  if (skills && typeof skills.register === 'function') {
    ctx.effect(
      () =>
        skills.register({
          name: 'skills-center',
          description:
            '搜索并安装 skills.sh 上的技能：本地目录按总安装量排序，带中文说明、评分和第三方安全检查结论。',
          whenToUse:
            '当用户问「有没有现成的技能或工具」「这件事怎么做」，或者要安装、卸载某个技能时',
          content: [
            '# 技能中心（skills-center）',
            '',
            '本地目录收录 skills.sh 上的技能，按总安装量排序；只有抓到正文和描述的条目才收录。',
            '会话里用这四个工具：',
            '',
            '- `skill_search <关键词>`：先用它。中文命中中文卡，英文命中上游描述。',
            '- `skill_card <id 或名字>`：看详情——中文介绍、用途、注意事项、安装量、8 周趋势、第三方安全检查结论。',
            '- `skill_activate <id>`：把技能正文存到本地面板（预览用，不是安装）。',
            '- `skill_sync`：检查并拉取最新目录。',
            '',
            '真要装给 DSH 用，走面板（侧边栏「技能中心」）：目录页签按分类/中文卡/风险筛选，卡片上选项目级或全局安装；本地页签列出已装技能并可卸载。装的是官方 CLI 落点（`npx skills add … -a codex --copy`），装完 DSH 直接能用。',
            '',
            '口径（别说过头）：',
            '',
            '- 第三方安全检查是 skills.sh 上五家工具各自的结论，pass 不等于安全，fail 也可能是误报。',
            '- 评分是本插件按「安装量 + 趋势 + 官方 + 安全检查」合成的排序分，不是 skills.sh 官方的分数。',
            '- 中文卡分两层：人工精写的少量，加按正文自动生成的，仍在扩量；没有中文卡的条目只有上游英文描述。',
          ].join('\n'),
          source: 'runtime',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'skills-center catalog skill',
    );
  }

  // 3) 四个工具，刻意保持最少
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'skill_search',
          description:
            'Search the local skills.sh catalog (Chinese cards included). Use when the user asks what skills exist for a task, or before writing one yourself. Returns id + Chinese one-liner + verdict + install counts.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Keywords; empty string lists the top scored skills.' },
              limit: { type: 'integer', description: 'Max results, default 10, max 50.' },
            },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object' },
            render: (_args, value) =>
              asText(
                value?.results?.length
                  ? value.results.map((r) => r.line).join('\n')
                  : `没有匹配的技能（目录 ${value?.count ?? 0} 条）`,
              ),
          },
          async execute(args = {}) {
            const cat = await loadCatalog();
            const results = await searchSkills(args.query || '', args.limit || 10);
            return plain({
              count: cat.count,
              version: cat.version,
              results: results.map((s) => ({ id: s.id, slug: s.slug, S: s.score?.S ?? null, line: oneLine(s) })),
            });
          },
          presentCall: (args) => ({ card: 'generic', title: 'Search skill catalog', kind: 'read', rawInput: args?.query }),
        }),
      'skills-center skill_search tool',
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'skill_card',
          description:
            'Show the full Chinese card for one skill: intro, usage, caveats, install count, 8-week trend, source. Use before recommending or installing a skill.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Catalog id (source/slug) or bare slug.' } },
            required: ['id'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object' },
            render: (_args, value) => asText(value?.ok ? value.text : `没找到：${value?.id}`),
          },
          async execute(args = {}) {
            const skill = await getSkill(args.id);
            if (!skill) return { ok: false, id: args.id };
            return plain({
              ok: true,
              id: skill.id,
              installs: skill.installs,
              trend_pct: skill.trend_pct,
              source: skill.source,
              flags: skill.flags ?? [],
              text: renderCard(skill),
            });
          },
          presentCall: (args) => ({ card: 'generic', title: 'Skill card', kind: 'read', rawInput: args?.id }),
        }),
      'skills-center skill_card tool',
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'skill_activate',
          description: `Turn a library skill on or off. Activated skills are injected into the prompt, so the cap is ${MAX_ACTIVE}. Only works when the SKILL.md is present in the local library.`,
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Catalog id or slug.' },
              active: { type: 'boolean', description: 'true to activate (default), false to deactivate.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object' },
            render: (_args, value) => {
              if (!value?.ok) return asText(`激活失败：${value?.reason || 'unknown'}`);
              const head = `${value.active ? '已激活' : '已停用'} ${value.id}（当前 ${value.count}/${MAX_ACTIVE}）`;
              return asText(value.needsDownload ? `${head}\n注意：库存里没有正文，provider 不会暴露它。先下载到 ${value.libraryPath}` : head);
            },
          },
          async execute(args = {}) {
            const skill = await getSkill(args.id);
            if (!skill) return { ok: false, reason: `目录里没有 ${args.id}` };
            const shouldActivate = args.active !== false;
            const result = await setActive(skill.id, shouldActivate);
            if (result.ok) invalidateProvider();
            const libraryPath = libraryPathFor(skill);
            const hasBody = shouldActivate ? await fileExists(libraryPath) : true;
            return plain({
              ok: result.ok,
              id: skill.id,
              active: shouldActivate,
              count: result.active.length,
              reason: result.reason,
              libraryPath,
              needsDownload: !hasBody,
            });
          },
          presentCall: (args) => ({ card: 'generic', title: 'Activate skill', kind: 'edit', rawInput: args?.id }),
        }),
      'skills-center skill_activate tool',
    );

    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'skill_sync',
          description: `Pull the skills.sh catalog produced by the collector into ~/.dsh/skills-center/catalog/catalog.json, so search/card work on the full feed instead of the bundled sample. Reads the URL from the url argument or the ${SYNC_URL_ENV} environment variable; a local file path or file:// URL also works. Old catalog is kept as catalog.prev.json.`,
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: `http(s) URL, local path, or file:// URL of catalog.json. Defaults to ${SYNC_URL_ENV}.` },
              force: { type: 'boolean', description: 'Rewrite even when the content hash is unchanged.' },
            },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object' },
            render: (_args, value) => {
              if (!value?.ok) return asText(`目录同步失败：${value?.reason || 'unknown'}`);
              const head = value.changed
                ? `目录已同步：${value.count} 条（${value.version || '无版本号'}）← ${value.source}`
                : `目录没变：仍是 ${value.count} 条（${value.version || '无版本号'}），内容 hash 一致`;
              return asText(`${head}\n落盘 ${value.file} · 通过 ${value.via} · ${value.bytes} 字节 · ${value.elapsedMs}ms`);
            },
          },
          async execute(args = {}) {
            const result = await syncCatalog({ url: args.url, force: args.force === true });
            return plain(result);
          },
          presentCall: (args) => ({ card: 'generic', title: 'Sync skill catalog', kind: 'edit', rawInput: args?.url }),
        }),
      'skills-center skill_sync tool',
    );
  }

  // 3) 给 GUI 的最小只读接口
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/dsh-skills-center',
          handler: async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const send = (code, body) => {
              res.statusCode = code;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(body));
            };
            try {
              if (url.pathname === '/api/dsh-skills-center/' || url.pathname === '/api/dsh-skills-center') {
                // 榜单页：只读 HTML，目录内联但只带前 PAGE_ROWS 条——真实目录七千多条，
                // 全量内联会让这个 HTML 涨到几 MB。排序/搜索作用于内联的这批，卡片详情走 /card
                // 接口（对任意 id 都成立），所以内联不是能力上限。
                const cat = await loadCatalog();
                const { active } = await readActivation();
                const PAGE_ROWS = 500;
                // 内联 = 前 PAGE_ROWS 条（按 S）+ 所有有中文卡的条目。中文卡是最该被看见的东西，
                // 只按 S 截断会让一部分中文卡掉出页面。
                const picked = new Map();
                for (const s of cat.skills.slice(0, PAGE_ROWS)) picked.set(s.id, s);
                for (const s of cat.skills) {
                  if (s.zh?.intro && !picked.has(s.id)) picked.set(s.id, s);
                }
                const inline = [...picked.values()].map((s) => ({ ...s, verdict: verdictOf(s) }));
                const html = renderRankingPage(
                  rankingPayload({
                    version: cat.version,
                    count: cat.count,
                    shown: inline.length,
                    active,
                    maxActive: MAX_ACTIVE,
                    skills: inline,
                  }),
                );
                res.statusCode = 200;
                res.setHeader('content-type', 'text/html; charset=utf-8');
                return res.end(html);
              }
              if (url.pathname === '/api/dsh-skills-center/status') {
                const cat = await loadCatalog();
                const { active } = await readActivation();
                return send(200, {
                  version: cat.version,
                  count: cat.count,
                  active,
                  maxActive: MAX_ACTIVE,
                  catalogFile: cat.__file,
                  // 排序菜单要标「可用 N/总数」：各排序键在全目录里有多少条真的有值。
                  // 数据来自已加载的目录对象，不再读一次盘。
                  coverage: coverageOf(cat),
                  synced: await readSyncMeta(),
                  syncUrl: process.env[SYNC_URL_ENV] ?? null,
                  remote: remoteState,
                });
              }
              if (url.pathname === '/api/dsh-skills-center/search') {
                const q = url.searchParams.get('q') || '';
                const limit = Number(url.searchParams.get('limit')) || 10;
                const results = await searchSkills(q, limit);
                return send(200, { results });
              }
              if (url.pathname === '/api/dsh-skills-center/list') {
                // GUI 面板的浏览接口：分页 + 关键词 + 筛选 + 排序方向。
                // 只回一张卡片要用的字段，整条记录连正文一起发会把响应撑到几 MB。
                const { active } = await readActivation();
                const page = await browseSkills({
                  q: url.searchParams.get('q') || '',
                  limit: Number(url.searchParams.get('limit')) || 300,
                  offset: Number(url.searchParams.get('offset')) || 0,
                  onlyZh: url.searchParams.get('zh') === '1',
                  filter: url.searchParams.get('filter') || '',
                  category: url.searchParams.get('category') || '',
                  sinceDays: Number(url.searchParams.get('since') || 0) || 0,
                  // 默认按总安装量降序；显式传 sort=s 仍按 S 分（综合分）
                  sort: url.searchParams.get('sort') || DEFAULT_SORT,
                  dir: url.searchParams.get('dir') || 'desc',
                });
                // 面板不需要额外请求就能知道远端有没有新版（宿主每 6 小时查一次 HEAD）
                return send(200, { ...page, active, maxActive: MAX_ACTIVE, remote: remoteState });
              }
              if (url.pathname === '/api/dsh-skills-center/card') {
                const skill = await getSkill(url.searchParams.get('id') || '');
                // 顺手带上渲染好的卡片文本：榜单页的详情栏就用它，别让消费方自己拼
                return skill ? send(200, { ...skill, text: renderCard(skill) }) : send(404, { error: 'not_found' });
              }
              if (url.pathname === '/api/dsh-skills-center/body') {
                // 正文按内容寻址取：目录条目里只有 body.sha256，正文在 body_base/<sha256>.md。
                // 本地缓存一份——面板预览和「安装」都要正文，同一份抓两遍没有意义。
                const id = url.searchParams.get('id') || '';
                let sha = (url.searchParams.get('sha') || '').toLowerCase();
                if (!sha && id) {
                  const skill = await getSkill(id);
                  sha = (skill && skill.body && skill.body.sha256) || '';
                  if (!sha) return send(404, { error: 'no_body', id });
                }
                if (!/^[0-9a-f]{64}$/.test(sha)) return send(400, { error: 'bad_sha' });
                let text = await readBodyCache(sha);
                let via = 'cache';
                if (text == null) {
                  const cat = await loadCatalog();
                  const base = cat.body_base;
                  if (!base) return send(409, { error: 'no_body_base' });
                  const upstream = await fetch(`${base}/${sha}.md`);
                  if (!upstream.ok) return send(502, { error: `body_fetch_${upstream.status}` });
                  text = await upstream.text();
                  via = 'remote';
                  await writeBodyCache(sha, text);
                }
                res.statusCode = 200;
                res.setHeader('content-type', 'text/markdown; charset=utf-8');
                // 内容寻址：同一个 URL 永远是同一份字节，可以放心长缓存
                res.setHeader('cache-control', 'public, max-age=31536000, immutable');
                res.setHeader('x-body-via', via);
                return res.end(text);
              }
              if (url.pathname === '/api/dsh-skills-center/local') {
                // 本地已有技能清单：扫 DSH 真正会读的那几个根（一层深），项目级与全局分别标出。
                const installer = await loadInstaller();
                if (!installer) return send(501, { error: 'installer_unavailable' });
                const asked = url.searchParams.get('project');
                const project = asked || defaultProjectDir(ctx);
                const home = rootsHome();
                const listed = installer.listInstalled({ projectDir: project, home });
                // 和目录连接一次：本地目录名就是技能 slug，用它找目录条目，补上来源/总装量/正文缓存状态。
                const cat = await loadCatalog();
                const bySlug = new Map();
                for (const row of cat.skills || []) {
                  const key = String(row.slug || '').toLowerCase();
                  if (key && !bySlug.has(key)) bySlug.set(key, row);
                }
                const groups = new Map();
                for (const item of listed.skills) {
                  const key = basename(item.dir).toLowerCase();
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key).push(item);
                }
                const skills = [];
                for (const item of listed.skills) {
                  const key = basename(item.dir).toLowerCase();
                  const hit = bySlug.get(key) || null;
                  const group = groups.get(key) || [item];
                  const sha = hit && hit.body && hit.body.sha256;
                  skills.push({
                    ...item,
                    slug: key,
                    catalogId: hit ? hit.id : null,
                    inCatalog: Boolean(hit),
                    source: hit ? hit.source : null,
                    installs_total: hit ? totalInstalls(hit) : null,
                    hasBody: sha ? await fileExists(join(BODY_CACHE_DIR, `${sha}.md`)) : false,
                    breakdown: {
                      project: group.filter((g) => g.scope === 'project').map((g) => g.dir),
                      global: group.filter((g) => g.scope === 'global').map((g) => g.dir),
                    },
                  });
                }
                return send(200, {
                  ok: true,
                  project,
                  projectSource: asked ? 'query' : 'host',
                  home,
                  roots: listed.roots,
                  skills,
                });
              }
              if (url.pathname === '/api/dsh-skills-center/install') {
                // 走官方 CLI（npx skills add ... -a codex）：项目级落 <项目>/.agents/skills，
                // 全局落 ~/.agents/skills —— 正好是 DSH 扫描半径里的两个根。
                if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                const installer = await loadInstaller();
                if (!installer) return send(501, { error: 'installer_unavailable' });
                const payload = await readJsonBody(req);
                if (!payload) return send(400, { error: 'bad_json' });
                const skill = await getSkill(String(payload.id || ''));
                if (!skill) return send(404, { error: 'unknown_skill', id: payload.id || null });
                const scope = payload.scope === 'global' ? 'global' : 'project';
                const home = rootsHome();
                const project = String((scope === 'project' && payload.project) || defaultProjectDir(ctx));
                const result = await installer.installSkill({
                  source: skill.source,
                  slug: skill.slug,
                  scope,
                  projectDir: project,
                  home,
                  spawn: subprocessSpawn(ctx),
                  log: () => {},
                });
                if (result.ok) ctx.skills?.invalidateCache?.();
                return send(result.ok ? 200 : 502, {
                  ...result,
                  id: skill.id,
                  name: skill.slug,
                  installs_total: skill.installs,
                  scope,
                  project: scope === 'project' ? project : home,
                });
              }
              if (url.pathname === '/api/dsh-skills-center/uninstall') {
                if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                const installer = await loadInstaller();
                if (!installer) return send(501, { error: 'installer_unavailable' });
                const payload = await readJsonBody(req);
                if (!payload) return send(400, { error: 'bad_json' });
                const name = String(payload.name || '');
                const scope = payload.scope === 'global' ? 'global' : 'project';
                if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return send(400, { error: 'bad_name', name });
                const home = rootsHome();
                const project = String((scope === 'project' && payload.project) || defaultProjectDir(ctx));
                const result = await installer.uninstallSkill({
                  name,
                  scope,
                  projectDir: project,
                  home,
                  spawn: subprocessSpawn(ctx),
                  log: () => {},
                });
                if (result.ok) ctx.skills?.invalidateCache?.();
                return send(result.ok ? 200 : 502, { ...result, name, scope });
              }
              if (url.pathname === '/api/dsh-skills-center/sync') {
                // 会改盘上的目录，只允许 POST；GET 留给 status 读取现在的状态。
                if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                const result = await syncCatalog({ url: url.searchParams.get('url') || undefined });
                if (result.ok) {
                  remoteState = { checkedAt: new Date().toISOString(), updateAvailable: false, reason: 'synced' };
                }
                return send(result.ok ? 200 : 502, result);
              }
              return send(404, { error: 'not_found' });
            } catch (error) {
              return send(500, { error: String(error && error.message ? error.message : error) });
            }
          },
        }),
      'skills-center web api',
    );
  }
}
