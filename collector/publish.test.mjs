// 上传前的 schema 自检 + 版本化写入的单测。
// 这层的价值全在「不合格就别写」：线上 catalog-latest.json 一旦被半成品覆盖，下游读到的
// 是一个既新又残缺的目录，而日志里什么都看不出来。所以这里用假的 put() 验顺序与拒写条件。
import assert from 'node:assert/strict';
import { pruneVersions, validateCatalog, versionedName, publishCatalog, WEIGHTS } from './publish.mjs';
import { buildCatalog } from './pipeline.mjs';

const makeCatalog = () =>
  buildCatalog(
    [
      { id: 'a/skills/alpha', slug: 'alpha', installs: 1000, description: 'one' },
      { id: 'b/skills/beta', slug: 'beta', installs: 100, description: 'two', curated: true },
    ],
    { version: 'full-2026-10-19T17-30-00-000Z', generatedAt: '2026-10-19T17:30:00.000Z' },
  );
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- 合法目录通过 ----
const good = makeCatalog();
const okCheck = validateCatalog(good);
assert.equal(okCheck.ok, true, okCheck.errors.join('; '));
assert.equal(okCheck.stats.count, 2);
assert.ok(okCheck.stats.payload_bytes > 0);
// S 必须能从 H/T/C/A 复算回来（防止有人改了权重却忘了重算）
const { H, T, C, A } = good.skills[0].score;
assert.equal(Math.round((WEIGHTS.H * H + WEIGHTS.T * T + WEIGHTS.C * C + WEIGHTS.A * A) * 10000) / 10000, good.skills[0].score.S);

// ---- 该拒绝的形状，一条都不能放过 ----
assert.equal(validateCatalog(null).ok, false);
assert.equal(validateCatalog([]).ok, false, 'array is not a catalog');
assert.equal(validateCatalog({ ...clone(good), skills: [] }).ok, false, 'empty catalog must never be published');
assert.equal(validateCatalog({ ...clone(good), version: '' }).ok, false);
assert.equal(validateCatalog({ ...clone(good), generated_at: 'not-a-date' }).ok, false);

const badCount = clone(good);
badCount.count = 3;
assert.ok(validateCatalog(badCount).errors.some((e) => e.includes('count')), 'count/skills mismatch');

const noScore = clone(good);
delete noScore.skills[0].score;
assert.ok(validateCatalog(noScore).errors.some((e) => e.includes('score missing')));

const badS = clone(good);
badS.skills[0].score.S = 1.9;
assert.ok(validateCatalog(badS).errors.some((e) => e.includes('out of [0,1]')));

const badCompose = clone(good);
badCompose.skills[0].score.S -= 0.2;
assert.ok(validateCatalog(badCompose).errors.some((e) => e.includes('recompose')), 'S must match the weights');

const dupHash = clone(good);
dupHash.skills[0].hash = 'deadbeef';
dupHash.skills[1].hash = 'deadbeef';
assert.ok(validateCatalog(dupHash).errors.some((e) => e.includes('same hash')), 'dedupe skipped → refuse to upload');

const badMerged = clone(good);
badMerged.skills[0].installs_merged = 5;
assert.ok(validateCatalog(badMerged).errors.some((e) => e.includes('installs_merged')));

const badId = clone(good);
badId.skills[0].id = 'no-slash';
assert.ok(validateCatalog(badId).errors.some((e) => e.includes('"source/slug"')));

// 排序不对只是 warning（仍然可上线，但要在日志里看得见）
const unsorted = clone(good);
unsorted.skills.reverse();
const unsortedCheck = validateCatalog(unsorted);
assert.equal(unsortedCheck.ok, true);
assert.ok(unsortedCheck.warnings.some((w) => w.includes('sorted')));

// ---- 版本化文件名 ----
assert.equal(versionedName(good), 'catalog-2026-10-19T17-30-00-000Z.json');
assert.equal(versionedName({ version: 'dir-2026-10-19T17-30-00-000Z' }), 'catalog-2026-10-19T17-30-00-000Z.json');
assert.equal(versionedName(good, 'skills'), 'skills-2026-10-19T17-30-00-000Z.json');

