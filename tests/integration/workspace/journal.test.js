/**
 * 外部 agent 一步的改动账（`workspace/journal.ts`）与撤销（`features/agentUndo.ts`）：真临时工程。
 *
 * 守的是「按文件记、记得准、退得回」：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 账外的写 | 不在 `withJournal` 里（作者自己的保存）什么都不记——同时在跑也不串 |
 * | 改 / 建 / 删 / 搬 | 状态对、改之前那一版存进历史版本（带备注）、指纹与字数对；回收站那一头不记 |
 * | 前后一样、建了又删 | 不算改动 |
 * | 不是创作产物 | 工程根下随手记的笔记也存一版（`anyKind`），撤销得了 |
 * | 两个进度 | 推之前与之后都记；撤销只在之后没再推过时放回 |
 * | 撤销 | 改的放回、建的进回收站、删的建回来；之后又改过 / 编辑器里没保存 / 旧版没存下的跳过并说为什么；撤销本身也存一版 |
 * | 结了账 | 之后再碰不记 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
const dirs = [];

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    history: './src/core/workspace/history.ts',
    journal: './src/core/workspace/journal.ts',
    undo: './src/core/features/agentUndo.ts',
    fsUtil: './src/core/model/fs.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
});

after(() => {
  for (const d of dirs) cleanup(d);
});

async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix });
  dirs.push(t.dir);
  return { t, project: t.project, ws: new bundle.ws.Workspace(t.project) };
}

/** 在一本账下跑 `fn`，结账返回。 */
async function step(project, fn, note = 'Agent：测试 之前') {
  const journal = new bundle.journal.ChangeJournal(project, note);
  await bundle.journal.withJournal(journal, fn);
  return journal.finish();
}

const CHAPTER = 'chapters/001-雪夜.md';
const CARD = '.novelwarden/characters/林昭.md';

describe('记账', () => {
  let t;
  let project;
  let ws;
  let r;
  before(async () => {
    ({ t, project, ws } = await fresh('journal'));
    t.write(CHAPTER, '# 雪夜\n\n雪下了一夜。\n');
    t.write('.novelwarden/world.md', '# 世界观\n\n北境。\n');
    t.write('笔记.md', '随手记\n');
    t.write('不动.md', '原样\n');
    project.invalidate();
    r = await step(project, async () => {
      await ws.write(CHAPTER, { text: '# 雪夜\n\n雪下了三天三夜。\n' }, { mode: 'overwrite', review: false });
      await ws.write(CARD, { text: '---\nname: 林昭\n---\n\n# 林昭\n' }, { mode: 'create' });
      await ws.remove('.novelwarden/world.md');
      await ws.write('笔记.md', { text: '改过的随手记\n' }, { mode: 'overwrite', review: false });
      // 前后一样：写了两遍，最后回到原样。
      await ws.write('不动.md', { text: '中间\n' }, { mode: 'overwrite', review: false });
      await ws.write('不动.md', { text: '原样\n' }, { mode: 'overwrite', review: false });
      // 建了又删。
      await ws.write('临时.md', { text: 'x\n' }, { mode: 'create' });
      await ws.remove('临时.md');
    });
  });

  const byPath = (p) => r.files.find((f) => f.path === p);

  test('改过的：状态、改之前那一版、指纹、字数', async () => {
    const f = byPath(CHAPTER);
    assert.equal(f.status, 'modified');
    assert.equal(await bundle.history.readSnapshot(project, CHAPTER, f.before), '# 雪夜\n\n雪下了一夜。\n');
    assert.equal(f.after, bundle.fsUtil.hash(t.read(CHAPTER)));
    assert.ok(f.wordsAfter > f.wordsBefore, JSON.stringify(f));
  });

  test('改之前那一版在「版本」侧栏里带着备注', async () => {
    const listed = await bundle.history.listSnapshots(project, CHAPTER);
    assert.equal(listed.find((v) => v.id === byPath(CHAPTER).before).note, 'Agent：测试 之前');
  });

  test('新建的：没有旧版，有指纹', () => {
    const f = byPath(CARD);
    assert.equal(f.status, 'created');
    assert.equal(f.before, undefined);
    assert.ok(f.after);
  });

  test('删掉的：记在原路径上，回收站那一头不记', () => {
    const f = byPath('.novelwarden/world.md');
    assert.equal(f.status, 'deleted');
    assert.ok(f.before);
    assert.equal(f.after, undefined);
    assert.ok(!r.files.some((x) => x.path.includes('.trash')), JSON.stringify(r.files.map((x) => x.path)));
  });

  test('不是创作产物的也存了一版', () => {
    const f = byPath('笔记.md');
    assert.equal(f.status, 'modified');
    assert.ok(f.before);
  });

  test('前后一样、建了又删的不算改动', () => {
    assert.equal(byPath('不动.md'), undefined);
    assert.equal(byPath('临时.md'), undefined);
  });

  test('结了账之后再写，不记', async () => {
    const journal = new bundle.journal.ChangeJournal(project, 'x');
    let late;
    await bundle.journal.withJournal(journal, async () => {
      late = () => ws.write('之后.md', { text: 'y\n' }, { mode: 'create' });
    });
    await journal.finish();
    await bundle.journal.withJournal(journal, () => late());
    assert.deepEqual((await journal.finish()).files, []);
  });
});

