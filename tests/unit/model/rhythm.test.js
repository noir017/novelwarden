/**
 * 节奏体检（2026-11-27，设计稿 docs/design/plans/2026-11-27-rhythm-and-foreshadow.md「一期」）：认看点的类型，逐章找节奏问题。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 类型只认行首「类型：」「【类型】」两种写法，别名接住常见说法；没分隔的不认 | 「收获三枚灵石」分不清是不是类型 |
 * | 一章没认出类型、章号断开都切断连续 | 老书、手写的细纲不误报 |
 * | 四种问题：没兑现 5 章、同类连用 3 章、没钩子 2 章、状态变更是「无」 | 作者定的阈值 |
 * | 一段里有计划章的注「含计划」 | 同步过的按正文，没同步的按计划 |
 * | 提示词两处用同一句类型规矩 | 排细纲与同步写出来的样子一致 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const r = loadModule('src/core/model/rhythm.ts');

/** 一章：看点一条一行，状态变更缺省「实力提升」。 */
const ch = (no, highlights, opts = {}) => ({
  no,
  highlights: highlights.map((h) => `- ${h}`).join('\n'),
  stateChange: opts.stateChange ?? '实力提升',
  filled: opts.filled ?? true,
  planned: opts.planned ?? false,
});

describe('rhythm.ts · 认看点的类型', () => {
  test('行首「类型：」「类型:」「【类型】」「[类型]」都认；别名归到八种之一', () => {
    assert.equal(r.highlightTypeOf('打脸：林昭当众折断赵家少爷的剑'), '打脸');
    assert.equal(r.highlightTypeOf('钩子:门外有人喊他的真名'), '钩子');
    assert.equal(r.highlightTypeOf('【揭秘】玉佩是沈家旧物'), '揭秘');
    assert.equal(r.highlightTypeOf('[收获] 三枚灵石'), '收获');
    assert.equal(r.highlightTypeOf('高光对决：擂台上一剑破阵'), '对决');
    assert.equal(r.highlightTypeOf('悬念：信上只写了一个日期'), '钩子');
    assert.equal(r.highlightTypeOf('掉马：师父就是剑宗宗主'), '揭秘');
  });

  test('没分隔、冒号前不是类型、空行都不认', () => {
    assert.equal(r.highlightTypeOf('收获三枚灵石'), undefined);
    assert.equal(r.highlightTypeOf('林昭当众打脸：赵家少爷'), undefined);
    assert.equal(r.highlightTypeOf('爽点：主角赢了'), undefined);
    assert.equal(r.highlightTypeOf(''), undefined);
  });

  test('一节里的类型按出现顺序、去重；认不出的行不算', () => {
    assert.deepEqual(r.highlightTypesOf('- 打脸：甲\n- 钩子：乙\n- 打脸：丙\n- 随手一句'), ['打脸', '钩子']);
    assert.deepEqual(r.highlightTypesOf('无'), []);
  });

  test('总览一格的字：第一种兑现的头一个字，只有钩子写「钩」，没有类型给空串', () => {
    assert.equal(r.highlightGlyph(['钩子', '逆袭']), '逆');
    assert.equal(r.highlightGlyph(['钩子']), '钩');
    assert.equal(r.highlightGlyph([]), '');
  });

  test('类型规矩那一句列出八种，排细纲与同步两份提示词都用它', () => {
    for (const type of r.HIGHLIGHT_TYPES) {
      assert.ok(r.HIGHLIGHT_TYPE_RULE.includes(type), type);
    }
    const prompts = loadModule('src/core/context/prompts.ts');
    const summarize = loadModule('src/core/features/summarizePrompt.ts');
    assert.ok(prompts.blueprintFormat().includes(r.HIGHLIGHT_TYPE_RULE));
    assert.ok(summarize.SUMMARY_SYSTEM.includes(r.HIGHLIGHT_TYPE_RULE));
  });
});