// ---- 写顺序：版本化快照先写，latest 指针最后写 ----
const writes = [];
const put = async (pathname, body, opts) => {
  writes.push({ pathname, bytes: Buffer.byteLength(body), opts });
  return { url: `https://blob.test/${pathname}` };
};
const published = await publishCatalog({ catalog: good, put, log: () => {} });
assert.equal(published.ok, true);
assert.deepEqual(
  writes.map((w) => w.pathname),
  ['catalog-2026-10-19T17-30-00-000Z.json', 'catalog-latest.json'],
  'versioned snapshot must be written before the latest pointer',
);
assert.ok(writes.every((w) => w.opts.access === 'public'), 'put() access is mandatory — must always be passed');
assert.ok(writes.every((w) => w.opts.allowOverwrite === true), 're-running the same version must be idempotent');
assert.ok(writes.every((w) => w.opts.contentType === 'application/json'));
assert.equal(published.versioned.url, 'https://blob.test/catalog-2026-10-19T17-30-00-000Z.json');
assert.equal(published.latest.url, 'https://blob.test/catalog-latest.json');

// ---- 快照写失败时，latest 指针绝不能被更新 ----
const failingWrites = [];
const failingPut = async (pathname) => {
  failingWrites.push(pathname);
  throw new Error('blob 500');
};
await assert.rejects(() => publishCatalog({ catalog: good, put: failingPut, log: () => {} }), /blob 500/);
assert.deepEqual(failingWrites, ['catalog-2026-10-19T17-30-00-000Z.json'], 'latest must not be touched on failure');

// ---- 目录不合格 → 一个字节都不写 ----
const neverCalled = [];
const rejected = await publishCatalog({
  catalog: { ...clone(good), skills: [] },
  put: async (p) => neverCalled.push(p),
  log: () => {},
});
assert.equal(rejected.ok, false);
assert.equal(rejected.stage, 'validate');
assert.deepEqual(neverCalled, [], 'validate failure must short-circuit before any upload');

// ---- access 必填且取值有限 ----
const badAccess = await publishCatalog({ catalog: good, put, access: 'world-readable', log: () => {} });
assert.equal(badAccess.ok, false);
assert.ok(badAccess.errors[0].includes('public|private'));
const noPut = await publishCatalog({ catalog: good, log: () => {} });
assert.equal(noPut.ok, false);
assert.equal(noPut.stage, 'upload');
assert.ok(noPut.stats.count === 2, 'even a failed upload reports what the catalog looked like');

// ---- 保留策略：只留最近 N 个版本快照，指针文件与最新 N 个必须活着 ----
{
  const snapshots = Array.from({ length: 18 }, (_, i) => ({
    pathname: `catalog-2026-10-${String(i + 1).padStart(2, '0')}T05-00-00-000Z.json`,
    url: `https://blob.example/catalog-2026-10-${String(i + 1).padStart(2, '0')}T05-00-00-000Z.json`,
  }));
  const listed = [
    ...snapshots,
    // 指针不能进这个前缀的过滤里，就算端点把它一起返回了也不许删
    { pathname: 'catalog-latest.json', url: 'https://blob.example/catalog-latest.json' },
  ];
  const deleted = [];
  const pruneResult = await pruneVersions({
    list: async () => ({ blobs: listed }),
    del: async (url) => deleted.push(url),
    keep: 14,
    log: () => {},
  });
  assert.equal(pruneResult.deleted.length, 4, '18 snapshots with keep=14 leaves 4 to delete');
  assert.equal(pruneResult.kept, 14);
  assert.ok(!deleted.some((url) => url.includes('latest')), 'the latest pointer must never be deleted');
  assert.ok(deleted.every((url) => /catalog-2026-10-0[1-4]T/.test(url)), 'oldest snapshots go first');

  // list/del 缺失时不能报错，也不能假装删过
  const noApi = await pruneVersions({});
  assert.deepEqual(noApi.deleted, []);
  assert.ok(noApi.errors.length > 0);
  // 端点列不出来时只记错误，绝不阻塞发布
  const listFails = await pruneVersions({ list: async () => { throw new Error('list 500'); }, del: async () => {} });
  assert.deepEqual(listFails.deleted, []);
  assert.match(listFails.errors[0], /list 500/);
}

console.log(
  `publish ok — ${writes.length} blob writes in order (${writes.map((w) => w.pathname).join(' → ')}), ` +
    `${okCheck.stats.payload_bytes}B payload, invalid catalogs never reach put(), retention keeps the newest 14`,
);
