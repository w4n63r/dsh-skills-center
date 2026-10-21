// installer 的单测：根枚举顺序、frontmatter 解析、argv 逐字、装/卸的结果验证。
// 全离线：spawn 是假的（自己写/删文件），home 一律显式指向临时目录，
// 所以这些用例碰不到真实 ~/.agents/skills，也不会真的跑 npx。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANAGED_SCOPE,
  findProjectRoot,
  installArgs,
  installSkill,
  listInstalled,
  parseFrontmatter,
  rootDescriptors,
  uninstallArgs,
  uninstallSkill,
} from '../lib/installer.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsc-installer-'));
const project = join(tmpRoot, 'proj');
const home = join(tmpRoot, 'home');
mkdirSync(project, { recursive: true });
mkdirSync(home, { recursive: true });

const projectAgents = join(project, '.agents', 'skills');
const userAgents = join(home, '.agents', 'skills');
const projectDsh = join(project, '.dsh', 'skills');
const userDsh = join(home, '.dsh', 'skills');

/** 造一个技能目录。body 为 null 时给一个只有围栏的空 frontmatter（等价于「没有 name」）。 */
function makeSkill(rootDir, name, body = null) {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body === null ? '---\n---\n' : body, 'utf8');
  return dir;
}

const checks = [];
const check = async (label, fn) => {
  try {
    await fn();
    checks.push({ label, ok: true });
  } catch (err) {
    checks.push({ label, ok: false, message: err && err.message ? err.message : String(err) });
  }
};

// ---- 布置：项目级 / 全局各 2 个技能（一个带 frontmatter、一个只靠目录名）------------
const alphaBody = ['---', 'name: alpha', 'description: "带引号的描述: 用于验证 unquote"', '---', '', '# alpha'].join(
  '\n',
);
const gammaBody = ['---', 'name: gamma', 'description: 无引号描述', '---'].join('\n');
makeSkill(projectAgents, 'alpha', alphaBody);
makeSkill(projectAgents, 'beta');
makeSkill(userAgents, 'gamma', gammaBody);
makeSkill(userAgents, 'delta');

// 反例：根下散放的 *.md 不是技能；目录里没有 SKILL.md 也不是技能。
writeFileSync(join(projectAgents, 'loose-note.md'), '# 只是一份资料\n', 'utf8');
mkdirSync(join(projectAgents, 'empty-dir'), { recursive: true });

// 项目级 .dsh/skills 与全局 .dsh/skills 故意不创建：验证 exists:false 且被跳过。
assert.equal(existsSync(projectDsh), false);
assert.equal(existsSync(userDsh), false);

// ---- 1. 四根的 id/rank/managed/dir 顺序 ---------------------------------------------
await check('rootDescriptors：按 rank 升序、managed 标记正确', () => {
  const roots = rootDescriptors({ projectDir: project, home });
  assert.deepEqual(
    roots.map((r) => r.id),
    ['project-dsh', 'project-agents', 'user-dsh', 'user-agents'],
  );
  assert.deepEqual(
    roots.map((r) => r.rank),
    [100, 200, 400, 500],
  );
  assert.deepEqual(
    roots.map((r) => r.managed),
    [false, true, false, true],
  );
  assert.deepEqual(
    roots.map((r) => r.scope),
    ['project', 'project', 'global', 'global'],
  );
  assert.deepEqual(
    roots.map((r) => r.dir),
    [join(project, '.dsh', 'skills'), projectAgents, join(home, '.dsh', 'skills'), userAgents],
  );
  assert.deepEqual(MANAGED_SCOPE, { project: 'project-agents', global: 'user-agents' });
  // 传入顺序不影响输出顺序（内部排序）
  assert.deepEqual(rootDescriptors({ home, projectDir: project }).map((r) => r.id), roots.map((r) => r.id));
});

