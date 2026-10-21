// /local /install /uninstall 三条路由的端到端胶水测试：假 subprocess 服务 + 真 installer.js + 临时磁盘。
// 运行：node tests/install-routes.test.mjs
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const TMP = await mkdtemp(join(tmpdir(), 'skills-center-install-'));
// rootsHome() 取 DSH_HOME 的上一级当 home：全局根 = <TMP>/.agents/skills 与 <TMP>/.dsh/skills
process.env.DSH_HOME = join(TMP, '.dsh');
const PROJECT = join(TMP, 'proj');
await mkdir(join(PROJECT, '.git'), { recursive: true });

const { apply } = await import('../lib/index.js');

const SKILL_ID = 'acme/skills/hello';
await mkdir(join(TMP, '.dsh', 'skills-center', 'catalog'), { recursive: true });
await writeFile(
  join(TMP, '.dsh', 'skills-center', 'catalog', 'catalog.json'),
  JSON.stringify({
    version: 'test-install',
    count: 1,
    raw_count: 1,
    max_installs: 10,
    skills: [
      {
        id: SKILL_ID,
        source: 'acme/skills',
        slug: 'hello',
        name: 'hello',
        installs: 10,
        description_en: 'says hello',
      },
    ],
  }),
  'utf8',
);

// ---- 假 subprocess：把 argv 记下来，并真的按官方 CLI 的落点建/删目录 ----
const spawns = [];
const fakeSubprocess = {
  async resolveExecutable(name) {
    return `C:/fake/${name}.cmd`;
  },
  spawn({ argv, cwd }) {
    spawns.push({ argv, cwd });
    const skillDir = join(cwd, '.agents', 'skills', 'hello');
    if (argv.includes('add')) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: hello\ndescription: fixture\n---\n\n# hello\n');
    } else if (argv.includes('remove')) {
      rmSync(skillDir, { recursive: true, force: true });
    }
    const text = (value) => ({ readFrom: () => ({ text: value, nextOffset: value.length, lossy: false }) });
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: { stdout: text('installed'), stderr: text('') },
    };
  },
};

const captured = { routes: [] };
const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => dispose?.();
  },
  skills: { registerProvider: () => () => {}, invalidateCache: () => {} },
  tools: { register: () => () => {} },
  webServer: {
    register(route) {
      captured.routes.push(route);
      return () => {};
    },
  },
  subprocess: fakeSubprocess,
  workingDirectory: { defaultDirectory: PROJECT },
};
apply(ctx, {});
const route = captured.routes[0];

const callApi = async (pathname, { method = 'GET', body = null } = {}) => {
  let text = '';
  const headers = {};
  const req = {
    url: pathname,
    method,
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
  const res = {
    statusCode: 0,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      text = chunk;
    },
  };
  await route.handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { code: res.statusCode, body: parsed, raw: text };
};

// 1) 项目级安装：路由要用宿主默认目录当项目根，并走官方 CLI 的 argv
const install = await callApi('/api/dsh-skills-center/install', { method: 'POST', body: { id: SKILL_ID, scope: 'project' } });
assert.equal(install.code, 200, install.raw);
assert.equal(install.body.ok, true);
assert.equal(install.body.dir, join(PROJECT, '.agents', 'skills', 'hello'));
assert.equal(spawns.length, 1);
assert.deepEqual(spawns[0].argv, ['C:/fake/npx.cmd', '-y', 'skills@1.7.4', 'add', 'acme/skills', '--skill', 'hello', '-a', 'codex', '--copy', '-y']);
assert.equal(spawns[0].cwd, PROJECT, '项目级安装的 cwd 必须是项目根');

// 2) 清单：项目级那条要出现在 /local，并标出 scope 与根
const local = await callApi('/api/dsh-skills-center/local');
assert.equal(local.code, 200, local.raw);
assert.equal(local.body.project, PROJECT);
assert.equal(local.body.projectSource, 'host');
const projectSkill = local.body.skills.find((s) => s.name === 'hello' && s.scope === 'project');
assert.ok(projectSkill, '刚装的技能应出现在项目级清单里');
assert.equal(projectSkill.rootId, 'project-agents');
assert.match(projectSkill.description, /fixture/);
// 和目录的连接：目录名 = slug，凭它补出 catalogId / 总装量 / 正文缓存状态
assert.equal(projectSkill.catalogId, SKILL_ID);
assert.equal(projectSkill.inCatalog, true);
assert.equal(projectSkill.installs_total, 10);
assert.deepEqual(projectSkill.breakdown.project, [join(PROJECT, '.agents', 'skills', 'hello')]);
assert.deepEqual(projectSkill.breakdown.global, []);
assert.equal(projectSkill.hasBody, false, '正文没缓存过就该是 false');

// 3) 全局安装：cwd 换成 home，落 ~/.agents/skills
const globalInstall = await callApi('/api/dsh-skills-center/install', { method: 'POST', body: { id: SKILL_ID, scope: 'global' } });
assert.equal(globalInstall.code, 200, globalInstall.raw);
assert.equal(globalInstall.body.dir, join(TMP, '.agents', 'skills', 'hello'));
assert.deepEqual(spawns[1].argv, ['C:/fake/npx.cmd', '-y', 'skills@1.7.4', 'add', 'acme/skills', '--skill', 'hello', '-a', 'codex', '--copy', '-g', '-y']);
assert.equal(spawns[1].cwd, TMP, '全局安装的 cwd 是 home');

const both = await callApi('/api/dsh-skills-center/local');
assert.equal(both.body.skills.filter((s) => s.name === 'hello').length, 2, '项目级与全局同名两条都要列');

// 4) 卸载：只卸项目级，全局那条必须还在
const uninstall = await callApi('/api/dsh-skills-center/uninstall', { method: 'POST', body: { name: 'hello', scope: 'project' } });
assert.equal(uninstall.code, 200, uninstall.raw);
assert.equal(uninstall.body.ok, true);
assert.deepEqual(uninstall.body.removed, [join(PROJECT, '.agents', 'skills', 'hello')]);
assert.equal(existsSync(join(PROJECT, '.agents', 'skills', 'hello')), false);
assert.equal(existsSync(join(TMP, '.agents', 'skills', 'hello')), true, '全局那条不该被项目级卸载碰到');

// 5) 错误路径：未知名 / 坏名字 / 方法不对 / 坏 JSON
assert.equal((await callApi('/api/dsh-skills-center/install', { method: 'POST', body: { id: 'acme/skills/nope' } })).code, 404);
assert.equal((await callApi('/api/dsh-skills-center/install', { method: 'GET' })).code, 405);
assert.equal((await callApi('/api/dsh-skills-center/install', { method: 'POST', body: '{oops' })).code, 400);
assert.equal((await callApi('/api/dsh-skills-center/uninstall', { method: 'POST', body: { name: 'Hello World' } })).code, 400);
assert.equal(spawns.length, 3, '失败路径一个进程都不该起');

await rm(TMP, { recursive: true, force: true });
console.log('install-routes ok — 项目级/全局安装各落对目录、清单分作用域、卸载互不干扰、错误路径不起进程');
