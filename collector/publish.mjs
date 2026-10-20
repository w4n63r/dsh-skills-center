// 上传层：先做 schema 自检，再用「版本化文件名 + latest 指针」写 Blob。
//
// 为什么要分两个文件：catalog-latest.json 是插件/下游读取的固定地址，如果用半成品覆盖它，
// 读到的是这个版本的内容、那个版本的缺失字段，排查起来毫无线索。所以顺序永远是：
//   1) validateCatalog() 不合格 → 一个字节都不写，直接返回 stage=validate
//   2) 写 catalog-<ISO>.json（不可变快照，重跑同名覆盖只为幂等重试）
//   3) 最后写 catalog-latest.json（指针；只有 2) 成功后才动它）

export const SCORE_KEYS = ['S', 'H', 'T', 'C', 'A'];
export const WEIGHTS = { H: 0.45, T: 0.2, C: 0.2, A: 0.15 };
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * catalog.json 的 schema 自检。宁可拒绝上传，也不要把「少了 score 的空目录」推到线上。
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
export function validateCatalog(catalog) {
  const errors = [];
  const warnings = [];

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { ok: false, errors: ['catalog is not a plain object'], warnings, stats: {} };
  }
  if (typeof catalog.version !== 'string' || !catalog.version.trim()) errors.push('version: missing');
  else if (!/^(full|dir)-/.test(catalog.version)) warnings.push(`version: "${catalog.version}" has no full-/dir- prefix`);
  if (typeof catalog.generated_at !== 'string' || Number.isNaN(Date.parse(catalog.generated_at))) {
    errors.push('generated_at: missing or not a date');
  }
  if (!Array.isArray(catalog.skills)) {
    errors.push('skills: missing array');
    return { ok: false, errors, warnings, stats: {} };
  }
  const skills = catalog.skills;
  if (!skills.length) errors.push('skills: empty array — refusing to publish an empty catalog');
  if (!Number.isInteger(catalog.count)) errors.push('count: missing integer');
  else if (catalog.count !== skills.length) errors.push(`count ${catalog.count} != skills.length ${skills.length}`);
  if (!Number.isInteger(catalog.raw_count) || catalog.raw_count < skills.length) {
    errors.push('raw_count: must be an integer >= count');
  }
  if (!isNum(catalog.max_installs) || catalog.max_installs <= 0) {
    errors.push('max_installs: missing/zero — H normalization would divide by zero');
  }

  const ids = new Set();
  const hashes = new Map();
  let prevS = Infinity;
  let sorted = true;
  skills.forEach((skill, i) => {
    const at = `skills[${i}]${skill?.id ? `(${skill.id})` : ''}`;
    if (typeof skill?.id !== 'string' || !skill.id.includes('/')) errors.push(`${at}: id must be "source/slug"`);
    else if (ids.has(skill.id)) errors.push(`${at}: duplicate id`);
    else ids.add(skill.id);
    if (typeof skill?.slug !== 'string' || !skill.slug) errors.push(`${at}: slug missing`);
    if (typeof skill?.name !== 'string' || !skill.name) errors.push(`${at}: name missing`);
    if (typeof skill?.source !== 'string' || !skill.source) errors.push(`${at}: source missing`);
    if (!isNum(skill?.installs) || skill.installs < 0) errors.push(`${at}: installs must be a finite number >= 0`);
    if (skill?.installs_merged != null && (!isNum(skill.installs_merged) || skill.installs_merged < skill.installs)) {
      errors.push(`${at}: installs_merged must be >= installs`);
    }
    if (skill?.aliases != null && !Array.isArray(skill.aliases)) errors.push(`${at}: aliases must be an array`);
    if (skill?.flags != null && !Array.isArray(skill.flags)) errors.push(`${at}: flags must be an array`);

    const score = skill?.score;
    if (!score || typeof score !== 'object') {
      errors.push(`${at}: score missing`);
    } else {
      for (const key of SCORE_KEYS) {
        if (!isNum(score[key])) errors.push(`${at}: score.${key} is not a number`);
        else if (score[key] < -1e-9 || score[key] > 1 + 1e-9) errors.push(`${at}: score.${key}=${score[key]} out of [0,1]`);
      }
      const expected =
        WEIGHTS.H * score.H + WEIGHTS.T * score.T + WEIGHTS.C * score.C + WEIGHTS.A * score.A;
      if (isNum(score.S) && Math.abs(score.S - expected) > 2e-3) {
        errors.push(`${at}: score.S=${score.S} does not recompose from H/T/C/A (${expected.toFixed(4)})`);
      }
      if (isNum(score.S)) {
        if (score.S > prevS + 1e-9) sorted = false;
        prevS = score.S;
      }
    }

    if (typeof skill?.hash === 'string' && skill.hash) {
      if (hashes.has(skill.hash)) errors.push(`${at}: same hash as ${hashes.get(skill.hash)} — dedupe was skipped`);
      else hashes.set(skill.hash, skill.id);
    }
  });
  // 排序不是正确性问题，但「目录按 S 降序」是插件 UI 的前提，坏了要在日志里看见
  if (!sorted) warnings.push('skills are not sorted by score.S descending');

  const payload = JSON.stringify(catalog);
  const stats = {
    version: catalog.version,
    count: skills.length,
    raw_count: catalog.raw_count,
    with_body: skills.filter((s) => s.hash).length,
    with_audit: skills.filter((s) => s.audit).length,
    curated: skills.filter((s) => s.curated).length,
    flagged: skills.filter((s) => s.flags?.length).length,
    payload_bytes: Buffer.byteLength(payload),
    max_installs: catalog.max_installs,
  };
  if (stats.payload_bytes > 4 * 1024 * 1024) {
    warnings.push(`payload ${stats.payload_bytes}B is close to the 4.5MB serverless limit`);
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

/** 版本化文件名：catalog-2026-10-19T17-30-00-000Z.json（ISO 里的冒号换成 - 以免 pathname 转义） */
export function versionedName(catalog, prefix = 'catalog') {
  const stamp = String(catalog?.version || '').replace(/^(full|dir)-/, '') || new Date().toISOString();
  return `${prefix}-${stamp}.json`;
}

/**
 * 写 Blob。
 * @param {(pathname:string, body:string, opts:object)=>Promise<{url?:string}>} put  @vercel/blob 的 put（可注入以便离线测试）
 */
export async function publishCatalog({
  catalog,
  put,
  prefix = 'catalog',
  access = 'public',
  log = () => {},
} = {}) {
  const check = validateCatalog(catalog);
  if (!check.ok) {
    log(`validate failed: ${check.errors.length} error(s)`);
    return { ok: false, stage: 'validate', errors: check.errors, warnings: check.warnings, stats: check.stats };
  }
  if (typeof put !== 'function') {
    return { ok: false, stage: 'upload', errors: ['no put() provided'], warnings: check.warnings, stats: check.stats };
  }
  if (!['public', 'private'].includes(access)) {
    // put() 的 access 必填；传错值 Blob 会直接 400，不如在这里拦住
    return { ok: false, stage: 'upload', errors: [`invalid access "${access}" (public|private)`], warnings: check.warnings, stats: check.stats };
  }

  const body = JSON.stringify(catalog);
  const versionedPath = versionedName(catalog, prefix);
  const latestPath = `${prefix}-latest.json`;

  const versioned = await put(versionedPath, body, {
    access,
    allowOverwrite: true, // 同名重跑=幂等重试；版本号带毫秒，正常不会撞
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  log(`wrote ${versionedPath} (${Buffer.byteLength(body)}B)`);

  // 指针最后写：只要这一行没执行，线上 latest 就还是上一个完整版本
  const latest = await put(latestPath, body, {
    access,
    allowOverwrite: true,
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  log(`wrote ${latestPath}`);

  return {
    ok: true,
    stage: 'upload',
    warnings: check.warnings,
    stats: check.stats,
    versioned: { pathname: versionedPath, url: versioned?.url ?? null },
    latest: { pathname: latestPath, url: latest?.url ?? null },
  };
}
