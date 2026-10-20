// dsh-skills-center — 插件入口。
// 只做「目录 + 判断 + 激活」三件事；在线搜索与安装交给 skills-manager / npx skills。
import { createProvider, libraryPathFor } from './provider.js';
import { searchSkills, getSkill, renderCard, verdictOf, loadCatalog } from './catalog.js';
import { setActive, readActivation } from './activation.js';
import { syncCatalog, readSyncMeta, SYNC_URL_ENV } from './sync.js';
import { rankingPayload, renderRankingPage } from './page.js';
import { MAX_ACTIVE } from './paths.js';
import { access } from 'node:fs/promises';

const fileExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const name = 'dsh-skills-center';
export const inject = ['tools', 'skills', 'webServer'];

const asText = (text) => [{ type: 'text', text }];

// dsh-tools 会按 output.schema 校验 execute 的返回值，且要求 render 无损投影回原值
// (dsh-tools:3637-3648)。一个 undefined 属性就不是合法 JSON（JSON.stringify 会静默删掉它），
// 表现为 "tool returned invalid output: value is not lossless JSON"。
// 所以出口统一过一遍 JSON 往返，把 undefined / 不可序列化的东西提前清干净。
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function oneLine(skill) {
  const trend = skill.trend_pct == null ? '' : ` ${skill.trend_pct > 0 ? '+' : ''}${skill.trend_pct}%`;
  return `${skill.slug}${skill.name_zh ? `（${skill.name_zh}）` : ''} — ${verdictOf(skill)} · 装 ${skill.installs ?? '—'}${trend} · S ${(skill.score?.S ?? 0).toFixed(3)}`;
}

export function apply(ctx, config = {}) {
  let invalidateProvider = () => {};

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

  // 2) 四个工具，刻意保持最少
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
                  synced: await readSyncMeta(),
                  syncUrl: process.env[SYNC_URL_ENV] ?? null,
                });
              }
              if (url.pathname === '/api/dsh-skills-center/search') {
                const q = url.searchParams.get('q') || '';
                const limit = Number(url.searchParams.get('limit')) || 10;
                const results = await searchSkills(q, limit);
                return send(200, { results });
              }
              if (url.pathname === '/api/dsh-skills-center/card') {
                const skill = await getSkill(url.searchParams.get('id') || '');
                return skill ? send(200, skill) : send(404, { error: 'not_found' });
              }
              if (url.pathname === '/api/dsh-skills-center/sync') {
                // 会改盘上的目录，只允许 POST；GET 留给 status 读取现在的状态。
                if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                const result = await syncCatalog({ url: url.searchParams.get('url') || undefined });
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
