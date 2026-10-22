// zh_generate 的 check/apply 切片语义：写手只负责输入文件里的一段，
// --require-all 只能按这一段判缺失，不能把别的段算成错误。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, checkWritten } from './zh_generate.mjs';

const entry = (nameZh) => ({
  name_zh: nameZh,
  intro:
    '把一组 markdown 文件按模板重排成统一结构，适合把手写的零散笔记整理成能直接发布的文档。它会读目录下的文件、按标题层级分组，并给出缺失小节的清单。',
  usage: '把这个技能装到项目里，然后让它整理 docs 目录：生成的清单会告诉你哪几节还没写。',
  notes: '',
});

const dir = await mkdtemp(join(tmpdir(), 'dsc-zh-gen-'));
const catalogPath = join(dir, 'catalog.json');
const input = {
  catalog: catalogPath,
  skills: [{ id: 'acme/skills/alpha' }, { id: 'acme/skills/beta' }, { id: 'acme/skills/gamma' }],
};
try {
  await writeFile(
    catalogPath,
    JSON.stringify({ version: 't', count: 3, body_base: '', skills: input.skills.map((s) => ({ ...s, body: { sha256: 'x' } })) }),
    'utf8',
  );
  const writtenPath = join(dir, 'written.json');
  await writeFile(writtenPath, JSON.stringify({ entries: { 'acme/skills/beta': entry('整理笔记') } }), 'utf8');
  const written = JSON.parse(await readFile(writtenPath, 'utf8'));

  const sliced = await checkWritten({ input, written, requireAll: true, from: 1, count: 1 });
  assert.equal(sliced.ok, true, `切片内应当通过：${sliced.errors.join(' / ')}`);
  assert.equal(sliced.wantedCount, 1, '--require-all 只按切片算期望');
  assert.deepEqual(Object.keys(sliced.normalized), ['acme/skills/beta']);

  const whole = await checkWritten({ input, written, requireAll: true });
  assert.equal(whole.ok, false, '不切片时另外两条算缺失');
  assert.equal(whole.missing.length, 2);

  const outside = await checkWritten({
    input,
    written: { entries: { 'acme/skills/alpha': entry('越界条目') } },
    requireAll: true,
    from: 1,
    count: 1,
  });
  assert.equal(outside.ok, false, '切片外的条目不算数');
  assert.match(outside.errors.join('\n'), /不在输入文件里/);

  const partPath = join(dir, 'part-99.json');
  const argv = ['--input', join(dir, 'in.json'), '--written', writtenPath, '--part', partPath, '--from', '1', '--count', '1', '--require-all'];
  await writeFile(join(dir, 'in.json'), JSON.stringify(input), 'utf8');
  assert.equal(await apply(argv), 0, 'apply 应当成功');
  const first = await readFile(partPath, 'utf8');
  assert.equal(Object.keys(JSON.parse(first)).length, 1);
  assert.equal(await apply(argv), 0, 'apply 重跑应当成功');
  assert.equal(await readFile(partPath, 'utf8'), first, 'apply 必须幂等');

  const bad = await checkWritten({ input, written: { entries: {} }, requireAll: true, from: 9, count: 1 });
  assert.equal(bad.ok, true, '切片越界时没有期望条目，不算失败');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('zh_generate ok — check/apply 按 --from/--count 切片，--require-all 只按切片判缺失，apply 幂等');
