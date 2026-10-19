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
 * 候选优先级。DSH 的 rank 越小越优先（skills-manager 用 min(rank)-1 来"覆盖"别的来源），
 * 而它自己的技能根占 100~450。我们给 500：默认永远不盖住用户自己的同名技能，
 * 需要的用户可以 config.rank 调低。
 */
export const DEFAULT_RANK = 500;

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
      const ready = await loadReady();
      return ready.map(({ skill }) => ({
        name: skill.slug,
        description: skill.zh?.intro || skill.description_en || skill.slug,
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
      }));
    },
    async get(candidate) {
      const ready = await loadReady();
      const hit = ready.find(
        ({ skill }) => skill.id === candidate?.locator?.id || skill.slug === candidate?.name,
      );
      if (!hit) return undefined;
      return {
        name: hit.skill.slug,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: candidate.source,
        rank: candidate.rank ?? rank,
        locator: candidate.locator,
        resourceBase: candidate.resourceBase,
        path: candidate.path,
        metadata: candidate.metadata,
        content: hit.content,
      };
    },
  });
}
