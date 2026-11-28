/**
 * 「版本」时间线的 git 来源（`src/core/workspace/gitVersions.ts`）在真仓库里：列得出、读得回、跟得过改名，以及不该读的读不到。
 * 读 git 输出的纯函数在 tests/unit/workspace/gitVersions.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 列 | 新的在前；提交时间、作者、说明、字数与字节；只改了别的文件的提交不算；纯改名并进它之前那一次；改名之前的也列得出 |
 * | 读 | id 读回那一次提交里的全文（改名之前的也是）；没列过就读（刷新之后）也认；与正文现在的样子逐段比得出改了哪一段（对比标签的口径） |
 * | 不越界 | 仓库里别的文件的 blob、编出来的 id、短号都读不到（工程根可能只是大仓库的一个子目录） |
 * | 工程在仓库的子目录里 | 路径按工程根算，照样列得出 |
 * | 字面路径 | 文件名里的 `[` `*` 不当通配：不会把别的章的提交算进来 |
 * | 没有这一来源 | 不是 git 仓库、没提交过：空数组，不抛 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle, loadModule } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');
const { HAS_GIT, git, gitInit, gitCommitAll, blobOf } = require('../../helpers/gitRepo');

const OLD_PATH = 'chapters/001-雨夜.md';
const NEW_PATH = 'chapters/001-夜雨.md';
const V1 = '# 雨夜\n\n他推开门。\n\n雨下了三天。\n';
const V2 = '# 雨夜\n\n他推开门。\n\n雨还没有停。\n';
const V3 = '# 雨夜\n\n他推开门。\n\n雨还没有停。\n\n灯还亮着。\n';
const T0 = 1795000000;

let bundle;
let g;
const dirs = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    gitVersions: './src/core/workspace/gitVersions.ts',
    fsx: './src/core/model/fs.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  g = bundle.gitVersions;
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  return t;
}

describe('列与读：改过两次、改了一次名', { skip: !HAS_GIT && '没有 git' }, () => {
  let t;
  const commits = {};

  before(async () => {
    t = await fresh('git-versions');
    gitInit(t.dir);
    t.write(OLD_PATH, V1);
    commits.c1 = gitCommitAll(t.dir, '第一章初稿', T0);
    t.write(OLD_PATH, V2);
    commits.c2 = gitCommitAll(t.dir, '改了第二段', T0 + 60);
    t.write('chapters/002-晨.md', '# 晨\n\n天亮了。\n');
    commits.other = gitCommitAll(t.dir, '只动了第二章', T0 + 120);
    git(t.dir, ['mv', OLD_PATH, NEW_PATH]);
    commits.rename = gitCommitAll(t.dir, '改名', T0 + 180);
    t.write(NEW_PATH, V3);
    commits.c3 = gitCommitAll(t.dir, '加了一段', T0 + 240);
  });

  test('新的在前；只动了别的文件的不算；纯改名并进它之前那一次；改名之前的也在', async () => {
    const list = await g.listGitVersions(t.project, NEW_PATH);
    assert.deepEqual(
      list.map((v) => [v.subject, v.commit]),
      [
        ['加了一段', commits.c3],
        ['改了第二段', commits.c2],
        ['第一章初稿', commits.c1],
      ]
    );
  });

  test('每一版：提交时间（毫秒）、作者、字数、字节、id 带提交号与 blob', async () => {
    const [v3, v2] = await g.listGitVersions(t.project, NEW_PATH);
    assert.equal(v3.time, (T0 + 240) * 1000);
    assert.equal(v3.author, '作者');
    assert.equal(v3.words, bundle.fsx.countWords(V3));
    assert.equal(v3.bytes, Buffer.byteLength(V3));
    assert.equal(v3.id, `git:${commits.c3}:${blobOf(t.dir, commits.c3, NEW_PATH)}`);
    assert.equal(v2.id, `git:${commits.c2}:${blobOf(t.dir, commits.c2, OLD_PATH)}`);
  });

  test('读回那一次提交里的全文，改名之前的也是', async () => {
    const list = await g.listGitVersions(t.project, NEW_PATH);
    assert.deepEqual(
      await Promise.all(list.map((v) => g.readGitVersion(t.project, NEW_PATH, v.id))),
      [V3, V2, V1]
    );
  });

  test('读出来的与现在的正文逐段比：只差加的那一段（对比标签的口径）', async () => {
    const { diffLines } = loadModule('media/src/editor/versionDiffCore.ts');
    const [, v2] = await g.listGitVersions(t.project, NEW_PATH);
    const old = await g.readGitVersion(t.project, NEW_PATH, v2.id);
    const d = diffLines(old, fs.readFileSync(t.rel(NEW_PATH), 'utf8'));
    const changes = d.blocks.filter((b) => b.kind === 'change');
    assert.equal(changes.length, 1);
    const [j1, j2] = changes[0].right;
    assert.deepEqual(
      d.right.slice(j1, j2).map((l) => l.text),
      ['灯还亮着。']
    );
  });

  test('仓库里别的文件的 blob、编出来的 id、短号：都读不到', async () => {
    const foreign = `git:${commits.other}:${blobOf(t.dir, commits.other, 'chapters/002-晨.md')}`;
    await assert.rejects(g.readGitVersion(t.project, NEW_PATH, foreign), (err) => err.code === 'notFound');
    await assert.rejects(g.readGitVersion(t.project, NEW_PATH, `git:${'f'.repeat(40)}:${'e'.repeat(40)}`), (err) => err.code === 'notFound');
    await assert.rejects(g.readGitVersion(t.project, NEW_PATH, `git:${commits.c3.slice(0, 7)}:x`), (err) => err.code === 'notFound');
  });

  test('没提交过的文件：空数组', async () => {
    t.write('chapters/003-新.md', '# 新\n');
    assert.deepEqual(await g.listGitVersions(t.project, 'chapters/003-新.md'), []);
  });
});

describe('工程在仓库的子目录里；文件名里有通配符', { skip: !HAS_GIT && '没有 git' }, () => {
  let repo;
  let project;
  const BOOK = 'books/青云';

  before(async () => {
    repo = makeTempDir('git-versions-sub');
    dirs.push(repo.dir);
    gitInit(repo.dir);
    fs.mkdirSync(repo.rel(BOOK), { recursive: true });
    project = bundle.project.NovelProject.open(repo.rel(BOOK));
    const { Workspace } = loadModule('src/core/workspace/index.ts');
    await new Workspace(project).initializeProject({ title: '青云', author: '测试' });
    repo.write(`${BOOK}/chapters/001-[外传].md`, '# 外传\n\n一。\n');
    repo.write(`${BOOK}/chapters/001-x.md`, '# x\n\n不该算进来。\n');
    gitCommitAll(repo.dir, '两章', T0);
    repo.write(`${BOOK}/chapters/001-x.md`, '# x\n\n又改了。\n');
    gitCommitAll(repo.dir, '只改 x', T0 + 60);
  });

  test('先读后列（刷新之后对比标签直接要全文）：核对时自己列一次', async () => {
    const head = git(repo.dir, ['rev-parse', 'HEAD~1']).trim();
    const id = `git:${head}:${blobOf(repo.dir, head, `${BOOK}/chapters/001-[外传].md`)}`;
    assert.equal(await g.readGitVersion(project, 'chapters/001-[外传].md', id), '# 外传\n\n一。\n');
  });

  test('路径按工程根算：照样列得出、读得回', async () => {
    const list = await g.listGitVersions(project, 'chapters/001-[外传].md');
    assert.equal(list.length, 1);
    assert.equal(list[0].subject, '两章');
    assert.equal(await g.readGitVersion(project, 'chapters/001-[外传].md', list[0].id), '# 外传\n\n一。\n');
  });

  test('「[外传]」按字面认：「只改 x」那次提交不算进来', async () => {
    const list = await g.listGitVersions(project, 'chapters/001-[外传].md');
    assert.ok(!list.some((v) => v.subject === '只改 x'));
  });
});

describe('没有这一来源', () => {
  test('不是 git 仓库：空数组，不抛', async () => {
    const t = await fresh('git-versions-none');
    t.write(OLD_PATH, V1);
    assert.deepEqual(await g.listGitVersions(t.project, OLD_PATH), []);
    await assert.rejects(g.readGitVersion(t.project, OLD_PATH, `git:${'1'.repeat(40)}:${'2'.repeat(40)}`), (err) => err.code === 'notFound');
  });

  test('越界的路径：空数组', async () => {
    const t = await fresh('git-versions-out');
    assert.deepEqual(await g.listGitVersions(t.project, '../外面.md'), []);
    assert.ok(path.isAbsolute(t.dir));
  });
});