// ---- 2. listInstalled：项目级 + 全局各 2 个，裸 md / 无 SKILL.md 目录都不算 ----------
await check('listInstalled：4 个技能、exists 标记、裸 .md 不计入、name 回退目录名', () => {
  const res = listInstalled({ projectDir: project, home });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.roots.map((r) => [r.id, r.exists]),
    [
      ['project-dsh', false],
      ['project-agents', true],
      ['user-dsh', false],
      ['user-agents', true],
    ],
  );
  assert.deepEqual(
    res.skills.map((s) => s.name).sort(),
    ['alpha', 'beta', 'delta', 'gamma'],
  );
  assert.equal(
    res.skills.some((s) => s.name.includes('loose-note')),
    false,
  );
  assert.equal(
    res.skills.some((s) => s.name === 'empty-dir'),
    false,
  );

  const alpha = res.skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.description, '带引号的描述: 用于验证 unquote');
  assert.equal(alpha.scope, 'project');
  assert.equal(alpha.rank, 200);
  assert.equal(alpha.rootId, 'project-agents');
  assert.equal(alpha.dir, join(projectAgents, 'alpha'));
  assert.equal(alpha.skillFile, join(projectAgents, 'alpha', 'SKILL.md'));

  const beta = res.skills.find((s) => s.name === 'beta');
  assert.equal(beta.name, 'beta'); // frontmatter 里没有 name → 用目录名
  assert.equal(beta.description, null);

  const gamma = res.skills.find((s) => s.name === 'gamma');
  assert.equal(gamma.description, '无引号描述');
  assert.equal(gamma.scope, 'global');
  assert.equal(gamma.rank, 500);
  assert.equal(gamma.rootId, 'user-agents');
  assert.equal(gamma.dir, join(userAgents, 'gamma'));

  const delta = res.skills.find((s) => s.name === 'delta');
  assert.equal(delta.description, null);
});

await check('listInstalled：项目级与全局同名各列一条，不去重', () => {
  makeSkill(projectAgents, 'same', '---\nname: same\n---\n');
  makeSkill(userAgents, 'same', '---\nname: same\n---\n');
  const dup = listInstalled({ projectDir: project, home }).skills.filter((s) => s.name === 'same');
  assert.equal(dup.length, 2);
  assert.deepEqual(dup.map((s) => s.rank).sort((a, b) => a - b), [200, 500]);
  rmSync(join(projectAgents, 'same'), { recursive: true, force: true });
  rmSync(join(userAgents, 'same'), { recursive: true, force: true });
});

await check('listInstalled：根全部不存在时 ok 且 skills 为空', () => {
  const bare = join(tmpRoot, 'bare');
  const bareHome = join(tmpRoot, 'bare-home');
  mkdirSync(bare, { recursive: true });
  mkdirSync(bareHome, { recursive: true });
  const res = listInstalled({ projectDir: bare, home: bareHome });
  assert.equal(res.ok, true);
  assert.deepEqual(res.skills, []);
  assert.deepEqual(
    res.roots.map((r) => r.exists),
    [false, false, false, false],
  );
});

// ---- 3. parseFrontmatter ------------------------------------------------------------
await check('parseFrontmatter：引号/无引号/缺失/坏输入都不抛', () => {
  assert.deepEqual(parseFrontmatter(alphaBody), {
    name: 'alpha',
    description: '带引号的描述: 用于验证 unquote',
  });
  assert.deepEqual(parseFrontmatter("---\nname: 'q'\ndescription: \"d\"\n---\n"), { name: 'q', description: 'd' });
  assert.deepEqual(parseFrontmatter('---\nname: only-name\n---\n'), { name: 'only-name', description: null });
  assert.deepEqual(parseFrontmatter('---\n---\n'), { name: null, description: null });
  assert.deepEqual(parseFrontmatter('没有 frontmatter 的正文\nname: 不该取到? \n\n'), {
    name: null,
    description: null,
  });
  assert.deepEqual(parseFrontmatter('name: 无围栏也能取\n'), { name: '无围栏也能取', description: null });
  assert.deepEqual(parseFrontmatter('\r\n---\r\nname: crlf\r\ndescription: 带CRLF\r\n---\r\n'), {
    name: 'crlf',
    description: '带CRLF',
  });
  assert.deepEqual(parseFrontmatter('name:'), { name: null, description: null });
  assert.deepEqual(parseFrontmatter('---\nname: bs\ndescription: |\n  第一行\n  第二行\n---\n'), {
    name: 'bs',
    description: '第一行 第二行',
  });
  assert.deepEqual(parseFrontmatter('  name: 缩进的键不算\n'), { name: null, description: null });
  assert.deepEqual(parseFrontmatter(null), { name: null, description: null });
  assert.deepEqual(parseFrontmatter(''), { name: null, description: null });
  assert.deepEqual(parseFrontmatter(undefined), { name: null, description: null });
});

