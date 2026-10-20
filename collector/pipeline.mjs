// 采集流水线的纯逻辑：没有任何网络、没有文件系统副作用，全部可单测。
// 输入是 /api/v1 的原始记录，输出是 data/catalog.json 的形状（插件只认这一份）。

export const SCORE_WEIGHTS = { H: 0.45, T: 0.2, C: 0.2, A: 0.15 };
export const ENRICH_VERSION = 2; // 2 = 描述来自 SKILL.md frontmatter + 趋势来自页面 HTML
export const TREND_CLIP = [-50, 200]; // 8 周增长率裁剪区间（%）
export const NO_AUDIT_SCORE = 0.5; // 无审计数据给中位，不给 0：否则系统性歧视非 GitHub 来源

// 富集结果带上「是哪一版抓的」。为什么需要：上一版目录里的 hash 不能当作「已经抓全」的证据——
// 抓取逻辑升级后（比如开始解析 SKILL.md frontmatter），旧记录有 hash 却没有 description，
// 如果只按 hash 跳过，这些头部技能会永远缺描述。升这个号 = 下一轮全部重抓一遍。

/**
 * SKILL.md 的 YAML frontmatter → {name, description}。
 * 为什么必须自己解析：/api/v1 的 detail 只返回 id/source/slug/installs/hash/files，
 * 全链路唯一的「这个技能到底干什么」的证据就是 SKILL.md 的 frontmatter description。
 * 只支持常见子集（key: value / 折叠块 > 与 |），解析不了就返回 null，绝不猜。
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].trim());
      }
      value = block.join(' ');
    } else if (/^['"].*['"]$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** 8 周安装量序列 → 前后半段增长率（%）。数据不足返回 null，别硬算。 */
export function trendPct(weekly) {
  if (!Array.isArray(weekly) || weekly.length < 4) return null;
  const nums = weekly.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 4) return null;
  const cut = Math.floor(nums.length / 2);
  const first = nums.slice(0, cut).reduce((a, b) => a + b, 0);
  const second = nums.slice(cut).reduce((a, b) => a + b, 0);
  if (first <= 0) return null;
  return Math.round(((second - first) / first) * 1000) / 10;
}

