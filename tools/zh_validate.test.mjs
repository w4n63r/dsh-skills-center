// zh_validate 的单测：好条目通过；长度、禁用词、tier、能力词不在正文 四类失败各抓一条；
// 没有正文缓存时走 skipped_no_body 不算失败。全程只读临时目录，不联网。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, validateCatalog, validateEntry, checkUsageTrace } from './zh_validate.mjs';

const NAME = 'zh_validate';
const dir = await mkdtemp(join(tmpdir(), 'dsc-zh-validate-'));
const sha = 'a'.repeat(64);
const bodiesDir = join(dir, 'bodies');

try {
  const body = [
    '---',
    'name: demo',
    'description: demo skill for tests',
    '---',
    '',
    '# Demo',
    '',
    '```bash',
    'npx skills add demo/pkg',
    'npm run build',
    '```',
    '',
    '文档：https://example.com/demo/docs',
    '',
  ].join('\n');
  await mkdir(bodiesDir, { recursive: true });
  await writeFile(join(bodiesDir, `${sha}.md`), body, 'utf8');

  const intro =
    '这个技能把演示目录里的条目读出来，按安装量降序打印，并且会在正文里核对每条命令是否真存在。它适合在写中文卡之前先看一眼素材，不适合拿来做最终验收。';
  const usage = '准备素材时跑 `npx skills add demo/pkg`，再 npm run build 检查；细节看 https://example.com/demo/docs 里的说明。';
  const good = { name_zh: '演示素材', intro, usage, notes: '', tier: 'hand' };
  const id = 'demo/x';

  // ---- 1) 好条目通过 ----
  const passing = validateEntry(good, { id, body });
  assert.equal(passing.ok, true, `good entry must pass: ${passing.errors.join(' | ')}`);
  assert.equal(passing.tier, 'hand');
  assert.equal(passing.skipped_no_body, false, 'body was provided, so nothing is skipped');

  // tier：显式 auto 保留；缺失按 hand（兼容旧数据），且不算错
  assert.equal(validateEntry({ ...good, tier: 'auto' }, { id, body }).tier, 'auto');
  const noTier = validateEntry({ name_zh: good.name_zh, intro: good.intro, usage: good.usage, notes: '' }, { id, body });
  assert.equal(noTier.ok, true, 'missing tier is allowed');
  assert.equal(noTier.tier, 'hand', 'missing tier falls back to hand');

  // ---- 2) 长度失败 ----
  const shortIntro = validateEntry({ ...good, intro: '太短了' }, { id, body });
  assert.equal(shortIntro.ok, false);
  assert.ok(shortIntro.errors.some((e) => /intro 长度/.test(e)), `expected intro length error: ${shortIntro.errors.join(' | ')}`);
  const longName = validateEntry({ ...good, name_zh: '这是一个明显超过十六个码点上限的中文名字' }, { id, body });
  assert.ok(longName.errors.some((e) => /name_zh 长度/.test(e)), 'name_zh 超过 16 个码点要报错');
  // 放宽到 16 之后，产品名不再被迫缩写（例如「Spring Boot 测试」15 个码点）
  const roomyName = validateEntry({ ...good, name_zh: 'Spring Boot 测试' }, { id, body });
  assert.equal(roomyName.errors.some((e) => /name_zh 长度/.test(e)), false, '15 个码点的产品名应当通过');

  // ---- 3) 禁用词失败 ----
  const banned = validateEntry({ ...good, notes: '这就是个神器' }, { id, body });
  assert.equal(banned.ok, false);
  assert.ok(banned.errors.some((e) => /含禁用词 "神器"/.test(e)), `expected banned word error: ${banned.errors.join(' | ')}`);

  // ---- 4) tier 非法失败 ----
  const badTier = validateEntry({ ...good, tier: 'machine' }, { id, body });
  assert.equal(badTier.ok, false);
  assert.ok(badTier.errors.some((e) => /tier .*非法/.test(e)), `expected tier error: ${badTier.errors.join(' | ')}`);

  // ---- 5) 能力词不在正文失败（反引号内容 / 命令片段 / URL 各一条）----
  const missingUsage = '没有的 `npx skills add other/pkg`，外加 npm run deploy，还有 https://nope.example/x 要看。';
  const missing = validateEntry({ ...good, usage: missingUsage }, { id, body });
  assert.equal(missing.ok, false);
  const joined = missing.errors.join(' | ');
  assert.ok(joined.includes('`npx skills add other/pkg`'), `expected missing code span: ${joined}`);
  assert.ok(joined.includes('npm run deploy'), `expected missing command fragment: ${joined}`);
  assert.ok(joined.includes('nope.example'), `expected missing URL: ${joined}`);
  // 正文里有的能力词不该报
  assert.deepEqual(checkUsageTrace(good.usage, body), [], 'probes present in the body produce no error');
  assert.ok(checkUsageTrace(missingUsage, body).length === 3, 'three unfindable probes → three errors');

  // ---- 6) 没有正文 → skipped_no_body，不算失败 ----
  const skipped = await validateCatalog({ [id]: good }, { wanted: [id], readBody: async () => null });
  assert.equal(skipped.ok, true, `no body must not fail: ${skipped.errors.join(' | ')}`);
  assert.deepEqual(skipped.skipped_no_body, [id]);
  assert.equal(skipped.tierCounts.hand, 1);
  // bodies 目录在、但该 sha 的文件不存在，同样只是跳过
  const noFile = await validateCatalog({ [id]: good }, { wanted: [id], bodiesDir, bodyHashes: new Map([[id, 'b'.repeat(64)]]) });
  assert.equal(noFile.ok, true);
  assert.deepEqual(noFile.skipped_no_body, [id]);

  // ---- 7) validateCatalog 带正文：通过 / 能力词失败 / 集合不符 ----
  const withBody = await validateCatalog({ [id]: good }, { wanted: [id], bodiesDir, bodyHashes: new Map([[id, sha]]) });
  assert.equal(withBody.ok, true, `catalog with bodies must pass: ${withBody.errors.join(' | ')}`);
  assert.deepEqual(withBody.skipped_no_body, [], 'body was found, so nothing is skipped');
  assert.equal(withBody.tierCounts.hand, 1);

  const catalogMissing = await validateCatalog(
    { [id]: { ...good, usage: missingUsage } },
    { wanted: [id], bodiesDir, bodyHashes: new Map([[id, sha]]) },
  );
  assert.equal(catalogMissing.ok, false);
  assert.ok(catalogMissing.errors.some((e) => e.startsWith(`${id}: usage 里的`)), 'capability errors carry the id prefix');

  const extra = await validateCatalog({ [id]: good, 'demo/extra': good }, { wanted: [id] });
  assert.ok(extra.errors.some((e) => /不许自己加/.test(e)), 'extra ids are rejected');
  const absent = await validateCatalog({}, { wanted: [id] });
  assert.ok(absent.errors.some((e) => /缺少条目/.test(e)), 'missing ids are rejected');

  // ---- 8) CLI：好分片退出 0，坏分片退出 1 ----
  const catalogPath = join(dir, 'catalog.json');
  await writeFile(catalogPath, `${JSON.stringify({ version: 'test-1', skills: [{ id, body: { sha256: sha } }] })}\n`, 'utf8');
  const inputPath = join(dir, 'batch-1.json');
  await writeFile(inputPath, `${JSON.stringify({ count: 1, skills: [{ id }] })}\n`, 'utf8');
  const goodPart = join(dir, 'part-ok.json');
  await writeFile(goodPart, `${JSON.stringify({ [id]: good }, null, 2)}\n`, 'utf8');
  const badPart = join(dir, 'part-bad.json');
  await writeFile(badPart, `${JSON.stringify({ [id]: { ...good, intro: '短' } }, null, 2)}\n`, 'utf8');

  assert.equal(await run([inputPath, goodPart, '--catalog', catalogPath]), 0, 'good part exits 0');
  assert.equal(await run([inputPath, badPart, '--catalog', catalogPath]), 1, 'bad part exits 1');
  assert.equal(await run([inputPath, goodPart, '--bodies', bodiesDir, '--catalog', catalogPath]), 0);

  console.log(`${NAME} ok — 好条目通过；长度/禁用词/tier/能力词四类失败各抓到；无正文走 skipped_no_body；CLI 退出码正确`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