describe('账外的写不记', () => {
  test('同时在跑的另一条异步链（作者自己保存）不串进来', async () => {
    const { t, project, ws } = await fresh('journalOutside');
    t.write('a.md', 'a\n');
    t.write('b.md', 'b\n');
    project.invalidate();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const pending = step(project, async () => {
      await ws.write('a.md', { text: 'a2\n' }, { mode: 'overwrite', review: false });
      await gate;
    });
    // 账还开着的时候，账外改另一份。
    await ws.write('b.md', { text: 'b2\n' }, { mode: 'overwrite', review: false });
    release();
    const r = await pending;
    assert.deepEqual(r.files.map((f) => f.path), ['a.md']);
  });
});

describe('搬家', () => {
  test('原路径记删掉、新路径记新建', async () => {
    const { t, project, ws } = await fresh('journalMove');
    t.write('甲.md', '内容\n');
    project.invalidate();
    const r = await step(project, () => ws.move('甲.md', '乙.md'));
    assert.deepEqual(
      r.files.map((f) => [f.path, f.status]),
      [
        ['乙.md', 'created'],
        ['甲.md', 'deleted'],
      ]
    );
  });
});

describe('两个进度', () => {
  test('推了就记推之前与之后；撤销时放回', async () => {
    const { project, ws } = await fresh('journalMarks');
    const r = await step(project, async () => {
      await ws.markThreadsJudged(1);
      await ws.writeGlobalSummary('全书。', 3);
    });
    assert.deepEqual(r.marks.before, {});
    assert.deepEqual(r.marks.after, { globalSummaryThrough: 3, threadsThrough: 1 });
    const out = await bundle.undo.undoAgentStep(project, r, { busy: false, label: '测试' });
    assert.equal(out.marks, 'restored');
    const m = await project.readManifest();
    assert.equal(m.threadsThrough, undefined);
    assert.equal(m.globalSummaryThrough, undefined);
  });

  test('之后又推过：不动', async () => {
    const { project, ws } = await fresh('journalMarksMoved');
    const r = await step(project, () => ws.markThreadsJudged(1));
    await ws.markThreadsJudged(2);
    const out = await bundle.undo.undoAgentStep(project, r, { busy: false, label: '测试' });
    assert.equal(out.marks, 'moved');
    assert.equal((await project.readManifest()).threadsThrough, 2);
  });
});

