/**
 * MCP 执行端（`controller/mcp.ts`）：**外部 agent 的一次调用落到一个真的工程上。**
 *
 * 协议那一层在 `tests/unit/mcp/server.test.js`；这里绕过协议直接调 `createMcpBackend`，
 * 守的是第 19 / 25 条在 MCP 这条路上还成立（不等人点，每一步记账、撤销得了）：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 查询（read / list） | 不占生成位、不进对话页 |
 * | 查技能（skills list） | 带 action 的工具按动作报闸门：查询类同样不进对话页；绑技能不问、撤销得了 |
 * | generate | 气泡标 MCP、正文流进工具条、**不推卡片直接落盘**（落盘那一问替作者答了、记下来）；改之前那一版存进历史；**返回里没有正文** |
 * | 撤销这一步 | 按改动账放回改之前那一版；记在那一行上；再点只说撤销过了；有任务在跑不撤 |
 * | 连着两次调用 | 接在同一个气泡里；作者说过话就另起一个 |
 * | 生成位被占 | 当场回 isError，不排队 |
 * | edit | 不问；之后又被改过的，撤销跳过不盖 |
 * | 参数不对 | 当场回 isError：不问、不占生成位、不进对话页 |
 * | 正文 writeMode=continue | 落盘那一问写追加，落盘接在已有正文后面 |
 * | 简报 | 与状态机同一句「下一步」 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject, makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const fs = require('fs');

const PLOT_JSON = JSON.stringify({
  梗概: '进入宗门',
  出场人物: '林昭',
  关键事件: '踩点、失手、翻墙；收在藏书阁门口。三拍推进。',
  看点: '第三块令牌',
});

const P1 = '.novelwarden/summaries/001-夜入青云.md';
const P2 = '.novelwarden/summaries/002-藏书阁.md';

let bundle;
let home;
let h;
let t;
let project;
let controller;
let backend;
let posted = [];
let gates = [];
/** 卡片来了怎么答：返回 proceed / skip。 */
let onGate = async () => 'proceed';
let replyFn = () => PLOT_JSON;

const signal = () => new AbortController().signal;
const call = (name, args) => backend.call(name, args, signal());

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    plotFile: './src/core/model/plotFile.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
    history: './src/core/workspace/history.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  // 「我的技能库」指到临时目录：skills list 会列出它，不能读到跑测试那台机器上装过的技能。
  home = makeTempDir('mcpSkillsHome');
  bundle.skills.setUserSkillsDir(home.rel('skills'));
  installFakeProvider(bundle.registry, {
    reply: () => replyFn(),
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'mcp', title: '青云剑录' });
  project = t.project;
  const ws = new bundle.ws.Workspace(project);
  for (const [no, title] of [[1, '夜入青云'], [2, '藏书阁']]) {
    await ws.writePlot({
      no, title, upstreamHash: '', done: false,
      sections: { ...bundle.plotFile.emptyPlotSections(), 梗概: `第 ${no} 章要达成的事` },
    });
  }
  await project.syncManifest();

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        gates.push(m);
        void (async () => {
          const verdict = await onGate(m);
          if (verdict) {
            await controller.handle({ type: 'gateResult', requestId: m.requestId, verdict });
          }
        })();
      }
    },
    reveal() {},
  });
  backend = bundle.controller.createMcpBackend(controller);
});