// ---- 4. installArgs / uninstallArgs 逐字 -------------------------------------------
await check('installArgs/uninstallArgs：四种组合逐字相等', () => {
  assert.deepEqual(installArgs({ source: 'acme/skills', slug: 'do-thing', scope: 'project' }), [
    '-y',
    'skills@1.7.4',
    'add',
    'acme/skills',
    '--skill',
    'do-thing',
    '-a',
    'codex',
    '--copy',
    '-y',
  ]);
  assert.deepEqual(installArgs({ source: 'acme/skills', slug: 'do-thing', scope: 'global' }), [
    '-y',
    'skills@1.7.4',
    'add',
    'acme/skills',
    '--skill',
    'do-thing',
    '-a',
    'codex',
    '--copy',
    '-g',
    '-y',
  ]);
  assert.deepEqual(uninstallArgs({ name: 'do-thing', scope: 'project' }), [
    '-y',
    'skills@1.7.4',
    'remove',
    'do-thing',
    '-a',
    'codex',
    '-y',
  ]);
  assert.deepEqual(uninstallArgs({ name: 'do-thing', scope: 'global' }), [
    '-y',
    'skills@1.7.4',
    'remove',
    'do-thing',
    '-a',
    'codex',
    '-g',
    '-y',
  ]);
});

await check('installArgs/uninstallArgs：非法参数抛 Error', () => {
  assert.throws(() => installArgs({ source: 'no-slash', slug: 'x', scope: 'project' }), Error);
  assert.throws(() => installArgs({ source: '', slug: 'x', scope: 'project' }), Error);
  assert.throws(() => installArgs({ source: 'a/b', slug: '', scope: 'project' }), Error);
  assert.throws(() => installArgs({ source: 'a/b', slug: '   ', scope: 'project' }), Error);
  assert.throws(() => installArgs({ source: 'a/b', slug: 'x', scope: 'both' }), Error);
  assert.throws(() => installArgs({ source: 'a/b', slug: 'x' }), Error);
  assert.throws(() => installArgs(), Error);
  assert.throws(() => uninstallArgs({ name: '', scope: 'project' }), Error);
  assert.throws(() => uninstallArgs({ name: 'Bad Name', scope: 'project' }), Error);
  assert.throws(() => uninstallArgs({ name: 'a_b', scope: 'project' }), Error);
  assert.throws(() => uninstallArgs({ name: 'ok-name', scope: 'nope' }), Error);
  assert.throws(() => uninstallArgs(), Error);
});

// ---- 5. installSkill 的结果验证 ----------------------------------------------------
await check('installSkill：假 spawn 真的写文件 → ok:true，argv/cwd/dir 都对', async () => {
  const slug = 'dsc-probe-install';
  const calls = [];
  const spawn = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    makeSkill(join(project, '.agents', 'skills'), slug, `---\nname: ${slug}\n---\n`);
    return { exitCode: 0, stdout: 'installed\n', stderr: '' };
  };
  const res = await installSkill({ source: 'acme/skills', slug, scope: 'project', projectDir: project, home, spawn });
  assert.equal(res.ok, true);
  assert.equal(res.scope, 'project');
  assert.equal(res.rootId, 'project-agents');
  assert.equal(res.dir, join(projectAgents, slug));
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'installed\n');
  assert.deepEqual(calls, [{ argv: installArgs({ source: 'acme/skills', slug, scope: 'project' }), cwd: project }]);
  assert.equal(existsSync(join(projectAgents, slug, 'SKILL.md')), true);
});

await check('installSkill：exitCode 1 → ok:false stage=verify', async () => {
  const slug = 'dsc-probe-fail';
  const spawn = async () => {
    makeSkill(join(project, '.agents', 'skills'), slug); // 文件写了也照样失败：退出码非 0
    return { exitCode: 1, stdout: '', stderr: 'boom' };
  };
  const res = await installSkill({ source: 'acme/skills', slug, scope: 'project', projectDir: project, home, spawn });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'verify');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, 'boom');
  assert.equal(res.dir, join(projectAgents, slug));
});

