/**
 * 元数据目录改名后的兼容（0.2.x → 0.3）：旧工程必须还能打开。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只有 `.novelforge/` 的工程 `isInitialized()` 为真 | 作者升级后打开旧书不能当成「还不是工程」 |
 * | `needsMigration()` 为真，且打开时不在旁边建 `.novelwarden/` | 已有旧目录时不得出现第二份元数据 |
 * | `migrateLegacyDir()` 之后旧目录整个 rename 成 `.novelwarden/` | 迁移只在作者确认后发生，内容一个字节不丢 |
 * | 只有 `.novel/` 的 0.1.x 工程也能走到 `.novelwarden/` | 两代旧目录都要认 |
 * | 新旧目录都在时认新的、不再提示迁移 | 迁移过的工程不该被反复打扰 |
 *
 * 全部在临时目录里跑，不碰真实家目录与真实工程。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
const roots = [];

/** 造一个旧格式工程：`dir` 是 `.novelforge` 或 `.novel`。 */
function legacyProject(dir) {
  const t = makeTempDir('migration');
  roots.push(t.dir);
  const meta = path.join(t.dir, dir);
  fs.mkdirSync(path.join(meta, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(meta, 'project.json'), JSON.stringify({ version: 1, title: '旧工程', chapters: [] }));
  fs.writeFileSync(path.join(meta, 'style.md'), '# 文风指南\n\n旧的内容。\n');
  fs.writeFileSync(path.join(meta, 'summaries', '001.md'), '细纲内容');
  return t;
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
});

after(() => {
  for (const root of roots) cleanup(root);
});

describe('0.2.x 的 .novelforge/', () => {
  let t;
  let project;
  let initializedBefore;
  let needsBefore;
  let novelDirBefore;
  let chaptersBefore;
  let parallelDirCreated;
  let legacyGone;
  let initializedAfter;
  let needsAfter;

  before(async () => {
    t = legacyProject('.novelforge');
    fs.mkdirSync(path.join(t.dir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'chapters', '001-测试.md'), '# 测试\n\n旧工程里的正文。\n');
    project = bundle.project.NovelProject.open(t.dir);

    initializedBefore = await project.isInitialized();
    needsBefore = await project.needsMigration();
    novelDirBefore = path.basename(project.novelDir);
    chaptersBefore = (await project.listChapters()).length;
    // 打开本身不能顺手建一份新目录——作者还没确认迁移。
    parallelDirCreated = fs.existsSync(path.join(t.dir, '.novelwarden'));

    await project.migrateLegacyDir();
    legacyGone = !fs.existsSync(path.join(t.dir, '.novelforge'));
    initializedAfter = await project.isInitialized();
    needsAfter = await project.needsMigration();
  });

  test('旧工程能被打开：isInitialized 为真', () => {
    assert.equal(initializedBefore, true);
  });

  test('读写落在旧目录 .novelforge/ 里，章节能读出来', () => {
    assert.equal(novelDirBefore, '.novelforge');
    assert.equal(chaptersBefore, 1);
  });

  test('提示需要迁移', () => {
    assert.equal(needsBefore, true);
  });

  test('打开时不并排新建 .novelwarden/', () => {
    assert.equal(parallelDirCreated, false);
  });

  test('迁移后旧目录已 rename 走', () => {
    assert.equal(legacyGone, true);
  });

  test('manifest 与内容原样搬进 .novelwarden/', () => {
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'project.json')));
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'summaries', '001.md')));
    assert.ok(fs.readFileSync(path.join(t.dir, '.novelwarden', 'style.md'), 'utf8').includes('旧的内容'));
  });

  test('迁移后 isInitialized 仍为真、不再提示迁移', () => {
    assert.equal(initializedAfter, true);
    assert.equal(needsAfter, false);
  });
});

describe('0.1.x 的 .novel/', () => {
  let t;
  let project;
  let initializedBefore;
  let needsBefore;
  let steps;
  let legacyGone;
  let needsAfter;

  before(async () => {
    t = legacyProject('.novel');
    project = bundle.project.NovelProject.open(t.dir);

    initializedBefore = await project.isInitialized();
    needsBefore = await project.needsMigration();

    // 两代旧目录都要认：实现可以一步 rename 到 .novelwarden/，也可以先 .novel → .novelforge
    // 再 .novelforge → .novelwarden；循环到状态机说不需要迁移为止，最多三步。
    steps = 0;
    while ((await project.needsMigration()) && steps < 3) {
      await project.migrateLegacyDir();
      steps++;
    }
    legacyGone = !fs.existsSync(path.join(t.dir, '.novel')) && !fs.existsSync(path.join(t.dir, '.novelforge'));
    needsAfter = await project.needsMigration();
  });

  test('0.1.x 旧工程也能被打开', () => {
    assert.equal(initializedBefore, true);
  });

  test('提示需要迁移', () => {
    assert.equal(needsBefore, true);
  });

  test('迁移到 .novelwarden/ 后旧目录都不在了', () => {
    assert.ok(fs.existsSync(path.join(t.dir, '.novelwarden', 'project.json')));
    assert.equal(legacyGone, true);
  });

  test('迁移后不再提示迁移', () => {
    assert.equal(needsAfter, false);
  });
});

describe('新旧目录并存', () => {
  let t;
  let project;
  let needsMigration;
  let novelDir;

  before(async () => {
    t = legacyProject('.novelforge');
    fs.mkdirSync(path.join(t.dir, '.novelwarden'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, '.novelwarden', 'project.json'), JSON.stringify({ version: 1, title: '新工程', chapters: [] }));
    project = bundle.project.NovelProject.open(t.dir);
    needsMigration = await project.needsMigration();
    novelDir = project.novelDir;
  });

  test('认新的 .novelwarden/', () => {
    assert.equal(path.basename(novelDir), '.novelwarden');
  });

  test('已有新目录时不再提示迁移', () => {
    assert.equal(needsMigration, false);
  });
});

describe('空目录', () => {
  test('还不是工程，也不顺手建元数据目录', async () => {
    const t = makeTempDir('migration-empty');
    roots.push(t.dir);
    const project = bundle.project.NovelProject.open(t.dir);
    assert.equal(await project.isInitialized(), false);
    assert.equal(await project.needsMigration(), false);
    assert.equal(fs.existsSync(path.join(t.dir, '.novelwarden')), false);
  });
});
