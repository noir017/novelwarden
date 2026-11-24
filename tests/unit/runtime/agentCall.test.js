/**
 * 外部 agent 的一次调用里，问题由宿主当场替作者答掉（`host.ts` 的 `answeringHost`、`controller/gate.ts` 的 `askGate`），
 * 答了什么记在 `runtime/agentCall.ts` 那一次上。作用域之外照旧问真宿主。
 *
 * | 问法 | 答什么 |
 * |---|---|
 * | confirm / confirmCall | 第一颗按钮；调模型那一问用打开时的缺省模型与详细度 |
 * | reviewReplace / mergeTexts | 采纳新版；宿主没有这个能力就也没有 |
 * | input | 过得了校验的缺省值；没有就取消 |
 * | pick | 只有一项就挑它；好几项取消 |
 * | 对话页卡片（askGate） | 确认，不推卡片 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let bundle;
let h;

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    agentCall: './src/core/runtime/agentCall.ts',
    gate: './src/core/controller/gate.ts',
  });
  h = makeFakeHost({ settings: () => ({}) });
  bundle.host.initHost(h.host);
});

/** 在一次 agent 调用里跑 `fn`，返回它的结果与记下的代答。 */
async function inCall(fn) {
  const call = bundle.agentCall.newAgentCall();
  const value = await bundle.agentCall.withAgentCall(call, fn);
  return { value, answers: call.answers };
}

describe('作用域之外：照旧问真宿主', () => {
  test('confirm 落到宿主的队列上', async () => {
    h.expect('导入');
    const r = await bundle.host.getHost().confirm('导入吗？', ['导入']);
    assert.equal(r, '导入');
    assert.equal(h.confirms.at(-1).message, '导入吗？');
  });
});

describe('作用域之内：替作者答', () => {
  test('confirm：第一颗按钮，记一笔，不碰真宿主', async () => {
    const before = h.confirms.length;
    const { value, answers } = await inCall(() =>
      bundle.host.getHost().confirm('合并「甲」/「乙」？', ['保留「甲」', '保留「乙」'], { detail: '证据' })
    );
    assert.equal(value, '保留「甲」');
    assert.equal(h.confirms.length, before);
    assert.deepEqual(answers, [{ kind: 'confirm', question: '合并「甲」/「乙」？', detail: '证据', answer: '保留「甲」' }]);
  });

  test('confirmCall：第一颗按钮 + 打开时的缺省模型与详细度', async () => {
    const { value, answers } = await inCall(() =>
      bundle.host.getHost().confirmCall('有 3 章还没排细纲，需要调用 3 次模型', ['开始'], {
        detail: '第 1–3 章',
        call: { models: [], model: 'p/m', tiers: [], contextDetail: 'brief' },
      })
    );
    assert.deepEqual(value, { action: '开始', choice: { model: 'p/m', contextDetail: 'brief' } });
    assert.equal(answers[0].kind, 'call');
    assert.ok(answers[0].question.includes('3 次'));
  });

  test('confirmCall：缺省「按分档」就不钉模型', async () => {
    const { value } = await inCall(() =>
      bundle.host.getHost().confirmCall('调 1 次', ['开始'], { call: { models: [], model: '', tiers: [] } })
    );
    assert.deepEqual(value, { action: '开始', choice: {} });
  });

  test('input：过得了校验的缺省值；没有缺省就取消', async () => {
    const { value: total } = await inCall(() =>
      bundle.host.getHost().input({ title: '全书计划写多少章？', value: '120', validate: (v) => (Number(v) > 0 ? undefined : '不对') })
    );
    assert.equal(total, '120');
    const { value: none, answers } = await inCall(() => bundle.host.getHost().input({ title: '角色姓名' }));
    assert.equal(none, undefined);
    assert.ok(answers[0].answer.startsWith('取消'), answers[0].answer);
    const { value: bad } = await inCall(() =>
      bundle.host.getHost().input({ title: 'x', value: '0', validate: (v) => (Number(v) > 0 ? undefined : '不对') })
    );
    assert.equal(bad, undefined);
  });

  test('pick：只有一项就挑它，好几项不替作者挑', async () => {
    const one = await inCall(() => bundle.host.getHost().pick([{ label: 'a.txt', value: 'a.txt' }], '挑一本'));
    assert.equal(one.value, 'a.txt');
    const two = await inCall(() =>
      bundle.host.getHost().pick(
        [
          { label: 'a.txt', value: 'a.txt' },
          { label: 'b.txt', value: 'b.txt' },
        ],
        '挑一本'
      )
    );
    assert.equal(two.value, undefined);
  });

  test('reviewReplace / mergeTexts：采纳新版（真宿主会怎么答都不问它）', async () => {
    const full = makeFakeHost({ settings: () => ({}), overrides: { mergeTexts: async () => 'discard' } });
    full.setReviewVerdict('discard');
    bundle.host.initHost(full.host);
    let value;
    let answers;
    try {
      ({ value, answers } = await inCall(async () => [
        await bundle.host.getHost().reviewReplace('第 3 章', '旧', '新', 'chapters/003.md', { merge: true }),
        await bundle.host.getHost().mergeTexts('删修饰', '删之前', '删之后'),
      ]));
    } finally {
      bundle.host.initHost(h.host);
    }
    assert.equal(full.reviewed.length, 0);
    assert.deepEqual(value, ['apply', 'apply']);
    assert.deepEqual(
      answers.map((a) => [a.kind, a.answer]),
      [
        ['review', '采纳'],
        ['merge', '用新版'],
      ]
    );
  });

  test('宿主没有的能力，替答的那一个也没有', async () => {
    const bare = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined, mergeTexts: undefined } });
    bundle.host.initHost(bare.host);
    try {
      const { value } = await inCall(async () => [bundle.host.getHost().reviewReplace, bundle.host.getHost().mergeTexts]);
      assert.deepEqual(value, [undefined, undefined]);
    } finally {
      bundle.host.initHost(h.host);
    }
  });

  test('别的方法原样转给真宿主', async () => {
    await inCall(async () => bundle.host.getHost().toast('写好了'));
    assert.ok(h.toasts.at(-1).includes('写好了'), JSON.stringify(h.toasts));
  });
});

describe('对话页卡片（askGate）', () => {
  const controller = () => {
    const posted = [];
    return { posted, gates: new Map(), post: (m) => posted.push(m) };
  };
  const ASK = { turnId: 't1', callId: 'c1', name: 'artifact', title: 'Agent 要把生成的产物写入到「第 1 章」', detail: '细纲 · 7/7 节' };

  test('作用域之内：答「确认」，不推卡片', async () => {
    const c = controller();
    const { value, answers } = await inCall(() => bundle.gate.askGate(c, ASK, new AbortController().signal));
    assert.equal(value, 'proceed');
    assert.deepEqual(c.posted, []);
    assert.deepEqual(answers, [{ kind: 'gate', question: ASK.title, detail: ASK.detail, answer: '确认' }]);
  });

  test('有红色警示时记的是那一句', async () => {
    const c = controller();
    const { answers } = await inCall(() => bundle.gate.askGate(c, { ...ASK, danger: '开头与上一章结尾大段重合' }));
    assert.equal(answers[0].detail, '开头与上一章结尾大段重合');
  });

  test('作用域之外：照旧推卡片等作者', async () => {
    const c = controller();
    const pending = bundle.gate.askGate(c, ASK);
    assert.equal(c.posted[0].type, 'gate');
    bundle.gate.resolveGate(c, c.posted[0].requestId, 'skip');
    assert.equal(await pending, 'skip');
  });
});