describe('撤销', () => {
  let t;
  let project;
  let ws;
  let r;
  let out;
  before(async () => {
    ({ t, project, ws } = await fresh('undo'));
    t.write(CHAPTER, '# 雪夜\n\n雪下了一夜。\n');
    t.write('.novelwarden/world.md', '# 世界观\n\n北境。\n');
    t.write('改过又被改.md', '原来\n');
    t.write('编辑器开着.md', '原来\n');
    project.invalidate();
    r = await step(project, async () => {
      await ws.write(CHAPTER, { text: '# 雪夜\n\n雪下了三天三夜。\n' }, { mode: 'overwrite', review: false });
      await ws.write(CARD, { text: '---\nname: 林昭\n---\n\n# 林昭\n' }, { mode: 'create' });
      await ws.remove('.novelwarden/world.md');
      await ws.write('改过又被改.md', { text: 'agent 改的\n' }, { mode: 'overwrite', review: false });
      await ws.write('编辑器开着.md', { text: 'agent 改的\n' }, { mode: 'overwrite', review: false });
    });
    // 那一步之后，作者又改了一份。
    t.write('改过又被改.md', '作者后来改的\n');
    project.invalidate();
    out = await bundle.undo.undoAgentStep(project, r, { busy: false, dirty: ['编辑器开着.md'], label: '测试' });
  });

  test('改过的放回改之前那一版', () => {
    assert.equal(t.read(CHAPTER), '# 雪夜\n\n雪下了一夜。\n');
    assert.ok(out.restored.includes(CHAPTER));
  });

  test('新建的搬进回收站', () => {
    assert.equal(t.has(CARD), false);
    assert.ok(out.trashed.includes(CARD));
    assert.ok(fs.existsSync(t.rel('.novelwarden/.trash', CARD)));
  });

  test('删掉的建回来', () => {
    assert.equal(t.read('.novelwarden/world.md'), '# 世界观\n\n北境。\n');
  });

  test('之后又被改过的不盖', () => {
    assert.equal(t.read('改过又被改.md'), '作者后来改的\n');
    assert.ok(out.skipped.some((s) => s.path === '改过又被改.md' && s.reason === 'changed'), JSON.stringify(out.skipped));
  });

  test('编辑器里有没保存的修改的跳过', () => {
    assert.equal(t.read('编辑器开着.md'), 'agent 改的\n');
    assert.ok(out.skipped.some((s) => s.path === '编辑器开着.md' && s.reason === 'dirty'), JSON.stringify(out.skipped));
  });

  test('agent 写的那一版也存了一版，撤销本身退得回来', async () => {
    const listed = await bundle.history.listSnapshots(project, CHAPTER);
    const undone = listed.find((v) => v.note === '撤销「测试」之前');
    assert.ok(undone, JSON.stringify(listed));
    assert.equal(await bundle.history.readSnapshot(project, CHAPTER, undone.id), '# 雪夜\n\n雪下了三天三夜。\n');
  });

  test('汇总那一句说清放回几份、跳过几份', () => {
    const text = bundle.undo.describeUndo(out);
    assert.ok(text.includes('已放回 2 份，搬进回收站 1 份'), text);
    assert.ok(text.includes('跳过 2 份'), text);
  });

  test('有任务在跑：什么都不动', async () => {
    const again = await bundle.undo.undoAgentStep(project, r, { busy: true, label: '测试' });
    assert.ok(again.refused);
    assert.equal(again.restored.length, 0);
  });

  test('改之前那一版没存下的：跳过并说为什么', async () => {
    const out2 = await bundle.undo.undoAgentStep(
      project,
      { files: [{ path: '改过又被改.md', status: 'modified', unsaved: '超过 2 MB', after: bundle.fsUtil.hash(t.read('改过又被改.md')) }] },
      { busy: false, label: '测试' }
    );
    assert.deepEqual(out2.skipped, [{ path: '改过又被改.md', reason: 'unsaved', detail: '超过 2 MB' }]);
  });
});