after(() => {
  bundle?.skills.setUserSkillsDir(undefined);
  if (home) fs.rmSync(home.dir, { recursive: true, force: true });
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

function reset() {
  posted = [];
  gates = [];
}

const mcpTurns = () => controller.current.turns.filter((x) => x.mcp);
const toasts = () => posted.filter((m) => m.type === 'toast');

describe('查询', () => {
  let r;
  before(async () => {
    reset();
    r = await call('read', { path: P1 });
  });

  test('读得到', () => {
    assert.equal(r.isError, false);
    assert.ok(r.text.includes('第 1 章要达成的事'), r.text);
  });

  test('不进对话页、不占生成位', () => {
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone'].includes(m.type)), []);
    assert.equal(mcpTurns().length, 0);
  });
});

describe('generate：不等人点，直接落盘', () => {
  let r;
  let before1;
  before(async () => {
    reset();
    before1 = t.read(P1);
    onGate = async () => assert.fail('外部 agent 这条路上不该推卡片');
    r = await call('generate', { target: P1, capability: 'generate' });
  });

  test('气泡标 MCP，挂一条工具条', () => {
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    const seg = turns[0].segments;
    assert.equal(seg.length, 1);
    assert.equal(seg[0].kind, 'tool');
    assert.equal(seg[0].call.name, 'generate');
  });

  test('正文流进那一条工具条下的卡片', () => {
    const deltas = posted.filter((m) => m.type === 'toolDelta').map((m) => m.text).join('');
    assert.ok(deltas.includes('进入宗门'), deltas);
    assert.ok(mcpTurns()[0].segments[0].call.output.includes('进入宗门'));
  });

  test('没有推卡片，落盘那一问替作者答了、记在那一行上', () => {
    assert.equal(gates.length, 0);
    const answers = mcpTurns()[0].segments[0].call.answers;
    assert.ok(answers.some((a) => a.kind === 'gate' && a.question.startsWith('Agent 要')), JSON.stringify(answers));
  });

  test('已经落盘', async () => {
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['梗概'], '进入宗门');
  });

  test('改动账：这一份改了，改之前那一版存进了历史版本（带备注）', async () => {
    const changes = mcpTurns()[0].segments[0].call.changes;
    const f = changes.files.find((x) => x.path === P1);
    assert.equal(f.status, 'modified');
    assert.ok(f.before, JSON.stringify(f));
    assert.equal(await bundle.history.readSnapshot(project, P1, f.before), before1);
    const listed = await bundle.history.listSnapshots(project, P1);
    assert.ok(listed.find((v) => v.id === f.before).note.startsWith('Agent：'), JSON.stringify(listed));
  });

  test('返回里没有正文，只有形状、结论与改动清单', () => {
    assert.equal(r.isError, false);
    assert.ok(!r.text.includes('踩点、失手'), r.text);
    assert.ok(r.text.includes('draftId'), r.text);
    assert.ok(r.text.includes('不要再写一遍'), r.text);
    assert.ok(r.text.includes(`修改 ${P1}`), r.text);
    assert.ok(r.text.includes('撤销'), r.text);
  });

  test('工具条上记着落盘结论，推给前端的那一行带着改动账', () => {
    assert.ok(mcpTurns()[0].segments[0].call.summary.includes('已写入'), mcpTurns()[0].segments[0].call.summary);
    const result = posted.filter((m) => m.type === 'toolResult').at(-1);
    assert.equal(result.changes.files[0].path, P1);
  });

  test('收尾放开生成位', () => {
    assert.equal(controller.busy, false);
    const busy = posted.filter((m) => m.type === 'busy').map((m) => m.value);
    assert.deepEqual(busy, [true, false]);
  });
});

describe('撤销这一步', () => {
  let row;
  let turn;
  before(async () => {
    reset();
    turn = mcpTurns()[0];
    row = turn.segments[0].call;
    await controller.handle({ type: 'undoAgentStep', turnId: turn.id, callId: row.callId });
  });

  test('放回改之前那一版', async () => {
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['梗概'], '第 1 章要达成的事');
  });

  test('那一行记下撤销过了，推给前端', () => {
    assert.ok(row.undone && row.undone.summary.includes('已放回 1 份'), JSON.stringify(row.undone));
    const result = posted.filter((m) => m.type === 'toolResult').at(-1);
    assert.equal(result.callId, row.callId);
    assert.ok(result.undone);
  });

  test('agent 写的那一版也存了一版（撤销本身也退得回来）', async () => {
    const listed = await bundle.history.listSnapshots(project, P1);
    assert.ok(listed.some((v) => (v.note ?? '').startsWith('撤销「')), JSON.stringify(listed));
  });

  test('再点一次：只说撤销过了，不动磁盘', async () => {
    const text = t.read(P1);
    reset();
    await controller.handle({ type: 'undoAgentStep', turnId: turn.id, callId: row.callId });
    assert.equal(t.read(P1), text);
    assert.ok(toasts().some((x) => x.message.includes('已经撤销过')), JSON.stringify(toasts()));
  });
});

