#!/usr/bin/env node
// 给中文层准备素材：按安装量取第 offset..offset+limit 条，把「这个技能到底做什么」的原料抓齐。
//
// 原料只用真实数据，不做任何重写：
//   - description：SKILL.md 的 frontmatter description（/api/v1 detail 里的 files）
//   - body_excerpt：SKILL.md 正文前 3000 字（写中文介绍时要看它，否则只能照着标题编）
//   - installs / trend_pct / audit / flags：来自目录（趋势只在页面 HTML 里有）
//
// 用法：
//   node tools/zh_source.mjs [--top 300] [--limit <n>] [--offset <n>] [--out data/zh-source.json] [--catalog <path>]
//
// --limit 是 --top 的别名，两个都给时 --limit 优先；两个都不给就是原来的 --top 300。
// --offset 从 0 开始，配合机器生成层分页取原料。输出的 offset/limit/total 说明这一页是全集里的哪一段。
//
// 默认读插件已经同步下来的目录（~/.dsh/skills-center/catalog/catalog.json），
// 这样本地不用拿 OIDC token 也能知道要抓哪些；抓 detail 那一步才需要 token。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, parseWeeklyInstalls } from '../collector/fetch.mjs';
import { parseFrontmatter, trendPct } from '../collector/pipeline.mjs';

export const DEFAULT_TOP = 300;
export const DEFAULT_OUT = 'data/zh-source.json';
export const totalInstalls = (skill) => Number(skill?.installs_merged ?? skill?.installs ?? 0) || 0;

export function parseArgs(argv) {
  const args = { top: DEFAULT_TOP, limit: null, offset: 0, out: DEFAULT_OUT, catalog: null, concurrency: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--top') args.top = Number(argv[++i]);
    else if (key === '--limit') args.limit = Number(argv[++i]);
    else if (key === '--offset') args.offset = Number(argv[++i]);
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--catalog') args.catalog = argv[++i];
    else if (key === '--concurrency') args.concurrency = Number(argv[++i]);
    else throw new Error(`unknown arg: ${key}`);
  }
  const limit = args.limit == null ? args.top : args.limit;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit/--top 必须是不小于 0 的整数');
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('--offset 必须是不小于 0 的整数');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency 必须是正整数');
  return { ...args, limit };
}

// 总安装量降序，取 [offset, offset+limit)；total 是全集条数，跟这一页取多少无关
export function pickSkills(skills, { offset = 0, limit = DEFAULT_TOP } = {}) {
  const sorted = [...skills].sort((a, b) => totalInstalls(b) - totalInstalls(a));
  const total = sorted.length;
  const start = Math.min(Math.max(0, offset), total);
  const picked = sorted.slice(start, start + limit);
  return { picked, total, offset, limit };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const catalogPath = args.catalog || resolve(homedir(), '.dsh', 'skills-center', 'catalog', 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  if (!skills.length) throw new Error(`no skills in ${catalogPath}`);

  // 按安装量降序取这一页：用户要的是「大家真的在装的那些」的中文介绍
  const { picked, total, offset, limit } = pickSkills(skills, args);

  const token = process.env.SKILLS_API_TOKEN || (await import('@vercel/oidc')).getVercelOidcToken();
  const client = createClient({ token });

  const out = [];

  async function one(skill, index) {
    const row = {
      rank: offset + index + 1,
      id: skill.id,
      slug: skill.slug,
      name: skill.name || skill.slug,
      source: skill.source,
      installs: skill.installs_merged ?? skill.installs ?? null,
      installs_own: skill.installs ?? null,
      trend_pct: skill.trend_pct ?? null,
      curated: Boolean(skill.curated || skill.official),
      official: Boolean(skill.official || skill.curated),
      flags: skill.flags || [],
      audit: skill.audit
        ? {
            verdicts: (skill.audit.audits || []).map((a) => ({ provider: a.provider, status: a.status, riskLevel: a.riskLevel ?? null })),
          }
        : null,
      description: skill.description_en || null,
      body_excerpt: null,
      detail_error: null,
    };

    // 目录里已经有描述的就不重复抓；缺的才去 /api/v1 detail（每条约 0.3–0.7s）
    if (!row.description || !row.trend_pct) {
      try {
        const detail = await client.detail(skill.id);
        const files = Array.isArray(detail?.files) ? detail.files : [];
        const md = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path || '')) || files[0];
        const body = typeof md?.contents === 'string' ? md.contents : null;
        const meta = parseFrontmatter(body);
        row.description = row.description || meta?.description || null;
        row.body_excerpt = body ? body.slice(0, 3000) : null;
        row.file_count = files.length || null;
      } catch (error) {
        row.detail_error = String(error?.message || error).slice(0, 200);
      }
    }

    // 趋势：目录里没有就抓一次页面（一次约 0.2–0.5s）
    if (row.trend_pct == null) {
      try {
        const page = await client.page(skill.id);
        const series = page.weekly_series || parseWeeklyInstalls('');
        if (series) row.trend_pct = trendPct(series);
      } catch {
        /* 拿不到就是没有，不编 */
      }
    }

    process.stderr.write(`  ${String(index + 1).padStart(3)} ${skill.id} ${row.description ? '' : '(无描述)'}\n`);
    return row;
  }

  // 并发跑：单条失败不能拖垮整批（失败信息留在 detail_error 里）
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, picked.length) }, async () => {
      while (cursor < picked.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await one(picked[index], index);
      }
    }),
  );

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    catalog_version: catalog.version ?? null,
    catalog_path: catalogPath,
    offset,
    limit,
    total,
    count: out.length,
    from_cache_catalog: !args.catalog,
    skills: out,
  };
  await writeFile(outPath, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  const missing = out.filter((r) => !r.description).length;
  process.stderr.write(
    `wrote ${outPath}: ${out.length}/${total} rows (offset ${offset}, limit ${limit}), ${missing} without description, ${out.filter((r) => r.trend_pct != null).length} with trend\n`,
  );
  return payload;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await run();
