/**
 * 节奏体检的取数（2026-11-27，设计稿 docs/design/plans/2026-11-27-rhythm-and-foreshadow.md「一期」），真临时工程：工程页「叙事线」页签的
 * `watch.rhythm`、叙事线总览的「看点」那一行、写前检查（`threadReminders` / `preflightChapter`）都从磁盘上的细纲现算，同一个口径。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 工程页 | 问题段挂在 `threads.watch.rhythm`；同步过的章按正文、没同步的按计划（`planned`） |
 * | 总览 | 每章一格的字与悬停的看点；`rhythm` 与工程页同一份 |
 * | 写前检查 | 问题段碰到要写的章才报，说法另起一句「节奏提醒」 |
 * | 外部 agent | `stateBrief` 多一行，写明交给作者判断、不要自己重排 |
 * | 不写盘 | 读完之后工程目录一个字节没变 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title, highlights, extra = '') =>
  `---\nno: ${no}\ntitle: ${title}\n${extra}---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 关键事件\n- 事件\n\n## 看点\n${highlights
    .map((h) => `- ${h}`)
    .join('\n')}\n\n## 状态变更\n林昭受了伤\n`;

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (!/\.(db|sqlite)(-\w+)?$/.test(ent.name)) {
        out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    threads: './src/core/views/threads.ts',
    projectView: './src/core/views/projectView.ts',
    preflight: './src/core/features/preflight.ts',
    pipeline: './src/core/model/pipeline.ts',
    stateBrief: './src/core/views/stateBrief.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'rhythm', title: '青云剑录' });
  project = t.project;

  // 第 1–2 章写了也同步了，第 3–5 章只有细纲：五章都只有钩子。第 6 章打脸。第 7 章的看点没写类型（老写法）。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelwarden/summaries/001-楔子.md', plot(1, '楔子', ['钩子：门外有人喊他的真名'], 'sourceHash: abc\n'));
  t.write('chapters/002-入镇.md', '# 入镇\n\n他走进镇子。');
  t.write('.novelwarden/summaries/002-入镇.md', plot(2, '入镇', ['钩子：客栈掌柜认得他的剑'], 'sourceHash: def\n'));
  t.write('.novelwarden/summaries/003-夜访.md', plot(3, '夜访', ['钩子：信上只写了一个日期']));
  t.write('.novelwarden/summaries/004-北行.md', plot(4, '北行', ['钩子：船上多了一个人']));
  t.write('.novelwarden/summaries/005-渡口.md', plot(5, '渡口', ['钩子：渡口的灯全灭了']));
  t.write('.novelwarden/summaries/006-擂台.md', plot(6, '擂台', ['打脸：林昭一剑挑落赵家少爷的冠', '钩子：台下有人吹了声口哨']));
  t.write('.novelwarden/summaries/007-归途.md', plot(7, '归途', ['主角回到镇上']));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

const DRY = { kind: 'dry', from: 1, to: 5, planned: true };

describe('views/threads · 节奏体检的取数', () => {
  test('工程页：问题段挂在 threads.watch.rhythm；第 1–2 章同步过、第 3–5 章是计划，注 planned', async () => {
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.deepEqual(tree.threads.watch.rhythm, [DRY]);
  });

  test('总览：每章一格的字与悬停的看点；没写类型的那一章只有看点、没有字；rhythm 与工程页同一份', async () => {
    const o = await bundle.threads.buildThreadsOverview(project);
    const at = (no) => o.chapters.find((c) => c.no === no);
    assert.deepEqual(
      o.chapters.map((c) => [c.no, c.highlight]),
      [
        [1, '钩'],
        [2, '钩'],
        [3, '钩'],
        [4, '钩'],
        [5, '钩'],
        [6, '打'],
        [7, undefined],
      ]
    );
    assert.equal(at(6).highlights, '打脸：林昭一剑挑落赵家少爷的冠\n钩子：台下有人吹了声口哨');
    assert.equal(at(7).highlights, '主角回到镇上');
    assert.deepEqual(o.rhythm, [DRY]);
  });

  test('写前检查：问题段碰到要写的章才报，说法另起一句「节奏提醒」', async () => {
    const five = await bundle.threads.threadReminders(project, [5]);
    assert.deepEqual(five.reminders, [{ kind: 'rhythm', issue: DRY }]);
    assert.deepEqual((await bundle.threads.threadReminders(project, [6])).reminders, []);
    const pre = await bundle.preflight.preflightChapter(project, 4);
    assert.equal(
      bundle.preflight.describeThreadNotes('本章', pre.threads, pre.threadsThrough, 4),
      '节奏提醒：第 1–5 章只有钩子，没有兑现（含计划）。只是提醒，照写不拦。'
    );
  });

  test('外部 agent：stateBrief 多一行节奏提醒，写明交给作者判断', async () => {
    const brief = await bundle.stateBrief.buildStateBrief(project);
    assert.ok(brief.includes('节奏提醒（交给作者判断，不要为它自己重排细纲）：第 1–5 章只有钩子，没有兑现（含计划）'), brief);
  });

  test('不写盘：读完之后工程目录一个字节没变', async () => {
    const before = snapshot(t.dir);
    await bundle.projectView.buildProjectTree(project);
    await bundle.threads.buildThreadsOverview(project);
    await bundle.threads.threadReminders(project, [3, 4, 5]);
    assert.deepEqual(snapshot(t.dir), before);
  });
});