describe('连着几次调用', () => {
  test('接在上一次的同一个气泡里', async () => {
    reset();
    await call('generate', { target: P2, capability: 'generate' });
    const turns = mcpTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].segments.length, 2);
  });

  test('作者说了话之后另起一个气泡', async () => {
    controller.current.turns.push({ id: 'u-x', role: 'user', content: '先停一下', at: new Date().toISOString() });
    await call('generate', { target: P2, capability: 'generate', writeMode: 'rewrite' });
    assert.equal(mcpTurns().length, 2);
    assert.equal(controller.current.turns.at(-1).mcp, true);
  });
});

describe('生成位被占', () => {
  test('当场回 isError，不排队', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('generate', { target: P1, capability: 'generate' });
      assert.equal(r.isError, true);
      assert.ok(r.text.includes('另一个生成任务'), r.text);
    } finally {
      lease.release();
    }
  });

  test('有任务在跑时不撤销', async () => {
    const turn = mcpTurns()[0];
    const row = turn.segments[1].call;
    const text = t.read(P2);
    const lease = controller.beginGeneration();
    reset();
    try {
      await controller.handle({ type: 'undoAgentStep', turnId: turn.id, callId: row.callId });
    } finally {
      lease.release();
    }
    assert.equal(t.read(P2), text);
    assert.equal(row.undone, undefined);
    assert.ok(toasts().some((x) => x.level === 'error' && x.message.includes('有任务在跑')), JSON.stringify(toasts()));
  });
});

describe('edit：不等人点，改完撤销得了', () => {
  let r;
  let row;
  before(async () => {
    reset();
    onGate = async () => assert.fail('不该问作者');
    r = await call('edit', { path: P1, old: '第 1 章要达成的事', new: '离开宗门' });
    const turn = mcpTurns().at(-1);
    row = turn.segments.at(-1).call;
  });

  test('改了，没推卡片', async () => {
    assert.equal(r.isError, false, r.text);
    assert.equal(gates.length, 0);
    const plot = await project.readPlot(P1);
    assert.equal(plot.sections['梗概'], '离开宗门');
  });

  test('之后又被改过：撤销跳过它，不拿旧版去盖', async () => {
    const changed = t.read(P1).replace('离开宗门', '作者自己改的');
    t.write(P1, changed);
    project.invalidate();
    await controller.handle({ type: 'undoAgentStep', turnId: mcpTurns().at(-1).id, callId: row.callId });
    assert.equal(t.read(P1), changed);
    assert.ok(row.undone.summary.includes('跳过 1 份'), row.undone.summary);
  });
});

// 参数本来就不对的调用：不该先在对话页弹一张「改「」里的一段文字」，再等作者答完才报错。
describe('参数不对：当场回话，不问、不占生成位', () => {
  const cases = [
    ['edit 什么都没给', 'edit', {}, 'path 是必填的'],
    ['edit 缺 new', 'edit', { path: P1, old: '进入宗门' }, 'new 是必填的'],
    ['skills bind 缺 stage', 'skills', { action: 'bind', id: 'builtin:plain-prose' }, 'bind 需要参数：stage'],
    ['pipeline 认不出的动作', 'pipeline', { action: 'explode' }, '认不出动作「explode」'],
    ['generate 类型不对', 'generate', { target: P1, capability: 'generate', targetWords: '三千' }, 'targetWords 应该是整数'],
  ];
  for (const [label, name, args, want] of cases) {
    test(label, async () => {
      reset();
      onGate = async () => assert.fail('不该问作者');
      const r = await call(name, args);
      assert.equal(r.isError, true);
      assert.ok(r.text.includes(want), r.text);
      assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    });
  }

  test('生成位被占时照样先说参数不对', async () => {
    const lease = controller.beginGeneration();
    try {
      const r = await call('edit', {});
      assert.ok(r.text.includes('path 是必填的'), r.text);
    } finally {
      lease.release();
    }
  });
});

describe('generate 正文接着写：落盘追加在已有正文后面', () => {
  const CH = 'chapters/001-夜入青云.md';
  let r;
  before(async () => {
    reset();
    t.write(CH, '# 夜入青云\n\n雨下了三天。\n');
    project.invalidate();
    replyFn = () => '林昭翻过了墙。';
    onGate = async () => 'proceed';
    r = await call('generate', { target: CH, capability: 'generate', writeMode: 'continue', targetWords: 10 });
  });

  test('落盘那一问写的是追加（替作者答了）', () => {
    const row = mcpTurns().at(-1).segments.at(-1).call;
    const gate = row.answers.find((x) => x.kind === 'gate');
    assert.ok(gate.question.includes('追加'), gate.question);
  });

  test('原有的正文还在，新写的接在后面', async () => {
    const text = t.read(CH);
    assert.ok(text.indexOf('雨下了三天') >= 0 && text.indexOf('林昭翻过了墙') > text.indexOf('雨下了三天'), text);
    assert.equal(r.isError, false, r.text);
  });
});

