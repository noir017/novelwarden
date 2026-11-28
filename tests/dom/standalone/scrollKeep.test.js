/**
 * 切换标签时选区与滚动各记各的（独立版内置编辑器，`media/src/editor/pane.ts` 的 `renderAll` / `stashView` / `restoreView` /
 * `placeScroll`，关掉之后的那一份在 `store.ts` 的 `rememberView` / `takeView`）。
 *
 * jsdom 没有排版：`scrollTop` 写什么读回什么，滚动事件不会自己来——这里直接写 textarea 的 `scrollTop` 当「滚到了这里」。
 * 窄屏那组用 `narrowLayout` 假排版：编辑区那层翻下去时读到 0、写不进去，翻上来时浏览器把藏起来之前的偏移还回来。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 新开一份 | 从顶上开始，不沿用上一份的滚动偏移 |
 * | 从别处再打开一份开着的（工程页、文件页、「转到…」） | 回到它自己的光标与滚动；切走的那一份的也留住，点标签回去还在 |
 * | 临时标签被换掉、再单击打开 | 回到换掉时的位置 |
 * | 关掉再打开 | 回到关掉时的位置；只放回一次（之后由开着的那一份自己记） |
 * | 选区 | 选中的一段（连同从后往前拉的方向）切走再切回来还在；点一下正显示着的标签不把选区收成光标 |
 * | 左右并排 | 两块各切各的标签，切回来两边都在原处 |
 * | 窄屏：编辑区那层翻下去时换了一份 | 新的那份从它自己的位置开始（不沿用上一份的偏移），切回上一份还在原处 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, file } = require('../../helpers/dom');

const SHIMS = ['pointerCapture', 'confirm', 'scrollIntoView', 'clipboard'];
const TEXT = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段。`).join('\n\n');
const A = 'chapters/001-楔子.md';
const B = 'chapters/002-客栈.md';
const C = 'chapters/003-夜访.md';

function harness() {
  const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: SHIMS });
  ui.window.__nfToast = () => {};
  const doc = ui.doc;
  const h = {
    ui,
    area: () => doc.getElementById('edArea'),
    open: (p, extra) => ui.post({ type: 'editorOpen', file: file(p, TEXT, { kind: 'chapter' }), ...extra }),
    tab: (p) => [...doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
    /** 滚到 `top`、光标放在 `caret`（作者在这一份里看到这儿、点在这儿）。 */
    at(top, caret) {
      h.area().setSelectionRange(caret, caret);
      h.area().scrollTop = top;
    },
    where: () => ({ top: h.area().scrollTop, caret: h.area().selectionStart }),
  };
  return h;
}

describe('切换文件：光标与滚动各记各的', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.at(300, 120);
  });

  test('新开一份：从顶上开始，不沿用上一份的偏移', () => {
    h.open(B);
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.at(900, 400);
  });

  test('从别处再打开一份开着的：回到它自己的位置', () => {
    h.open(A);
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });

  test('切走的那一份也留住了：点标签回去还在', () => {
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(h.where(), { top: 900, caret: 400 });
    h.ui.clickEl(h.tab(A));
    assert.deepEqual(h.where(), { top: 300, caret: 120 });
  });
});

describe('关掉 / 换掉之后再打开：回到原处', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
  });

  test('临时标签被换掉、再单击打开：回到换掉时的位置', () => {
    h.open(A, { preview: true });
    h.at(450, 200);
    h.open(B, { preview: true });
    assert.equal(h.tab(A), undefined, '临时标签被换掉了');
    assert.deepEqual(h.where(), { top: 0, caret: 0 });
    h.open(A, { preview: true });
    assert.deepEqual(h.where(), { top: 450, caret: 200 });
  });

  test('关掉再打开：回到关掉时的位置', () => {
    h.open(C);
    h.at(600, 300);
    h.ui.clickEl(h.tab(C).querySelector('.ed-tab-close'));
    assert.equal(h.tab(C), undefined, '关掉了');
    h.open(C);
    assert.deepEqual(h.where(), { top: 600, caret: 300 });
  });

  test('只放回一次：开着时由它自己记，换个位置再切回来是新的位置', () => {
    h.at(60, 10);
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(C));
    assert.deepEqual(h.where(), { top: 60, caret: 10 });
  });
});

/** 选区与滚动。没方向的选区各平台说法不一（Chrome 说 forward、jsdom 说 none），只比是不是从后往前拉的。 */
function view(area) {
  return { top: area.scrollTop, start: area.selectionStart, end: area.selectionEnd, backward: area.selectionDirection === 'backward' };
}