describe('rhythm.ts · 节奏问题', () => {
  test('连续 5 章只有钩子：报一段；4 章不报', () => {
    const five = [1, 2, 3, 4, 5].map((n) => ch(n, ['钩子：甲']));
    assert.deepEqual(r.rhythmIssues(five), [{ kind: 'dry', from: 1, to: 5, planned: false }]);
    assert.deepEqual(r.rhythmIssues(five.slice(0, 4)), []);
  });

  test('同一种兑现连着 3 章：报那一种；中间换了一章就断', () => {
    const chapters = [
      ch(1, ['打脸：甲', '钩子：乙']),
      ch(2, ['打脸：甲', '收获：丙', '钩子：乙']),
      ch(3, ['打脸：甲', '钩子：乙']),
      ch(4, ['收获：丙', '钩子：乙']),
      ch(5, ['打脸：甲', '钩子：乙']),
    ];
    assert.deepEqual(r.rhythmIssues(chapters), [{ kind: 'repeat', from: 1, to: 3, type: '打脸', planned: false }]);
  });

  test('连续 2 章没有钩子：报一段', () => {
    const chapters = [ch(1, ['打脸：甲', '钩子：乙']), ch(2, ['逆袭：甲']), ch(3, ['揭秘：甲']), ch(4, ['情感：甲', '钩子：乙'])];
    assert.deepEqual(r.rhythmIssues(chapters), [{ kind: 'noHook', from: 2, to: 3, planned: false }]);
  });

  test('状态变更是「无」：只报排过的细纲；没写、写了别的不报', () => {
    const chapters = [
      ch(1, ['打脸：甲', '钩子：乙'], { stateChange: '无' }),
      ch(2, ['打脸：甲', '钩子：乙'], { stateChange: '没有变化。' }),
      ch(3, ['收获：甲', '钩子：乙'], { stateChange: '' }),
      ch(4, ['收获：甲', '钩子：乙'], { stateChange: '无', filled: false }),
    ];
    assert.deepEqual(r.rhythmIssues(chapters), [
      { kind: 'static', from: 1, to: 1, planned: false },
      { kind: 'static', from: 2, to: 2, planned: false },
    ]);
  });

  test('切断连续：一章没认出类型、章号断开；乱序、重复章号也不崩', () => {
    const untyped = [1, 2, 3, 4, 5, 6].map((n) => (n === 3 ? ch(n, ['随手一句']) : ch(n, ['钩子：甲'])));
    assert.deepEqual(r.rhythmIssues(untyped), []);
    const gap = [1, 2, 3, 5, 6, 7].map((n) => ch(n, ['钩子：甲']));
    assert.deepEqual(r.rhythmIssues(gap), []);
    const shuffled = [5, 3, 1, 4, 2, 2].map((n) => ch(n, ['钩子：甲']));
    assert.deepEqual(r.rhythmIssues(shuffled), [{ kind: 'dry', from: 1, to: 5, planned: false }]);
  });

  test('老书：看点一条都没写类型，一处都不报', () => {
    const old = [1, 2, 3, 4, 5, 6, 7].map((n) => ch(n, ['主角当众折断对方的剑', '门外有人喊他的真名']));
    assert.deepEqual(r.rhythmIssues(old), []);
  });

  test('一段里有计划章的注 planned；说法后面写「含计划」', () => {
    const chapters = [1, 2, 3, 4, 5].map((n) => ch(n, ['钩子：甲'], { planned: n >= 4 }));
    const [issue] = r.rhythmIssues(chapters);
    assert.equal(issue.planned, true);
    assert.equal(r.describeRhythmIssue(issue), '第 1–5 章只有钩子，没有兑现（含计划）');
  });

  test('说法：四种各一句', () => {
    assert.equal(r.describeRhythmIssue({ kind: 'repeat', from: 20, to: 22, type: '打脸', planned: false }), '第 20–22 章连着 3 章都是打脸');
    assert.equal(r.describeRhythmIssue({ kind: 'noHook', from: 8, to: 9, planned: false }), '第 8–9 章章末都没有钩子');
    assert.equal(r.describeRhythmIssue({ kind: 'static', from: 30, to: 30, planned: false }), '第 30 章状态变更是「无」，这一章什么都没变');
  });

  test('按起始章排；交集判断按首尾', () => {
    const chapters = [
      ...[1, 2, 3, 4, 5].map((n) => ch(n, ['钩子：甲'])),
      ch(6, ['打脸：甲']),
      ch(7, ['打脸：甲'], { stateChange: '无' }),
    ];
    const issues = r.rhythmIssues(chapters);
    assert.deepEqual(
      issues.map((i) => [i.kind, i.from, i.to]),
      [
        ['dry', 1, 5],
        ['noHook', 6, 7],
        ['static', 7, 7],
      ]
    );
    assert.equal(r.rhythmTouches(issues[0], 5, 9), true);
    assert.equal(r.rhythmTouches(issues[0], 6, 9), false);
  });
});
