// 技能根枚举 + 安装/卸载 argv 组装 + 结果验证。
// 为什么把根目录硬编码在这里：DSH 只扫这几个固定位置（一层深，目录内含 SKILL.md 才算技能），
// 面板要显示「真正生效的」技能就只能照 DSH 自己的扫描规则来，自建索引一定会和核心漂移。
// 为什么自己不实现安装器：装/卸都由官方 skills CLI 落盘，本模块只负责「拼 argv + 跑 + 用文件系统复核」，
// 这样 CLI 的目录约定变了我们最多是验不过，而不会静默装到 DSH 看不见的地方。
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 每个 scope 下「官方 CLI 真正落盘」的根 id（managed:true 的那些）。 */
export const MANAGED_SCOPE = { project: 'project-agents', global: 'user-agents' };

/** 版本钉死：argv 逐字可控，避免某次 CLI 更新静默改变落点。 */
const SKILLS_CLI = 'skills@1.7.4';
/** -a codex 对应的落点正是 .agents/skills（项目）与 ~/.agents/skills（全局）。 */
const AGENT = 'codex';
const SKILL_FILE = 'SKILL.md';
/** stdout/stderr 灌进面板前必须截断，否则一次失败能把 UI 撑爆。 */
const MAX_STREAM = 2000;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isText = (value) => typeof value === 'string' && value.length > 0;

const reason = (err) => (err && err.message ? err.message : String(err));

/** argv 里的 scope 处理：-g 必须紧跟其它参数、且在收尾的 -y 之前。 */
function withGlobal(argv, scope) {
  if (scope === 'project') return argv;
  if (scope === 'global') {
    argv.splice(argv.length - 1, 0, '-g');
    return argv;
  }
  throw new Error(`scope 只能是 project 或 global，收到：${String(scope)}`);
}

function existsVia(fsImpl, path) {
  try {
    return Boolean(fsImpl.existsSync(path));
  } catch {
    return false;
  }
}

function truncate(value) {
  // 只留前 2000 个字符：多了对排障没帮助，却会让结果对象在 IPC 上变得很重。
  return String(value == null ? '' : value).slice(0, MAX_STREAM);
}

/**
 * DSH 的技能根清单，按 rank 升序（rank 小 = 优先级高，同名技能先命中小的）。
 * projectDir 缺失时退化为 cwd：不这样做 join(undefined, ...) 会直接抛错，面板只传一半参数就整块列表挂掉。
 * @returns {Array<{id:string, scope:'project'|'global', rank:number, dir:string, managed:boolean}>}
 */
export function rootDescriptors({ projectDir, home = homedir() } = {}) {
  const projectBase = isText(projectDir) ? projectDir : process.cwd();
  const userBase = isText(home) ? home : homedir();
  return [
    { id: 'project-dsh', scope: 'project', rank: 100, dir: join(projectBase, '.dsh', 'skills'), managed: false },
    {
      id: 'project-agents',
      scope: 'project',
      rank: 200,
      dir: join(projectBase, '.agents', 'skills'),
      managed: true,
    },
    { id: 'user-dsh', scope: 'global', rank: 400, dir: join(userBase, '.dsh', 'skills'), managed: false },
    { id: 'user-agents', scope: 'global', rank: 500, dir: join(userBase, '.agents', 'skills'), managed: true },
  ].sort((a, b) => a.rank - b.rank);
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;

/**
 * 取要扫描的 frontmatter 行。
 * 有 --- 围栏就只看围栏内；没有围栏时只认「从第一行开始连续的 key: value」，一旦遇到正文就停——
 * 否则正文里出现一句 "name: ..." 会被当成元数据，把技能名改成正文里的字。
 */
function frontmatterLines(lines) {
  const start = lines.findIndex((line) => line.trim().length > 0);
  if (start === -1) return [];
  if (lines[start].trim() !== '---') {
    const head = [];
    for (let i = start; i < lines.length; i += 1) {
      if (!KEY_LINE.test(lines[i])) break;
      head.push(lines[i]);
    }
    return head;
  }
  const end = lines.findIndex((line, i) => i > start && line.trim() === '---');
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/** description 常被写成块标量（`description: |` + 缩进正文），拼成一行比只留一个 "|" 有用得多。 */
function blockScalar(lines, index) {
  const parts = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!/^\s/.test(line)) break; // 回到顶格就是下一个键了
    parts.push(line.trim());
  }
  return parts.join(' ').trim();
}

/** 去掉包裹的引号：description 常含 ':' 或 '*'，作者多半会加引号，不加引号也照收。 */
function unquote(raw) {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1).trim();
  }
  return raw;
}