describe('选区：切走再切回来还是选中的那一段', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    h = harness();
    h.open(A);
    h.open(B);
  });

  test('从前往后选的：两头与滚动都回来', () => {
    h.ui.clickEl(h.tab(A));
    h.area().setSelectionRange(120, 180, 'forward');
    h.area().scrollTop = 300;
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(view(h.area()), { top: 0, start: 0, end: 0, backward: false });
    h.ui.clickEl(h.tab(A));
    assert.deepEqual(view(h.area()), { top: 300, start: 120, end: 180, backward: false });
  });

  test('从后往前选的：方向也回来（Shift+方向键接着从开头那头伸缩）', () => {
    h.ui.clickEl(h.tab(B));
    h.area().setSelectionRange(40, 90, 'backward');
    h.area().scrollTop = 800;
    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(view(h.area()), { top: 800, start: 40, end: 90, backward: true });
  });

  test('点一下正显示着的那个标签：选区不收成光标', () => {
    h.ui.clickEl(h.tab(B));
    assert.deepEqual(view(h.area()), { top: 800, start: 40, end: 90, backward: true });
  });

  test('关掉再打开：选区也回来', () => {
    h.ui.clickEl(h.tab(B).querySelector('.ed-tab-close'));
    h.open(B);
    assert.deepEqual(view(h.area()), { top: 800, start: 40, end: 90, backward: true });
  });
});

describe('左右并排：两块各记各的', { skip: JSDOM_SKIP }, () => {
  const PA = '.novelwarden/summaries/001-楔子.md';
  const PB = '.novelwarden/summaries/002-客栈.md';
  let h;
  let right;
  before(() => {
    h = harness();
    h.open(A);
    h.open(B);
    for (const p of [PA, PB]) {
      h.ui.post({ type: 'editorOpen', pane: 'draft', file: file(p, TEXT, { kind: 'plot' }) });
    }
    right = {
      area: () => h.ui.doc.querySelector('.wb-editor-draft textarea.ed-area'),
      tab: (p) => [...h.ui.doc.querySelectorAll('.wb-editor-draft .ed-tab')].find((t) => t.dataset.path === p),
    };
  });

  test('正文与细纲各滚各的、各选各的；两边都切走再切回来，都在原处', () => {
    assert.ok(right.area(), '细纲开在第二块');
    h.ui.clickEl(h.tab(B));
    h.area().setSelectionRange(500, 520);
    h.area().scrollTop = 1500;
    h.ui.clickEl(right.tab(PB));
    right.area().setSelectionRange(60, 75, 'backward');
    right.area().scrollTop = 420;

    h.ui.clickEl(h.tab(A));
    h.area().scrollTop = 90;
    h.ui.clickEl(right.tab(PA));
    right.area().scrollTop = 30;

    h.ui.clickEl(h.tab(B));
    h.ui.clickEl(right.tab(PB));
    assert.deepEqual(view(h.area()), { top: 1500, start: 500, end: 520, backward: false }, '左边');
    assert.deepEqual(view(right.area()), { top: 420, start: 60, end: 75, backward: true }, '右边');

    h.ui.clickEl(h.tab(A));
    h.ui.clickEl(right.tab(PA));
    assert.equal(h.area().scrollTop, 90, '左边另一份');
    assert.equal(right.area().scrollTop, 30, '右边另一份');
  });
});

describe('窄屏：编辑区那层翻下去时换了一份', { skip: JSDOM_SKIP }, () => {
  let h;
  before(() => {
    const ui = mount({ body: 'standalone', scripts: ['view.js', 'editor.js'], shims: [...SHIMS, 'narrow', 'narrowLayout'] });
    ui.window.__nfToast = () => {};
    h = {
      ui,
      area: () => ui.doc.getElementById('edArea'),
      open: (p) => ui.post({ type: 'editorOpen', file: file(p, TEXT, { kind: 'chapter' }) }),
      tab: (p) => [...ui.doc.querySelectorAll('#wbEditor .ed-tab')].find((t) => t.dataset.path === p),
      /** 编辑区那层翻上来（底栏「正文」）/ 翻下去（点侧栏的页签），浏览器随后排一次版。 */
      layer(open) {
        ui.doc.body.classList.toggle('editor-open', open);
        ui.window.__relayout();
      },
    };
  });

  test('翻下去再翻上来：位置还在（没换文件，浏览器自己还回来）', () => {
    h.open(A);
    h.ui.window.__relayout();
    h.area().setSelectionRange(200, 200);
    h.area().scrollTop = 2400;
    h.layer(false);
    assert.equal(h.area().scrollTop, 0, '藏着时读到的是 0');
    h.layer(true);
    assert.deepEqual(view(h.area()), { top: 2400, start: 200, end: 200, backward: false });
  });

  test('翻下去时从工程页开了另一份：它从自己的位置开始，不沿用上一份的偏移', () => {
    h.layer(false);
    h.open(B);
    assert.equal(h.ui.doc.body.classList.contains('editor-open'), true, '打开文件把那层翻上来');
    h.ui.window.__relayout();
    assert.deepEqual(view(h.area()), { top: 0, start: 0, end: 0, backward: false });
    h.area().scrollTop = 700;
  });

  test('切回上一份：还在它原来的位置（藏着时读到的 0 没把它冲掉）', () => {
    h.ui.clickEl(h.tab(A));
    assert.deepEqual(view(h.area()), { top: 2400, start: 200, end: 200, backward: false });
    h.ui.clickEl(h.tab(B));
    assert.equal(h.area().scrollTop, 700);
  });

  test('翻下去时点标签切回去：翻上来时放回它的位置', () => {
    h.layer(false);
    h.ui.clickEl(h.tab(A));
    h.layer(true);
    assert.deepEqual(view(h.area()), { top: 2400, start: 200, end: 200, backward: false });
  });
});
