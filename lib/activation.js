// 激活集合的读写。激活态不落文件系统里的 skills 根，只落本插件自己的 JSON。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ACTIVATION_FILE, MAX_ACTIVE } from './paths.js';

const EMPTY = { version: 1, active: [] };

export async function readActivation() {
  try {
    const raw = JSON.parse(await readFile(ACTIVATION_FILE, 'utf8'));
    const active = Array.isArray(raw?.active) ? raw.active.filter((x) => typeof x === 'string') : [];
    return { version: 1, active };
  } catch {
    return { ...EMPTY, active: [] };
  }
}

async function writeActivation(state) {
  await mkdir(dirname(ACTIVATION_FILE), { recursive: true });
  const tmp = `${ACTIVATION_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, ACTIVATION_FILE); // 原子替换，读者只会看到旧或新
}

/**
 * 打开/关闭一个技能的激活。
 * @returns {{ok:boolean, active:string[], reason?:string}}
 */
export async function setActive(id, on = true) {
  const state = await readActivation();
  const has = state.active.includes(id);
  if (on && !has) {
    if (state.active.length >= MAX_ACTIVE) {
      return { ok: false, active: state.active, reason: `激活上限 ${MAX_ACTIVE} 已满，先关掉一个再开` };
    }
    state.active.push(id);
  } else if (!on && has) {
    state.active = state.active.filter((x) => x !== id);
  } else {
    return { ok: true, active: state.active };
  }
  await writeActivation(state);
  return { ok: true, active: state.active };
}
