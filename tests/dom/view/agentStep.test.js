/**
 * 外部 agent 一步的记录画在对话页那一行上（`media/src/view/agentStep.ts`）：
 *
 * 1. **不展开也看得见**——摘要行上「改 N 份 · 撤销」；撤销过就是「已撤销」，没有按钮。
 * 2. **展开查得到**——改了哪几份（新建 / 改 / 删）、替作者答了什么。
 * 3. **撤销点两下才发**——第一下换字，第二下发 `undoAgentStep`（带 turnId、callId 与编辑器里没保存的那几份）；
 *    点在摘要行里也不开合折叠块。
 * 4. **收到新的 toolResult 就地重画**——撤销之后那一行变成「已撤销」。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, toolSeg, emptySession } = require('../../helpers/dom');

const CHANGES = {
  files: [
    { path: 'chapters/003-雪夜.txt', status: 'modified', before: '2026-11-24_10-00-00+0800.txt', after: 'abc', wordsBefore: 100, wordsAfter: 3000 },
    { path: '.novelwarden/characters/林昭.md', status: 'created', after: 'def', wordsAfter: 40 },
  ],
};
const ANSWERS = [{ kind: 'call', question: '有 1 章要写，需要调用 2 次模型', detail: '第 3 章', answer: '开始' }];

describe('外部 agent 一步的记录', { skip: JSDOM_SKIP }, () => {
  let ui;
  const row = () => ui.bubble('a1').querySelector('.tool-row[data-call="c1"]');

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('a1', 'assistant', '', {
            mcp: true,
            segments: [
              toolSeg({
                callId: 'c1',
                name: 'pipeline',
                title: '批量写章',
                ok: true,
                summary: '1 次调用',
                elapsedMs: 3000,
                changes: CHANGES,
                answers: ANSWERS,
              }),
              toolSeg({ callId: 'c2', name: 'read', title: 'read a.md', ok: true, summary: '3 行', elapsedMs: 10 }),
            ],
          }),
        ],
      }),
    });
  });

  test('摘要行上写着改了几份，带一颗撤销', () => {
    const chip = row().querySelector('summary .step-chip');
    assert.ok(chip, row().innerHTML);
    assert.ok(chip.textContent.includes('改 2 份'), chip.textContent);
    assert.ok(chip.querySelector('.step-undo'));
  });

  test('没改东西的那一行没有这个标', () => {
    const plain = ui.bubble('a1').querySelector('.tool-row[data-call="c2"]');
    assert.equal(plain.querySelector('.step-chip'), null);
  });

  test('展开查得到改了哪几份、替作者答了什么', () => {
    const files = [...row().querySelectorAll('.step-file')].map((li) => li.querySelector('.step-verb').textContent + ' ' + li.querySelector('.step-path').textContent);
    assert.deepEqual(files, ['改 chapters/003-雪夜.txt', '建 .novelwarden/characters/林昭.md']);
    const answers = row().querySelector('.step-answers').textContent;
    assert.ok(answers.includes('需要调用 2 次模型 → 开始'), answers);
  });

  test('撤销点两下才发；点它不开合折叠块', () => {
    const btn = row().querySelector('.step-undo');
    const wasOpen = row().open;
    ui.clickEl(btn);
    assert.equal(ui.last('undoAgentStep'), undefined);
    assert.equal(btn.textContent, '确定撤销？');
    assert.equal(row().open, wasOpen);
    ui.clickEl(btn);
    // 消息对象来自 jsdom 那一边：按 JSON 比，不比原型。
    assert.deepEqual(JSON.parse(JSON.stringify(ui.last('undoAgentStep'))), { type: 'undoAgentStep', turnId: 'a1', callId: 'c1', dirty: [] });
  });

  test('收到撤销过的 toolResult：那一行变成「已撤销」，按钮没了', () => {
    ui.post({
      type: 'toolResult',
      turnId: 'a1',
      callId: 'c1',
      name: 'pipeline',
      ok: true,
      summary: '1 次调用',
      elapsedMs: 3000,
      changes: CHANGES,
      answers: ANSWERS,
      undone: { at: '2026-11-24T10:00:00Z', summary: '已放回 1 份，搬进回收站 1 份' },
    });
    const chip = row().querySelector('.step-chip');
    assert.ok(chip.textContent.includes('已撤销'), chip.textContent);
    assert.equal(chip.querySelector('.step-undo'), null);
  });
});
