// 目录的加载、检索与打分。纯函数 + 一个按 mtime 失效的缓存，便于单独测试。
import { readFile, stat } from 'node:fs/promises';
import { CATALOG_CANDIDATES } from './paths.js';

let cache = { key: '', data: null };

/** 读取 catalog.json；文件不存在时返回空目录而不是抛错。 */
export async function loadCatalog() {
  for (const file of CATALOG_CANDIDATES) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    const key = `${file}:${info.mtimeMs}:${info.size}`;
    if (cache.key === key && cache.data) return cache.data;
    const data = JSON.parse(await readFile(file, 'utf8'));
    // 以数组长度为准：同步下来的目录可能没写 count，写错了也不该信它。
    const skills = Array.isArray(data.skills) ? data.skills : [];
    const normalized = {
      ...data,
      version: typeof data.version === 'string' ? data.version : null,
      count: skills.length,
      skills,
    };
    cache = { key, data: { ...normalized, __file: file } };
    return cache.data;
  }
  return { version: null, count: 0, skills: [], __file: null };
}

/** 按 id 或 slug 精确取一条。 */
export async function getSkill(idOrSlug) {
  const cat = await loadCatalog();
  const key = String(idOrSlug || '').trim();
  if (!key) return undefined;
  return cat.skills.find((s) => s.id === key || s.slug === key);
}