/** 把 /api/v1 记录归一成内部形状。字段名以实测为准，缺什么就给 null，不编。 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.includes('/')) return null;
  const parts = raw.id.split('/');
  const slug = raw.slug || parts[parts.length - 1];
  if (!slug) return null;
  // source 是「id 去掉最后一段」= owner/repo（`vercel-labs/skills`），不是 owner。
  // 早先只取第一段，导致卡片上的「来源」只剩 `vercel-labs`、安装命令变成
  // `npx skills add vercel-labs --skill find-skills`（跑不通）。上游 `source` 字段本身就是这个形状。
  const source = parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0];
  return {
    id: raw.id,
    source,
    slug,
    name: raw.name || slug,
    source_kind: raw.sourceKind || raw.sourceType || raw.source_kind || raw.kind || null,
    installs: Number.isFinite(raw.installs) ? raw.installs : 0,
    installs_text: raw.installsText || null,
    // normalizeRecord 会被跑两遍（collect.mjs 抓完一次，buildCatalog 再一次），
    // 所以每个字段都要能从「已归一化」的形状再读一次，否则第二遍会静默清空。
    trend_pct: trendPct(raw.weeklyInstalls || raw.weekly_series) ?? raw.trend_pct ?? null,
    weekly_series: raw.weeklyInstalls || raw.weekly_series || null,
    hash: raw.hash || null,
    enrich_v: Number.isFinite(raw.enrich_v) ? raw.enrich_v : null,
    description_en: raw.description || raw.description_en || null,
    curated: Boolean(raw.curated),
    official: Boolean(raw.official),
    audit: raw.audit || null,
    body_length: raw.bodyLength ?? null,
    // 只用于算 flags，不进最终目录（正文摘要可能几十字，没必要发给插件）
    body_excerpt: raw.body_excerpt || null,
    file_count: raw.file_count ?? null,
    first_seen: raw.firstSeen || raw.first_seen || null,
    // 星标数：仓库级指标，来自技能页；非数字一律当没有（不编）
    stars: Number.isFinite(raw.stars) ? raw.stars : null,
  };
}

/** fork/复制去重的聚类键：有内容 hash 用 hash，否则退化成「slug + 英文描述」。 */
export function clusterKey(rec) {
  if (rec.hash) return `h:${rec.hash}`;
  const desc = (rec.description_en || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `d:${rec.slug}|${desc.slice(0, 160)}`;
}

/**
 * 跨 owner 去重：同一技能被多个 owner 各发一份时，installs 会分散在几个 id 上。
 * canonical 取组内 installs 最大者，其余进 aliases；榜单只收 canonical。
 * installs_merged 只用于展示「这个技能全站一共被装了多少」，不参与 H 分。
 */
export function dedupe(records) {
  const groups = new Map();
  for (const rec of records) {
    const key = clusterKey(rec);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const out = [];
  for (const members of groups.values()) {
    members.sort((a, b) => b.installs - a.installs || a.id.localeCompare(b.id));
    const [canonical, ...aliases] = members;
    out.push({
      ...canonical,
      installs_merged: members.reduce((sum, m) => sum + m.installs, 0),
      aliases: aliases.map((m) => ({ id: m.id, installs: m.installs })),
    });
  }
  return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * 审计 pass 占比：无审计数据记 NO_AUDIT_SCORE，别让「没人审」看起来像「审不过」。
 * 上游形状是 { audits: [{provider, status: pass|warn|fail, riskLevel}] }（实测字段名），
 * fail 必须计入分母——把 fail 从分母里剔掉等于给差技能刷分。
 */
export function auditScore(audit) {
  const partners = audit?.audits || audit?.partners || audit?.results || [];
  const judged = partners.filter((p) => p && ['pass', 'warn', 'fail'].includes(p.status));
  if (!judged.length) return NO_AUDIT_SCORE;
  return judged.filter((p) => p.status === 'pass').length / judged.length;
}

/**
 * S = 0.45·H + 0.20·T + 0.20·C + 0.15·A
 * H 必须走对数：头部 139 万 vs 腰部 3 万是 46 倍，线性归一后所有腰部技能会被压成 0.02 的噪声。
 */
export function scoreRecord(rec, { maxInstalls }) {
  const h = maxInstalls > 0 ? Math.log10(1 + rec.installs) / Math.log10(1 + maxInstalls) : 0;
  const trend = rec.trend_pct == null ? 0 : rec.trend_pct;
  const t = (clamp(trend, TREND_CLIP[0], TREND_CLIP[1]) - TREND_CLIP[0]) / (TREND_CLIP[1] - TREND_CLIP[0]);
  const c = rec.curated || rec.official ? 1 : 0;
  const a = auditScore(rec.audit);
  const S =
    SCORE_WEIGHTS.H * h + SCORE_WEIGHTS.T * t + SCORE_WEIGHTS.C * c + SCORE_WEIGHTS.A * a;
  const round = (n) => Math.round(n * 10000) / 10000;
  return { S: round(S), H: round(h), T: round(t), C: round(c), A: round(a) };
}

/** 内容层红旗：这些是「安装量高但装了就后悔」的形状，卡片里必须直说。 */
export function flagsOf(rec) {
  const flags = [];
  const text = `${rec.description_en || ''} ${rec.body_excerpt || ''}`.toLowerCase();
  if (/deprecat|compatibility entry|no longer maintained/.test(text)) flags.push('deprecated');
  if (/call the skill tool|discovery stub|not the usage guide/.test(text)) flags.push('pointer');
  if (/\$[a-z][a-z0-9_]*_api_key|bearer \$[a-z_]+/.test(text)) flags.push('needs_api_key');
  if (/\b(az|gcloud|aws|gh|belt|lark-cli|stripe)\s+login\b/.test(text)) flags.push('needs_external_cli');
  if (typeof rec.body_length === 'number' && rec.body_length > 0 && rec.body_length < 500) flags.push('thin_body');
  if (typeof rec.file_count === 'number' && rec.file_count > 10) flags.push('has_references');
  return flags;
}

/** 组装最终目录：去重 → 打分 → 按 S 降序。纯函数，给定输入必得同一输出（便于对拍）。 */
export function buildCatalog(records, { version, generatedAt = null, zh = {} } = {}) {
  const clean = records.map(normalizeRecord).filter(Boolean);
  const merged = dedupe(clean);
  const maxInstalls = merged.reduce((m, r) => Math.max(m, r.installs), 0);
  const scored = merged.map((rec) => {
    const score = scoreRecord(rec, { maxInstalls });
    const aliases = rec.aliases.length ? rec.aliases : undefined;
    return {
      id: rec.id,
      slug: rec.slug,
      name: rec.name,
      source: rec.source,
      source_kind: rec.source_kind,
      // DESIGN §3 的产物 schema 用 `kind`（"github"）；两个名字都发，省得消费方猜
      kind: rec.source_kind || undefined,
      installs: rec.installs,
      installs_merged: rec.installs_merged > rec.installs ? rec.installs_merged : undefined,
      trend_pct: rec.trend_pct,
      weekly_series: rec.weekly_series || undefined,
      hash: rec.hash || undefined,
      enrich_v: rec.enrich_v || undefined,
      description_en: rec.description_en || undefined,
      // 中文层按 id 索引（fork 合并后 hash 会随正文变化，id 才是稳定身份）；
      // 老数据里按 hash 写的也认，两条路都查一遍。
      name_zh: zh[rec.id]?.name_zh || zh[rec.hash]?.name_zh || undefined,
      zh: zh[rec.id] || zh[rec.hash] || undefined,
      official: rec.official || undefined,
      curated: rec.curated || undefined,
      first_seen: rec.first_seen || undefined,
      // 星标数是仓库级指标（技能页的 GitHub Stars），没抓过页面的条目没有 → 缺省不写
      stars: Number.isFinite(rec.stars) ? rec.stars : undefined,
      audit: rec.audit || undefined,
      score,
      flags: flagsOf(rec),
      aliases,
    };
  });
  scored.sort((a, b) => b.score.S - a.score.S || b.installs - a.installs || a.id.localeCompare(b.id));
  return {
    version,
    generated_at: generatedAt,
    count: scored.length,
    raw_count: clean.length,
    deduped: clean.length - merged.length,
    max_installs: maxInstalls,
    skills: scored,
  };
}