await check('installSkill：exitCode 0 但没写文件 → 也必须 ok:false（验证不可跳过）', async () => {
  const slug = 'dsc-probe-nofile';
  const spawn = async () => ({ exitCode: 0, stdout: 'pretend ok\n', stderr: '' });
  const res = await installSkill({ source: 'acme/skills', slug, scope: 'project', projectDir: project, home, spawn });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'verify');
  assert.equal(res.dir, join(projectAgents, slug));
  assert.equal(existsSync(join(projectAgents, slug, 'SKILL.md')), false);
});

await check('installSkill：缺 spawn / project 缺 projectDir → 对应 stage', async () => {
  const noSpawn = await installSkill({ source: 'acme/skills', slug: 'x', scope: 'project', projectDir: project });
  assert.deepEqual(noSpawn, { ok: false, stage: 'spawn', error: 'no spawn adapter' });

  const noCwd = await installSkill({
    source: 'acme/skills',
    slug: 'x',
    scope: 'project',
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(noCwd.ok, false);
  assert.equal(noCwd.stage, 'cwd');
});

await check('installSkill：global 落到 ~/.agents/skills，cwd=home，stdout 截断 2000', async () => {
  const slug = 'dsc-probe-global';
  const calls = [];
  const spawn = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    makeSkill(userAgents, slug, `---\nname: ${slug}\n---\n`);
    return { exitCode: 0, stdout: 'x'.repeat(3000), stderr: 'y'.repeat(2500) };
  };
  const res = await installSkill({ source: 'acme/skills', slug, scope: 'global', projectDir: project, home, spawn });
  assert.equal(res.ok, true);
  assert.equal(res.rootId, 'user-agents');
  assert.equal(res.dir, join(userAgents, slug));
  assert.equal(res.stdout.length, 2000);
  assert.equal(res.stderr.length, 2000);
  assert.equal(calls[0].cwd, home);
  assert.equal(calls[0].argv.includes('-g'), true);
});

await check('installSkill：spawn 抛异常 → ok:false stage=spawn', async () => {
  const res = await installSkill({
    source: 'acme/skills',
    slug: 'dsc-probe-throw',
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => {
      throw new Error('npx 挂了');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'spawn');
  assert.match(res.error, /npx 挂了/);
});

// ---- 6. uninstallSkill 的结果验证 --------------------------------------------------
await check('uninstallSkill：假 spawn 真的删目录 → ok:true，removed 含该目录', async () => {
  const name = 'dsc-probe-remove';
  const dir = makeSkill(projectAgents, name, `---\nname: ${name}\n---\n`);
  const calls = [];
  const spawn = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    rmSync(dir, { recursive: true, force: true });
    return { exitCode: 0, stdout: 'removed\n', stderr: '' };
  };
  const res = await uninstallSkill({ name, scope: 'project', projectDir: project, home, spawn });
  assert.equal(res.ok, true);
  assert.equal(res.scope, 'project');
  assert.deepEqual(res.removed, [dir]);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(calls, [{ argv: uninstallArgs({ name, scope: 'project' }), cwd: project }]);
  assert.equal(existsSync(join(dir, 'SKILL.md')), false);
});

await check('uninstallSkill：exitCode 0 但目录还在 → ok:false stage=verify', async () => {
  const name = 'dsc-probe-keep';
  const dir = makeSkill(projectAgents, name);
  const res = await uninstallSkill({
    name,
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'verify');
  assert.deepEqual(res.remaining, [dir]);
  assert.equal(existsSync(join(dir, 'SKILL.md')), true);
  rmSync(dir, { recursive: true, force: true });
});

await check('uninstallSkill：exitCode 1 且目录仍在 → ok:false', async () => {
  const name = 'dsc-probe-exit1';
  const dir = makeSkill(projectAgents, name);
  const res = await uninstallSkill({
    name,
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'nope' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'verify');
  assert.equal(res.exitCode, 1);
  rmSync(dir, { recursive: true, force: true });
});

await check('uninstallSkill：项目级删掉后全局同名还在 → ok:true 且如实报出另一作用域仍在', async () => {
  const name = 'dsc-probe-both';
  const pdir = makeSkill(projectAgents, name);
  const gdir = makeSkill(userAgents, name);
  const res = await uninstallSkill({
    name,
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => {
      rmSync(pdir, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed, [pdir]);
  assert.deepEqual(res.stillInstalledElsewhere, [gdir]);
  rmSync(gdir, { recursive: true, force: true });
});

await check('uninstallSkill：作用域内的那份没删掉 → ok:false stage:verify', async () => {
  const name = 'dsc-probe-verify';
  const pdir = makeSkill(projectAgents, name);
  const res = await uninstallSkill({
    name,
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'verify');
  assert.deepEqual(res.remaining, [pdir]);
  rmSync(pdir, { recursive: true, force: true });
});

await check('uninstallSkill：global 删除成功；缺 spawn / 缺 projectDir 各自报错', async () => {
  const name = 'dsc-probe-gremove';
  const dir = makeSkill(userAgents, name, `---\nname: ${name}\n---\n`);
  const res = await uninstallSkill({
    name,
    scope: 'global',
    projectDir: project,
    home,
    spawn: async ({ cwd }) => {
      assert.equal(cwd, home);
      rmSync(dir, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed, [dir]);

  const noSpawn = await uninstallSkill({ name: 'x-y', scope: 'project', projectDir: project });
  assert.deepEqual(noSpawn, { ok: false, stage: 'spawn', error: 'no spawn adapter' });

  const noCwd = await uninstallSkill({ name: 'x-y', scope: 'project', spawn: async () => ({ exitCode: 0 }) });
  assert.equal(noCwd.ok, false);
  assert.equal(noCwd.stage, 'cwd');
});

await check('uninstallSkill：没有任何安装时删除也报成功（幂等，removed 为空）', async () => {
  const res = await uninstallSkill({
    name: 'dsc-probe-absent',
    scope: 'project',
    projectDir: project,
    home,
    spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'not installed' }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.removed, []);
});

// ---- 7. findProjectRoot ------------------------------------------------------------
await check('findProjectRoot：a/b/.git + a/b/c → a/b；.git 是文件也算', () => {
  const a = join(tmpRoot, 'tree', 'a');
  const b = join(a, 'b');
  const c = join(b, 'c');
  mkdirSync(join(b, '.git'), { recursive: true });
  mkdirSync(c, { recursive: true });
  assert.equal(findProjectRoot(c), b);
  assert.equal(findProjectRoot(b), b);

  const wt = join(tmpRoot, 'tree', 'wt');
  mkdirSync(join(wt, 'sub'), { recursive: true });
  writeFileSync(join(wt, '.git'), 'gitdir: ../somewhere\n', 'utf8'); // worktree 形态
  assert.equal(findProjectRoot(join(wt, 'sub')), wt);
});

await check('findProjectRoot：向上没有 .git 时退回入参本身', () => {
  const loose = join(tmpRoot, 'tree', 'loose', 'deep');
  mkdirSync(loose, { recursive: true });
  // 只有确认祖先里确实没有 .git 才断言，避免用例受运行机器环境影响
  let dir = loose;
  let hasGit = false;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      hasGit = true;
      break;
    }
    const parent = dir.replace(/[\\/][^\\/]+$/, '');
    if (parent === dir) break;
    dir = parent;
  }
  if (!hasGit) assert.equal(findProjectRoot(loose), loose);
});

// ---- 8. 收尾：确认没碰真实 home ----------------------------------------------------
await check('临时目录里作业，真实 home 未被写入', () => {
  assert.equal(existsSync(join(homedir(), '.agents', 'skills', 'dsc-probe-install')), false);
  assert.equal(existsSync(join(homedir(), '.agents', 'skills', 'dsc-probe-global')), false);
});

rmSync(tmpRoot, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  for (const item of failed) console.error(`FAIL ${item.label}\n  ${item.message}`);
  console.error(`installer 失败 — ${failed.length}/${checks.length} 个用例不通过`);
  process.exit(1);
}
console.log(`installer ok — ${checks.length} 个用例全过：根枚举/frontmatter/argv/装卸验证/findProjectRoot`);
