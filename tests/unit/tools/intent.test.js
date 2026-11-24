/**
 * 每个工具自报的**意图**：这一步是什么性质、在工具条上怎么称呼。
 *
 * 按 `gate` 档位决定怎么跑的是 MCP 执行端（`controller/mcp.ts`）：`auto` 直接跑，`mutating` 占生成位、记账、
 * 撤销得了——外部 agent 这条路不等人点（AGENTS 第 19 / 25 条），所以只剩这两档。**说辞与它描述的那件事在同一个
 * 文件里**——改了 `write` 的行为，眼皮底下就是工具条上要对作者说的话。
 *
 * 这里不给 project（纯单测），名字退回路径本身。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const tools = loadModule('src/core/tools/novel/index.ts');

const byName = (name) => tools.NOVEL_TOOLS.find((t) => t.name === name);
const intentOf = (name, args) => byName(name).intent(args);

const PLOT = '.novelwarden/summaries/012-入宗.md';

describe('读三件套：不问', () => {
  for (const name of ['list', 'read', 'search']) {
    test(`${name} 没有 intent，也不标 mutating / costly`, () => {
      const tool = byName(name);
      // 注册表据此兜一个 auto——读工具不花钱不改东西，问一句只是让人麻木。
      assert.equal(tool.intent, undefined);
      assert.equal(!!tool.mutating, false);
      assert.equal(!!tool.costly, false);
    });
  }
});

describe('generate：花钱，产出直接落盘', () => {
  const g = () => intentOf('generate', { target: PLOT, ask: '接住第 9 章那处伏笔' });

  test('归 mutating', () => {
    assert.equal(g().gate, 'mutating');
  });

  test('标了 costly 与 mutating（产出直接落盘，宿主要看得出它会写东西）', () => {
    assert.equal(byName('generate').costly, true);
    assert.equal(byName('generate').mutating, true);
  });

  // 「Agent 想调用 generate，允许吗」作者答不上来——他不知道会写到哪、花多少。
  test('说清了会花钱', () => {
    assert.ok(g().detail.includes('花钱'), g().detail);
  });

  // 产出不再等作者点写入：工具条上说清它会直接落盘、撤销得了。
  test('说清了产出直接落盘', () => {
    assert.ok(g().detail.includes('落盘'), g().detail);
  });

  test('说清了动的是哪一份', () => {
    assert.ok(g().title.includes(PLOT), g().title);
  });

  test('title 是动词短语，主语留给调用方加', () => {
    assert.ok(!g().title.startsWith('Agent'), g().title);
  });

  // 按钮上一律是「确认」（`controller/gate.ts` 的 `PROCEED_ACTION`）：动词已经在
  // title 上了，工具不必再各报一个。
  test('不再自报按钮上的字', () => {
    assert.equal(g().proceed, undefined);
  });
});

describe('write 新建 / 追加：动手的那一档', () => {
  test('新建归 mutating', () => {
    assert.equal(intentOf('write', { path: PLOT }).gate, 'mutating');
  });

  test('追加与新建同一档', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'append' }).gate, 'mutating');
  });

  test('框上写清了写到哪、是新建还是追加', () => {
    const i = intentOf('write', { path: PLOT });
    assert.ok(i.title.includes('写入'), i.title);
    assert.ok(i.detail.includes(PLOT), i.detail);
    assert.ok(i.detail.includes('新建'), i.detail);
    assert.ok(intentOf('write', { path: PLOT, mode: 'append' }).detail.includes('追加'), 'append');
  });

  test('不再自报按钮上的字', () => {
    assert.equal(intentOf('write', { path: PLOT }).proceed, undefined);
  });
});

describe('write 覆盖：与新建同一档', () => {
  test('归 mutating', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'overwrite' }).gate, 'mutating');
  });
});

describe('edit：动手的那一档', () => {
  const args = { path: PLOT, old: '林昭', new: '林昀' };

  test('归 mutating', () => {
    assert.equal(intentOf('edit', args).gate, 'mutating');
  });

  // 不写出 old → new，作者回头看工具条只知道它改过，不知道改了什么。
  test('工具条上写出了原文与改成什么', () => {
    const i = intentOf('edit', args);
    assert.ok(i.detail.includes('林昭'), i.detail);
    assert.ok(i.detail.includes('林昀'), i.detail);
  });

  test('删掉一段时说「删掉」而不是留空', () => {
    assert.ok(intentOf('edit', { ...args, new: '' }).detail.includes('删掉'));
  });

  test('all=true 时说清全文都改', () => {
    assert.ok(intentOf('edit', { ...args, all: true }).detail.includes('所有出现的地方'));
  });

  test('不再自报按钮上的字', () => {
    assert.equal(intentOf('edit', args).proceed, undefined);
  });
});

describe('带 action 的工程动作：缺省归 mutating', () => {
  const i = () => intentOf('pipeline', { action: 'batchPlots' });

  test('归 mutating', () => {
    assert.equal(i().gate, 'mutating');
  });

  // 标题就是动作的说法，作者在框里读到的是「批量拆细纲」而不是一个英文动作名。
  test('标题是那个动作的说法', () => {
    assert.ok(i().title.startsWith('批量拆细纲'), i().title);
  });

  // 这里不问（`mutating` 档），但 pipelineBatch 自己那个「预计调用 N 次」照弹。
  test('调模型的动作提醒了随后还会告诉他调几次', () => {
    assert.ok(i().detail.includes('预计调用几次'), i().detail);
  });

  test('不调模型的动作不提调用次数', () => {
    assert.equal(intentOf('pipeline', { action: 'newPlot' }).detail.includes('预计调用几次'), false);
  });

  test('作用对象（path / name）写进框里', () => {
    assert.ok(intentOf('summary', { action: 'finalize', path: PLOT }).detail.includes(PLOT));
    assert.ok(intentOf('characters', { action: 'create', name: '林昭' }).detail.includes('林昭'));
  });

  // 认不出的动作执行时会被拒，但记账的那一步不能因此跳过。
  test('认不出的动作也归 mutating，标题写着工具与动作名', () => {
    const x = intentOf('summary', { action: 'delete' });
    assert.equal(x.gate, 'mutating');
    assert.equal(x.title, '执行 summary delete');
  });

  test('技能的查与检查是查询，装与绑是动手', () => {
    assert.deepEqual(
      [
        intentOf('skills', { action: 'list' }).gate,
        intentOf('skills', { action: 'inspect', url: 'https://github.com/o/r' }).gate,
        intentOf('skills', { action: 'install', url: 'https://github.com/o/r' }).gate,
        intentOf('skills', { action: 'bind', id: 'builtin:x', stage: 'review' }).gate,
      ],
      ['auto', 'auto', 'mutating', 'mutating']
    );
  });
});

describe('长参数不整段摊进框里', () => {
  test('超长的 old 会截断', () => {
    const long = '青'.repeat(200);
    const detail = intentOf('edit', { path: PLOT, old: long, new: 'x' }).detail;
    assert.ok(detail.includes('…'), detail.slice(0, 80));
    assert.ok(detail.length < 200, String(detail.length));
  });
});