// 动作工具的闸门按动作报：同一个 skills，list 是查询，bind 动手（不问，撤销得了）。
describe('skills：按动作分闸门', () => {
  test('list 是查询：照样列得出，不进对话页、不占生成位', async () => {
    reset();
    const turnsBefore = mcpTurns().length;
    const r = await call('skills', { action: 'list' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes('builtin:plain-prose'), r.text);
    assert.deepEqual(posted.filter((m) => ['toolCall', 'busy', 'turnDone', 'gate'].includes(m.type)), []);
    assert.equal(mcpTurns().length, turnsBefore);
  });

  // 绑定改的是这个工程往后每一次生成的提示词：不问，skills.json 记成这一步新建的，撤销就搬进回收站。
  test('bind 不问，直接写 skills.json；撤销把它搬进回收站', async () => {
    reset();
    onGate = async () => assert.fail('不该问作者');
    const r = await call('skills', { action: 'bind', id: 'builtin:plain-prose', stage: 'drafting' });
    assert.equal(gates.length, 0);
    assert.equal(r.isError, false, r.text);
    assert.equal(t.has('.novelwarden/skills.json'), true);
    const turn = mcpTurns().at(-1);
    const row = turn.segments.at(-1).call;
    assert.deepEqual(row.changes.files.map((f) => [f.path, f.status]), [['.novelwarden/skills.json', 'created']]);
    await controller.handle({ type: 'undoAgentStep', turnId: turn.id, callId: row.callId });
    assert.equal(t.has('.novelwarden/skills.json'), false);
    assert.ok(row.undone.summary.includes('搬进回收站 1 份'), row.undone.summary);
  });
});

// 工程动作背后的 feature 自己弹的确认框：外部 agent 这条路上替作者答掉（第一颗按钮），答了什么记下来，改动撤销得了。
describe('工程动作：功能层的确认框替作者答', () => {
  const CARD = '.novelwarden/characters/林昭.md';
  const RAW = '---\nname: 林昭\naliases: [她, 阿昭]\n---\n\n# 林昭\n\n## 身份\n主角。\n';
  let r;
  let row;
  let turn;
  before(async () => {
    reset();
    t.write(CARD, RAW);
    project.invalidate();
    h.answers.length = 0;
    r = await call('characters', { action: 'cleanAliases' });
    turn = mcpTurns().at(-1);
    row = turn.segments.at(-1).call;
  });

  test('没问真宿主，也没推卡片', () => {
    assert.equal(gates.length, 0);
    assert.ok(!h.confirms.some((c) => c.message.includes('不该当别名')), JSON.stringify(h.confirms.map((c) => c.message)));
  });

  test('照第一颗按钮做了：别名清掉了「她」', () => {
    assert.equal(r.isError, false, r.text);
    assert.ok(!t.read(CARD).includes('她,'), t.read(CARD));
    assert.ok(t.read(CARD).includes('阿昭'), t.read(CARD));
  });

  test('那一问记在那一行上，也回给了 agent', () => {
    const a = row.answers.find((x) => x.kind === 'confirm');
    assert.ok(a.question.includes('不该当别名'), a.question);
    assert.equal(a.answer, '清理');
    assert.ok(r.text.includes('途中的确认已按缺省作答'), r.text);
  });

  test('撤销：卡片回到原样', async () => {
    assert.deepEqual(row.changes.files.map((f) => [f.path, f.status]), [[CARD, 'modified']]);
    await controller.handle({ type: 'undoAgentStep', turnId: turn.id, callId: row.callId });
    assert.equal(t.read(CARD), RAW);
  });
});

describe('简报', () => {
  test('说得出这本书走到哪、下一步是什么', async () => {
    const brief = await backend.brief();
    assert.ok(brief.startsWith('# 当前工程'), brief);
    assert.ok(brief.includes('《青云剑录》'), brief);
    assert.ok(brief.includes('下一步'), brief);
  });
});