/**
 * 解析 SKILL.md 的 frontmatter，只取 name/description。
 * 永不抛异常：一个有语法错误的自述文件不应该让整个技能列表加载失败。
 * @returns {{name:string|null, description:string|null}}
 */
export function parseFrontmatter(text) {
  const out = { name: null, description: null };
  if (typeof text !== 'string' || text.length === 0) return out;
  const lines = frontmatterLines(text.replace(/^\uFEFF/, '').split(/\r?\n/));
  for (let i = 0; i < lines.length; i += 1) {
    const matched = KEY_LINE.exec(lines[i]);
    if (!matched) continue; // 缩进行（嵌套结构/块标量正文）不匹配，天然被跳过
    const key = matched[1].toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    if (out[key] !== null) continue; // 先出现的那条赢，后面的重复键忽略
    const raw = matched[2].trim();
    const value = BLOCK_SCALAR.test(raw) ? blockScalar(lines, i) : unquote(raw);
    if (value.length > 0) out[key] = value;
  }
  return out;
}

function readMeta(fsImpl, skillFile) {
  try {
    return parseFrontmatter(fsImpl.readFileSync(skillFile, 'utf8'));
  } catch {
    return { name: null, description: null };
  }
}

/** 目录判定要容忍符号链接/junction：npx 在某些平台会给技能目录建链接而不是复制。 */
function isDirectory(entry, parent, fsImpl) {
  if (typeof entry.isDirectory === 'function' && entry.isDirectory()) return true;
  if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
    try {
      return fsImpl.statSync(join(parent, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 列出 DSH 真正会看到的技能（同步：面板让它出现在同一帧初始渲染里）。
 * 只扫一层；只认「目录 + 目录内 SKILL.md」这种形态——根下散放的 *.md 是资料不是技能，
 * 我们在这里不收，核心也不会加载它，收了反而会显示一批点不动的假技能。
 * 项目级与全局同名技能各列一条（不去重）：它们的 rank 不同，实际命中哪个是 DSH 决定的。
 * @returns {{ok:boolean, roots:Array<object>, skills:Array<object>}}
 */
export function listInstalled({ projectDir, home, fsImpl = fs } = {}) {
  const roots = rootDescriptors({ projectDir, home }).map((root) => ({
    ...root,
    exists: existsVia(fsImpl, root.dir),
  }));
  const skills = [];
  let ok = true;
  for (const root of roots) {
    if (!root.exists) continue;
    let entries;
    try {
      entries = fsImpl.readdirSync(root.dir, { withFileTypes: true });
    } catch (err) {
      // 存在却读不动（权限/占位文件）是真故障，如实标出来而不是当成空目录。
      root.error = reason(err);
      ok = false;
      continue;
    }
    for (const entry of entries) {
      if (!isDirectory(entry, root.dir, fsImpl)) continue;
      const skillFile = join(root.dir, entry.name, SKILL_FILE);
      if (!existsVia(fsImpl, skillFile)) continue;
      const meta = readMeta(fsImpl, skillFile);
      skills.push({
        name: meta.name || entry.name,
        description: meta.description,
        scope: root.scope,
        rank: root.rank,
        dir: join(root.dir, entry.name),
        rootId: root.id,
        skillFile,
      });
    }
  }
  return { ok, roots, skills };
}

/**
 * 安装用的 argv（纯函数，可逐字断言）。
 * source 必须是 owner/repo 形式：单段名字会被 npx 当成包名去 registry 找，报错信息极难懂。
 */
export function installArgs({ source, slug, scope } = {}) {
  if (!isText(source) || !source.includes('/')) {
    throw new Error(`install source 必须是 owner/repo 形式，收到：${String(source)}`);
  }
  if (!isText(slug) || slug.trim().length === 0) throw new Error('install slug 不能为空');
  const argv = ['-y', SKILLS_CLI, 'add', source, '--skill', slug, '-a', AGENT, '--copy', '-y'];
  return withGlobal(argv, scope);
}

/**
 * 卸载用的 argv（纯函数，可逐字断言）。
 * 名字必须是非空 kebab 名：它同时是目录名，带斜杠/空格的名字会变成路径穿越或匹配不上。
 */
export function uninstallArgs({ name, scope } = {}) {
  if (!isText(name) || !KEBAB.test(name)) {
    throw new Error(`uninstall name 必须是非空 kebab 名，收到：${String(name)}`);
  }
  const argv = ['-y', SKILLS_CLI, 'remove', name, '-a', AGENT, '-y'];
  return withGlobal(argv, scope);
}

function managedRoot(scope, opts) {
  const wanted = MANAGED_SCOPE[scope];
  const roots = rootDescriptors(opts);
  return roots.find((root) => root.id === wanted) ?? roots.find((root) => root.managed && root.scope === scope);
}

/**
 * 安装一个技能，并复核文件真的落到了 DSH 会扫的位置。
 * spawn 由调用方注入（本模块不 import child_process），契约：await spawn({ argv, cwd }) -> { exitCode, stdout, stderr }。
 * 判断成败以「SKILL.md 是否存在」为准而不是退出码：CLI 在缓存命中、部分失败等情况下也会回 0，
 * 只有文件真的在，面板里的「已安装」才是真的。
 */
export async function installSkill({
  source,
  slug,
  scope,
  projectDir,
  home,
  spawn,
  fsImpl = fs,
  log = () => {},
} = {}) {
  if (typeof spawn !== 'function') return { ok: false, stage: 'spawn', error: 'no spawn adapter' };
  if (scope === 'project' && !isText(projectDir)) {
    return { ok: false, stage: 'cwd', error: 'project scope requires projectDir' };
  }
  const argv = installArgs({ source, slug, scope });
  const cwd = scope === 'project' ? projectDir : isText(home) ? home : homedir();
  const root = managedRoot(scope, { projectDir, home });
  const dir = join(root.dir, slug);
  log(`[installer] npx ${argv.join(' ')} (cwd=${cwd})`);

  let run;
  try {
    run = await spawn({ argv, cwd });
  } catch (err) {
    return { ok: false, stage: 'spawn', error: reason(err) };
  }
  const exitCode = run && run.exitCode != null ? run.exitCode : null;
  const stdout = truncate(run && run.stdout);
  const stderr = truncate(run && run.stderr);

  if (exitCode !== 0 || !existsVia(fsImpl, join(dir, SKILL_FILE))) {
    return { ok: false, stage: 'verify', exitCode, stdout, stderr, dir };
  }
  return { ok: true, scope, dir, rootId: root.id, exitCode, stdout, stderr };
}

/**
 * 卸载一个技能，并复核所有 managed 根里都不再残留它的 SKILL.md。
 * 退出码不作为判据：CLI 对「本来就不存在」也会回非 0，那时按文件系统看确实已经卸干净了，
 * 报失败只会让用户反复点一个永远「失败」的按钮。
 */
export async function uninstallSkill({ name, scope, projectDir, home, spawn, fsImpl = fs } = {}) {
  if (typeof spawn !== 'function') return { ok: false, stage: 'spawn', error: 'no spawn adapter' };
  if (scope === 'project' && !isText(projectDir)) {
    return { ok: false, stage: 'cwd', error: 'project scope requires projectDir' };
  }
  const argv = uninstallArgs({ name, scope });
  const cwd = scope === 'project' ? projectDir : isText(home) ? home : homedir();
  const managed = rootDescriptors({ projectDir, home }).filter((root) => root.managed);
  // 只按调用方给的作用域判成败：另一个作用域里还有同名技能不算这次卸载失败。
  const inScope = managed.filter((root) => root.scope === scope);
  const outScope = managed.filter((root) => root.scope !== scope);
  const others = outScope
    .map((root) => join(root.dir, name))
    .filter((dir) => existsVia(fsImpl, join(dir, SKILL_FILE)));
  const before = inScope
    .map((root) => join(root.dir, name))
    .filter((dir) => existsVia(fsImpl, join(dir, SKILL_FILE)));

  let run;
  try {
    run = await spawn({ argv, cwd });
  } catch (err) {
    return { ok: false, stage: 'spawn', error: reason(err) };
  }
  const exitCode = run && run.exitCode != null ? run.exitCode : null;
  const stdout = truncate(run && run.stdout);
  const stderr = truncate(run && run.stderr);

  // 判据只看这次作用域里的那几个根：CLI 只删它自己 scope 的那份。
  const remaining = before.filter((dir) => existsVia(fsImpl, join(dir, SKILL_FILE)));
  if (remaining.length > 0) {
    return { ok: false, stage: 'verify', exitCode, stdout, stderr, remaining };
  }
  const stillInstalledElsewhere = others.filter((dir) => existsVia(fsImpl, join(dir, SKILL_FILE)));
  return { ok: true, scope, removed: before, stillInstalledElsewhere, exitCode, stdout, stderr };
}

/**
 * 从 cwd 向上找最近含 .git 的祖先，找不到就返回 cwd（与 DSH 判定 projectRoot 的规则一致）。
 * 要看 .git 是否存在而不是解析 git 仓库：.git 也可能是文件（worktree/submodule），这正是项目根。
 */
export function findProjectRoot(cwd, fsImpl = fs) {
  if (!isText(cwd)) return cwd;
  let dir = cwd;
  for (;;) {
    if (existsVia(fsImpl, join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd; // 到盘根都没有 .git：退回起点，让调用方自己决定怎么处理
    dir = parent;
  }
}
