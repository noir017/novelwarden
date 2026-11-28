/**
 * 「版本」时间线上 git 那几行的纯函数（`src/core/workspace/gitVersions.ts`）：读 `git log -z --raw` 与 `cat-file --batch`
 * 的输出、连着一样的只留最早、id 的认法。真仓库里跑的那一半在 tests/integration/workspace/gitVersions.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | log | 每次提交一条、新的在前；改名那一条取新 blob；合并提交（没有 raw）、删掉它的（新 blob 全零）、读不懂的跳过 |
 * | 去重 | 连着几次 blob 一样（纯改名）只留最早那一次；不相邻的一样（改回去了）各留各的 |
 * | cat-file | 按字节数切，内容里有换行、中文也不乱；`missing` 跳过；截断了就停，前面的照给 |
 * | id | `git:<提交>:<blob>` 才认；短号、多一段、别的前缀都不认（不拿前端传的字串去拼命令） |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const g = loadModule('src/core/workspace/gitVersions.ts');

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const C4 = '4'.repeat(40);
const B1 = 'a'.repeat(40);
const B2 = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

/** 照 `git log -z --raw --no-abbrev --format=%x1e%H%x1f%ct%x1f%an%x1f%s` 拼一条。 */
function commit(sha, ct, author, subject, raw) {
  return `\x1e${sha}\x1f${ct}\x1f${author}\x1f${subject}\0${raw ? `\n${raw}` : ''}`;
}
const modify = (from, to, file) => `:100644 100644 ${from} ${to} M\0${file}\0`;

describe('parseGitLog', () => {
  test('每次提交一条，新的在前；时间是毫秒，作者与说明原样', () => {
    const out =
      commit(C2, 1795859300, '作者', '改了开头', modify(B1, B2, 'chapters/001-雨夜.md')) +
      commit(C1, 1795859200, '作者', '第一章初稿', `:000000 100644 ${ZERO} ${B1} A\0chapters/001-雨夜.md\0`);
    assert.deepEqual(g.parseGitLog(out), [
      { commit: C2, time: 1795859300000, author: '作者', subject: '改了开头', blob: B2 },
      { commit: C1, time: 1795859200000, author: '作者', subject: '第一章初稿', blob: B1 },
    ]);
  });

  test('改名那一条（两个路径）取新 blob', () => {
    const out = commit(C2, 1795859300, 'a', '改名', `:100644 100644 ${B1} ${B2} R087\0chapters/001-旧.md\0chapters/001-新.md\0`);
    assert.equal(g.parseGitLog(out)[0].blob, B2);
  });

  test('合并提交（没有 raw 那一行）、删掉它的（新 blob 全零）、读不懂的跳过', () => {
    const out =
      commit(C4, 1795859400, 'a', '合并', '') +
      commit(C3, 1795859300, 'a', '删了', `:100644 000000 ${B1} ${ZERO} D\0chapters/001.md\0`) +
      '\x1e不是提交号\x1f1\x1fa\x1fb\0\n' +
      commit(C1, 1795859200, 'a', '留下', modify(ZERO, B1, 'chapters/001.md'));
    assert.deepEqual(
      g.parseGitLog(out).map((e) => e.commit),
      [C1]
    );
  });

  test('空输出（没提交过）给空数组', () => {
    assert.deepEqual(g.parseGitLog(''), []);
  });
});

describe('dedupeGitLog：连着一样的只留最早那一次', () => {
  const e = (commit, blob) => ({ commit, blob, time: 0, author: '', subject: '' });

  test('纯改名（blob 没变）并进它之前那一次', () => {
    assert.deepEqual(
      g.dedupeGitLog([e(C3, B2), e(C2, B2), e(C1, B1)]).map((x) => x.commit),
      [C2, C1]
    );
  });

  test('改回去了（不相邻的一样）各留各的', () => {
    assert.deepEqual(
      g.dedupeGitLog([e(C3, B1), e(C2, B2), e(C1, B1)]).map((x) => x.commit),
      [C3, C2, C1]
    );
  });
});

describe('parseCatFileBatch', () => {
  test('按字节数切：内容里有换行、中文也不乱；missing 跳过', () => {
    const a = Buffer.from('他推开门。\n\n雨下了三天。\n', 'utf8');
    const b = Buffer.from('第二版\n', 'utf8');
    const buf = Buffer.concat([
      Buffer.from(`${B1} blob ${a.length}\n`),
      a,
      Buffer.from('\n'),
      Buffer.from(`${C1} missing\n`),
      Buffer.from(`${B2} blob ${b.length}\n`),
      b,
      Buffer.from('\n'),
    ]);
    const out = g.parseCatFileBatch(buf);
    assert.equal(out.size, 2);
    assert.equal(out.get(B1).toString('utf8'), '他推开门。\n\n雨下了三天。\n');
    assert.equal(out.get(B2).toString('utf8'), '第二版\n');
  });

  test('截断了就停，前面读到的照给', () => {
    const a = Buffer.from('完整的一份', 'utf8');
    const buf = Buffer.concat([Buffer.from(`${B1} blob ${a.length}\n`), a, Buffer.from('\n'), Buffer.from(`${B2} blob 999\n半截`)]);
    const out = g.parseCatFileBatch(buf);
    assert.deepEqual([...out.keys()], [B1]);
  });
});

describe('parseGitVersionId', () => {
  test('git:<提交>:<blob> 才认', () => {
    assert.deepEqual(g.parseGitVersionId(`git:${C1}:${B1}`), { commit: C1, blob: B1 });
  });

  test('短号、少一段、多一段、别的前缀、像参数的都不认', () => {
    for (const id of [`git:${C1.slice(0, 7)}:${B1}`, `git:${C1}`, `git:${C1}:${B1}:x`, `cp:${C1}:${B1}`, `git:--output=x:${B1}`, '2026-10-18_14-32-05+0800.txt']) {
      assert.equal(g.parseGitVersionId(id), undefined, id);
    }
  });
});
