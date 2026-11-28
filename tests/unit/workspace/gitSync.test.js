/**
 * Git 自动同步纯函数单测（`src/core/workspace/gitSync.ts`）：
 * porcelain 路径解析、提交说明构造、常见错误分类。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

let g;

before(() => {
  const bundle = loadBundle({
    gitSync: './src/core/workspace/gitSync.ts',
  });
  g = bundle.gitSync;
});

describe('parsePorcelainPaths', () => {
  test('保留首行前导空格并解析修改/新增/删除/重命名/中文与带空格路径', () => {
    const out = [
      ' M chapters/001-雪夜.txt',
      '?? chapters/002-雨夜.txt',
      'D  chapters/003-旧章.txt',
      'R  chapters/004-旧名.txt -> chapters/004-新名.txt',
      ' M "chapters/005 带空格.txt"',
      '',
    ].join('\n');
    assert.deepEqual(g.parsePorcelainPaths(out), [
      'chapters/001-雪夜.txt',
      'chapters/002-雨夜.txt',
      'chapters/003-旧章.txt',
      'chapters/004-新名.txt',
      'chapters/005 带空格.txt',
    ]);
  });

  test('空输出返回空数组', () => {
    assert.deepEqual(g.parsePorcelainPaths(''), []);
    assert.deepEqual(g.parsePorcelainPaths('\n'), []);
  });
});

describe('buildCommitMessage', () => {
  test('1-3 个文件直接列在标题里且不带 AI 署名', () => {
    const m1 = g.buildCommitMessage(['chapters/001-雪夜.txt'], 'save');
    assert.equal(m1, '自动同步：更新 chapters/001-雪夜.txt');
    assert.ok(!/Co-Authored-By/i.test(m1));

    const m2 = g.buildCommitMessage(['chapters/001-雪夜.txt', '.novelwarden/summaries/001-雪夜.md'], 'finalize');
    assert.equal(m2, '自动同步（同步章节）：更新 chapters/001-雪夜.txt、.novelwarden/summaries/001-雪夜.md');
  });

  test('超过 3 个文件时标题摘要 + 正文逐条列出全部变更文件', () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
    const msg = g.buildCommitMessage(files, 'save');
    assert.ok(msg.startsWith('自动同步：更新 a.txt、b.txt、c.txt 等 5 个文件\n\n变更文件：\n'));
    for (const f of files) {
      assert.ok(msg.includes(`- ${f}`));
    }
  });
});

describe('classifyGitError', () => {
  test('识别冲突、网络、认证、未配身份、推送被拒', () => {
    assert.equal(g.classifyGitError('CONFLICT (content): Merge conflict in chapters/001.txt', 'pull').phase, 'conflict');
    assert.equal(g.classifyGitError('fatal: Could not resolve host: example.com', 'push').label, '推送失败');
    assert.match(g.classifyGitError('fatal: Could not resolve host: example.com', 'push').detail, /网络/);
    assert.match(g.classifyGitError('Permission denied (publickey).', 'push').detail, /认证/);
    assert.match(g.classifyGitError('Author identity unknown\n*** Please tell me who you are.', 'commit').detail, /用户名或邮箱/);
    assert.equal(g.classifyGitError('! [rejected] main -> main (non-fast-forward)', 'push').label, '推送被拒');
  });
});