/** 截断到 limit 个字符，末尾加省略号；空白压成单空格，免得卡片里断行难看。 */
function excerpt(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join('')}…`;
}

function tokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 用于匹配的字段权重：名称 > 中文名 > 中文正文 > 来源。 */
const FIELDS = [
  [(s) => s.name, 6],
  [(s) => s.slug, 5],
  [(s) => s.name_zh, 5],
  [(s) => s.zh?.intro, 3],
  [(s) => s.zh?.usage, 3],
  [(s) => s.zh?.notes, 2],
  [(s) => s.source, 2],
  [(s) => (s.flags || []).join(' '), 1],
];

/** 一条记录命中的权重之和；检索与浏览共用同一套字段，避免两处判据漂移。 */
function matchScore(skill, words) {
  let match = 0;
  for (const w of words) {
    for (const [get, weight] of FIELDS) {
      const value = String(get(skill) ?? '').toLowerCase();
      if (value && value.includes(w)) match += weight;
    }
  }
  return match;
}

/** 浏览排序：名字靠 S 分，其余直接按数值；缺值排最后而不是当成 0。 */
const SORTS = {
  S: (a, b) => (b.score?.S ?? -1) - (a.score?.S ?? -1),
  installs: (a, b) => (b.installs ?? -1) - (a.installs ?? -1),
  trend: (a, b) => (b.trend_pct ?? -1e9) - (a.trend_pct ?? -1e9),
  name: (a, b) =>
    String(a.name_zh || a.slug || '').localeCompare(String(b.name_zh || b.slug || ''), 'zh'),
};

export const SORT_KEYS = Object.keys(SORTS);

/** 审计结论计数：卡片上要写「审计 4/5 pass」，而不是把五家 provider 全铺出来。 */
export function auditCounts(audit) {
  const list = audit?.audits || audit?.partners || audit?.results || [];
  const judged = list.filter((p) => p && ['pass', 'warn', 'fail'].includes(p.status));
  if (!judged.length) return null;
  return {
    judged: judged.length,
    pass: judged.filter((p) => p.status === 'pass').length,
    warn: judged.filter((p) => p.status === 'warn').length,
    fail: judged.filter((p) => p.status === 'fail').length,
  };
}

/** 面板一张卡片需要的全部字段。别把整条记录发过去：全量七千多条的完整 JSON 有几 MB。 */
export function rowOf(skill) {
  const zh = skill.zh || {};
  const audit = auditCounts(skill.audit);
  const nameZh = skill.name_zh ?? zh.name_zh ?? null;
  const sourceKind = skill.kind ?? skill.source_kind ?? null;
  return {
    id: skill.id ?? null,
    slug: skill.slug ?? null,
    name: skill.name ?? skill.slug ?? null,
    name_zh: nameZh,
    source: skill.source ?? null,
    source_kind: sourceKind,
    installs: skill.installs ?? null,
    installs_merged: skill.installs_merged ?? null,
    trend_pct: skill.trend_pct ?? null,
    S: skill.score?.S ?? null,
    score: skill.score ?? null,
    verdict: verdictOf(skill),
    flags: Array.isArray(skill.flags) ? skill.flags : [],
    has_zh: Boolean(zh.intro || skill.intro_zh),
    description: zh.intro || skill.intro_zh || skill.description_en || '',
    official: Boolean(skill.official),
    curated: Boolean(skill.curated),
    enriched: Boolean(skill.hash),
    first_seen: skill.first_seen ?? null,
    audit,
    // 只在 GitHub 来源上给安装命令：域名来源（如 open.feishu.cn）用 npx skills add 装不了，
    // 宁可什么都不显示，也不要给一条跑不通的命令。
    install_hint: sourceKind === 'github' && skill.source && skill.slug
      ? `npx skills add ${skill.source} --skill ${skill.slug}`
      : null,
  };
}

/** 面板上的筛选：中文卡 / 官方精选 / 有风险信号。 */
const FILTERS = {
  official: (s) => Boolean(s.official || s.curated),
  risky: (s) => {
    const flags = s.flags || [];
    if (flags.length) return true;
    const audit = auditCounts(s.audit);
    return Boolean(audit && (audit.warn > 0 || audit.fail > 0));
  },
  zh: (s) => Boolean(s.zh?.intro || s.intro_zh),
  enriched: (s) => Boolean(s.hash),
};

/**
 * 浏览式分页检索：给 GUI 面板用，沿用检索的权重与排序，但允许 offset/limit 与空查询。
 * 有关键词时按命中权重排（相关度优先，此时 dir 不参与）；无关键词时按 sort + dir 排。
 */
export async function browseSkills({
  q = '',
  limit = 300,
  offset = 0,
  onlyZh = false,
  sort = 'S',
  dir = 'desc',
  filter = '',
} = {}) {
  const cat = await loadCatalog();
  const words = tokens(q);
  let pool = cat.skills;
  if (onlyZh || filter === 'zh') pool = pool.filter(FILTERS.zh);
  else if (FILTERS[filter]) pool = pool.filter(FILTERS[filter]);

  if (words.length) {
    const scored = [];
    for (const s of pool) {
      const match = matchScore(s, words);
      if (match > 0) scored.push({ skill: s, match });
    }
    scored.sort((a, b) => b.match - a.match || (b.skill.score?.S ?? 0) - (a.skill.score?.S ?? 0));
    pool = scored.map((x) => x.skill);
  } else {
    const compare = SORTS[sort] || SORTS.S;
    const sign = String(dir).toLowerCase() === 'asc' ? -1 : 1;
    pool = pool.slice().sort((a, b) => sign * compare(a, b));
  }

  const size = Math.max(1, Math.min(500, Number(limit) || 300));
  const start = Math.max(0, Number(offset) || 0);
  return {
    version: cat.version,
    total: cat.count,
    matched: pool.length,
    offset: start,
    limit: size,
    sort,
    dir,
    filter: filter || (onlyZh ? 'zh' : ''),
    rows: pool.slice(start, start + size).map(rowOf),
  };
}

/** 全字段子串检索，按命中权重之和排序，再以 S 分微调。 */
export async function searchSkills(query, limit = 10) {
  const cat = await loadCatalog();
  const words = tokens(query);
  if (!words.length) {
    return cat.skills
      .slice()
      .sort((a, b) => (b.score?.S ?? 0) - (a.score?.S ?? 0))
      .slice(0, limit)
      .map((s) => ({ ...s, match: 0 }));
  }
  const scored = [];
  for (const s of cat.skills) {
    const match = matchScore(s, words);
    if (match > 0) scored.push({ ...s, match });
  }
  scored.sort((a, b) => b.match - a.match || (b.score?.S ?? 0) - (a.score?.S ?? 0));
  return scored.slice(0, Math.max(1, Math.min(50, limit)));
}

const has = (skill, flag) => (skill.flags || []).includes(flag);

const VERDICT_BY_FLAGS = [
  [(s) => has(s, 'deprecated'), '别装（废弃占位）'],
  [(s) => has(s, 'thin_body') && has(s, 'pointer'), '装之前先看注意事项（转发壳）'],
  [(s) => has(s, 'needs_api_key'), '看情况（需要付费 key）'],
  [(s) => Boolean(s.official), '官方维护'],
  [() => true, '可用'],
];

/** 一句话结论：把 flags 折成一句能直接读的判断。 */
export function verdictOf(skill) {
  const hit = VERDICT_BY_FLAGS.find(([test]) => test(skill));
  if (!hit) return '可用';
  const suffix = (skill.trend_pct ?? 0) >= 100 ? '，八周翻倍' : '';
  return hit[1] + suffix;
}

/** 卡片文本：字段顺序与 samples/cards.v3.md 一致。 */export function renderCard(skill) {
  const s = skill.score || {};
  const zh = skill.zh || {};
  const head = `${skill.name}${zh.name_zh ? `（${zh.name_zh}）` : ''} — ${verdictOf(skill)}`;
  const lines = [
    head,
    // 中文卡只做了安装量前 300 条；覆盖不到的条目不许拿占位符糊过去，也不许编，
    // 有上游英文描述就照抄（截断），没有就直说没有。
    zh.intro
      ? `介绍 — ${zh.intro}`
      : skill.description_en
        ? `介绍（上游英文原文）— ${excerpt(skill.description_en, 240)}`
        : '介绍 — 上游没给描述，这条目前只有名称、装量、审计结论',
    `用途 — ${zh.usage || '—'}`,
    `使用注意事项 — ${zh.notes || '—'}`,
    `安装数 — ${skill.installs ?? '—'}`,
    `8 周趋势 — ${skill.trend_pct == null ? '—' : `${skill.trend_pct > 0 ? '+' : ''}${skill.trend_pct}%`}`,
    `来源 — ${skill.source}`,
  ];
  if (!zh.intro) lines.push('中文卡 — 未覆盖（只做安装量前 300 条）');
  const extras = [];
  if (skill.flags?.length) extras.push(`标记 — ${skill.flags.join(', ')}`);
  if (s.S != null) extras.push(`S 分 — ${s.S.toFixed(3)}（H ${s.H} / T ${s.T} / C ${s.C} / A ${s.A}）`);
  if (skill.id) extras.push(`id — ${skill.id}`);
  return [...lines, ...extras].join('\n');
}
