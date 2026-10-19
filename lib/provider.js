// skills 服务 provider：只把「已激活且正文在库存里」的技能暴露给 DSH。
// 契约（从已安装的 @michengai/dsh-skills-manager 消费用法实证）：
//   registerProvider((control) => ({ name, list(options), get(candidate, options) }))
//   control = { invalidate(), signal }；registerProvider 返回 dispose 函数。
// 注意：工厂必须是同步的，异步读取放在 list/get 里做。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSkill } from './catalog.js';
import { readActivation } from './activation.js';
import { LIBRARY_DIR } from './paths.js';

export const PROVIDER_NAME = 'dsh-skills-center';

/**
 * 候选优先级。host 的 `rank` 越小越优先，且只在同一层内比较
 * （`dsh-skill/lib/index.js:519-521`：`left.candidate.rank - right.candidate.rank`）。
 * 现有梯子（`dsh-skill-filesystem/lib/index.js:20-24` + `dsh-skill:21-23`）：
 *   project .dsh 100 / project .agents 200 / runtime 250 / custom dirs 300 /
 *   user .dsh 400 / user .agents 500 / bundled 600
 * 我们给 700：默认永远不盖住用户自己手写或已装的同名技能；想让它优先就 config.rank 调低。
 */
export const DEFAULT_RANK = 700;

/** host 的合法技能名：`dsh-skill/lib/index.js:17` `SKILL_NAME`。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 把目录里的 slug 收敛成 host 认的 kebab 名；收敛不出来返回 undefined。 */
export function toSkillName(slug) {
  const raw = String(slug ?? '').trim();
  if (!raw) return undefined;
  if (SKILL_NAME.test(raw)) return raw;
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return SKILL_NAME.test(folded) ? folded : undefined;
}

/** 库存里该技能 SKILL.md 的落点：library/<source>/<slug>/SKILL.md */
export function libraryPathFor(skill) {
  return join(LIBRARY_DIR, skill.source, skill.slug, 'SKILL.md');
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(text.indexOf('\n', end + 1) + 1).replace(/^(?:[ \t]*\r?\n)+/, '');
}

/** 读出「已激活 且 库存里有正文」的那批，附上正文。 */
export async function loadReady() {
  const { active } = await readActivation();
  const ready = [];
  for (const id of active) {
    const skill = await getSkill(id);
    if (!skill) continue;
    let raw;
    try {
      raw = await readFile(libraryPathFor(skill), 'utf8');
    } catch {
      continue; // 库存里没正文 → 不对外声称可用
    }
    ready.push({ skill, content: stripFrontmatter(raw) });
  }
  return ready;
}

/** 返回 provider 工厂，可直接交给 ctx.skills.registerProvider。 */
export function createProvider(options = {}) {
  const rank = Number.isFinite(options.rank) ? options.rank : DEFAULT_RANK;
  return (control) => ({
    name: PROVIDER_NAME,
    async list() {
      // host 的 validateCandidate 会 **throw**，而且它在包 list() 的 try 之外调用
      // （dsh-skill/lib/index.js:360 vs :349-355）——一个畸形候选会让所有 provider 的目录当场消失。
      // 所以这里自己先把不合规的丢掉，且保证本函数绝不抛。
      const candidates = [];
      const seen = new Set();
      let ready = [];
      try {
        ready = await loadReady();
      } catch {
        return candidates;
      }
      for (const { skill } of ready) {
        try {
          const name = toSkillName(skill.slug);
          if (!name || seen.has(name)) continue; // 非 kebab / 重名（归一后撞车）都跳过
          const description = String(skill.zh?.intro || skill.description_en || '').trim();
          if (!description) continue; // host 拒绝空 description
          seen.add(name);
          candidates.push({
            name,
            description,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: PROVIDER_NAME,
            source: 'skills-center',
            rank,
            locator: { id: skill.id },
            resourceBase: { kind: 'directory', path: join(LIBRARY_DIR, skill.source, skill.slug) },
            path: libraryPathFor(skill),
            metadata: {
              skillsCenter: { id: skill.id, installs: skill.installs, score: skill.score?.S ?? null },
            },
          });
        } catch {
          continue; // 单条坏数据不拖垮整个目录
        }
      }
      return candidates;
    },
    async get(candidate) {
      const ready = await loadReady();
      const hit = ready.find(
        ({ skill }) => skill.id === candidate?.locator?.id || toSkillName(skill.slug) === candidate?.name,
      );
      if (!hit) return undefined;
      // name 必须与候选名逐字一致：host 在 dsh-skill/lib/index.js:259-262 会比对，
      // 不一致就当作"技能不存在"并清缓存，表现为工具静默失效。
      const name = candidate.name ?? toSkillName(hit.skill.slug);
      const description = String(candidate.description ?? '').trim();
      if (!name || !description) return undefined;
      return {
        name,
        description,
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: candidate.source ?? 'skills-center',
        rank: Number.isFinite(candidate.rank) ? candidate.rank : rank,
        // resourceBase 决定技能里相对路径怎么解析（dsh-skill/lib/index.js:71-80 的
        // renderResourceHint），丢了就会被当成"资源由 provider 托管"。
        resourceBase: candidate.resourceBase,
        path: candidate.path,
        metadata: candidate.metadata,
        content: hit.content,
      };
    },
  });
}
