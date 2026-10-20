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
    let match = 0;
    for (const w of words) {
      for (const [get, weight] of FIELDS) {
        const value = String(get(s) ?? '').toLowerCase();
        if (value && value.includes(w)) match += weight;
      }
    }
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
