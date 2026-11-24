/**
 * MCP 的执行端：**外部 agent 的一次工具调用，落到当前打开的这个工程上。**
 *
 * 协议在 [mcp/server.ts](../mcp/server.ts)，它只认 {@link McpBackend}。这里把那两个方法绑到
 * 一个 `ChatController` 上。每次调用各自做完，没有循环：
 *
 * | 调用的性质（工具自报的 `gate`） | 这里做什么 |
 * |---|---|
 * | `auto`（list / read / search、查技能） | 直接跑，只进日志。不占生成位、不进对话页 |
 * | `mutating`（generate / write / edit / 工程动作……） | 占生成位、走 `runTask`（看得见、能停），在对话页挂一条工具条；**不等人点**，每一步记账、可撤销 |
 *
 * ## 不等人点，靠撤销兜底（第 19 / 25 条）
 *
 * 外部 agent 的操作从前要作者在对话页上一步步点头（`edit` 先问一句、`generate` 的产物等作者点写入、功能层的确认框照弹），
 * agent 一停就是半天。现在一次写盘调用跑在两个作用域里：
 *
 * - **替作者作答**（`runtime/agentCall.ts`）：功能层的确认框、调模型之前那一问、覆盖审阅、落盘卡片当场答掉，答了什么记下来；
 * - **改动账**（`workspace/journal.ts`）：网关动每一份文件之前先存一版历史（备注「Agent：<这一步> 之前」），结束时算出改了、
 *   建了、删了哪几份。
 *
 * 两样都记在对话页那一行工具条上（随会话落盘），也简短地回给 agent。作者在那一行上点「撤销这一步」
 * （{@link undoAgentStepFor}）就按文件放回改之前那一版；之后又被改过的不盖。宿主（Claude Code 之类）自己那一层
 * 「让不让调这个工具」的权限照旧是宿主的事。
 *
 * ## 对话页上的样子
 *
 * 外部 agent 的调用挂在当前会话里一个标着 MCP 的气泡上，连着几次调用接在同一个气泡里，
 * 作者在中间说了话就另起一个。正文照旧流进那一条工具条下的卡片（`toolDelta`），**不回给
 * 外部 agent**：它拿到的只有形状与 draftId（`tools/novel/generate.ts`）。
 */
import type { ChatController } from './index';
import type { McpBackend, McpCallResult } from '../mcp/server';
import { createNovelTools } from '../tools/novel';
import type { ToolRun } from '../tools/types';
import { buildStateBrief } from '../views/stateBrief';
import { activeTasks, runTask } from '../runtime/progress';
import { describeError, scoped } from '../runtime/logger';
import { AgentCall, newAgentCall, withAgentCall } from '../runtime/agentCall';
import { AgentAnswer, AgentStepChanges, FileChange, hasChanges, normalizeAgentStep } from '../model/agentStep';
import { ChatTurn, TurnToolCall, makeTurnId, nowIso } from '../model/session';
import { ChangeJournal, withJournal } from '../workspace/journal';
import { describeUndo, undoAgentStep } from '../features/agentUndo';
import { askArtifact, describeArtifactOf, pushPipeline } from './chat';
import { persist } from './persist';
import { serializeSession, serializeTurn } from './serialize';

const log = scoped('MCP');

/** 参数那一段的上限。路径与查询词都短，几百字够看，一大段内嵌文本没必要全留。 */
const ARGS_LIMIT = 800;
/** 返回那一段的上限。工具按契约本就回短文本，这道闸只防写坏了的那一个。 */
const RESULT_LIMIT = 2000;
/**
 * `generate` 产出的正文上限。这是**产物本身**（一章三千字、一份大纲六千字），截短了那张卡
 * 就没意义了；仍然要有个头：它随会话落盘。
 */
const OUTPUT_LIMIT = 20000;
/** 替作者答掉的那一问随会话落盘：问题与说明各留多长（说明里可能列着几十章）。 */
const QUESTION_LIMIT = 300;
const ANSWER_DETAIL_LIMIT = 600;
/** 回给 agent 的那份清单：改动、代答各列几条（其余说「另有 N 份」）。它每走一步都重烧一遍上下文。 */
const AGENT_LIST_LIMIT = 8;

/** 把这个工程端给 MCP。**每次调用现取**当前会话：作者可能在中途换了会话。 */
export function createMcpBackend(c: ChatController): McpBackend {
  return {
    brief: () => buildStateBrief(c.project, c.current.target),
    call: (name, args, signal) => callTool(c, name, args, signal),
  };
}

async function callTool(
  c: ChatController,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpCallResult> {
  const session = c.current;
  const tools = createNovelTools({
    project: c.project,
    workspace: c.workspace,
    drafts: c.drafts,
    sessionId: session.id,
  });
  const intent = tools.intent(name, args);

  // 查询：不花钱不改东西，挂上对话页只会把作者要看的那几条淹掉。认不出的名字也走这条——
  // 注册表会回一句「没有叫 X 的工具，可用的是…」。
  if (!intent || intent.gate === 'auto') {
    const r = await tools.invoke(name, args, quietRun(signal));
    return { text: r.text, isError: !r.ok };
  }

  // 参数本来就不对的调用当场回话：不占锁、不挂气泡。
  const issue = tools.check(name, args);
  if (issue) {
    return { text: issue, isError: true };
  }

  // 与对话页的单步创作共用同一把锁：两条路同时跑会让草稿与流式内容互相盖。
  const lease = c.beginGeneration();
  if (!lease) {
    return {
      text: 'Novelwarden 的对话页里正在跑另一个生成任务。等它结束再试，或者请作者先停掉它。',
      isError: true,
    };
  }
  const relay = () => lease.abort();
  if (signal.aborted) {
    relay();
  } else {
    signal.addEventListener('abort', relay, { once: true });
  }
  c.post({ type: 'busy', value: true });

  const turn = openTurn(c);
  const row: TurnToolCall = {
    callId: makeTurnId(),
    name,
    title: intent.title,
    ok: false,
    summary: '进行中…',
    elapsedMs: 0,
    argsText: describeArgs(args),
  };
  turn.segments = [...(turn.segments ?? []), { kind: 'tool', call: row }];
  c.post({
    type: 'toolCall',
    turnId: turn.id,
    callId: row.callId,
    name,
    title: row.title,
    detail: intent.detail,
    argsText: row.argsText,
  });

  const call = newAgentCall();
  const journal = new ChangeJournal(c.project, `Agent：${intent.title} 之前`);
  /** 结账（只结一次）：改动与代答记到那一行上，回一段给 agent 的清单。出错的那条路上也结——改了一半的也要退得回去。 */
  let ledger: string | undefined;
  const settle = async (): Promise<string> => {
    if (ledger === undefined) {
      const step: AgentStepChanges = { ...(await journal.finish()), ...(call.external.length > 0 ? { external: call.external } : {}) };
      recordStep(row, step, call);
      ledger = describeStepForAgent(step, call.answers);
      if (hasChanges(step)) {
        log.info(`Agent「${intent.title}」改了 ${step.files.length} 份文件`, step.files.map((f) => `${f.status} ${f.path}`).join('｜'));
      }
    }
    return ledger;
  };

  try {
    return await runTask(
      'MCP',
      async (task) => {
        // 进度条上的「停止」与对话页的「停止」是同一件事。
        if (task.signal.aborted) {
          relay();
        } else {
          task.signal.addEventListener('abort', relay, { once: true });
        }
        task.report({ message: intent.title });

        const { r, note } = await withAgentCall(call, () =>
          withJournal(journal, async () => {
            const r = await tools.invoke(name, args, {
              signal: lease.signal,
              report: (message) => c.toast(message),
              onDelta: (delta) => {
                row.output = (row.output ?? '') + delta;
                c.post({ type: 'toolDelta', turnId: turn.id, callId: row.callId, text: delta });
              },
              usage: { record: (calls) => log.info(`${name} 调了 ${calls} 次模型`) },
            });
            // 产出了东西就直接落盘（第 19 条：外部 agent 这条路上不等人点，靠撤销兜底）。结论要回给外部 agent：不说的话它
            // 不知道那份产物落没落盘，下一步多半是再生成一遍。
            const note = r.draftIds.length > 0 ? await adopt(c, turn.id, row, r.draftIds, lease.signal) : undefined;
            return { r, note };
          })
        );
        settleRow(row, {
          ok: r.ok,
          summary: [r.error ?? r.display?.detail ?? firstLine(r.text), note?.summary].filter(Boolean).join(' · '),
          elapsedMs: r.elapsedMs,
          text: r.text,
        });
        const text = [r.text, note?.text, await settle()].filter(Boolean).join('\n\n');
        return { text, isError: !r.ok };
      },
      { scope: 'MCP' }
    );
  } catch (err) {
    const message = describeError(err);
    log.warn(`MCP 调用 ${name} 失败`, message);
    settleRow(row, { ok: false, summary: message, elapsedMs: 0, text: message });
    return { text: [`执行失败：${message}`, await settle()].filter(Boolean).join('\n\n'), isError: true };
  } finally {
    signal.removeEventListener('abort', relay);
    await settle().catch((err) => log.warn('结 Agent 这一步的改动账失败', describeError(err)));
    if (row.output) {
      row.output = clip(row.output, OUTPUT_LIMIT);
    }
    postRow(c, turn.id, row);
    lease.release();
    c.post({ type: 'busy', value: false });
    c.post({ type: 'turnDone', turn: serializeTurn(turn) });
    await persist(c);
    // write / edit / 工程动作会真的改磁盘，流水线必须刷。
    await pushPipeline(c);
    c.post({ type: 'session', session: serializeSession(c.current) });
  }
}

/**
 * 撤销外部 agent 的一步（对话页那一行上的「撤销这一步」）：照那一行记的改动账逐份放回改之前那一版
 * （`features/agentUndo.ts`）。找不到那一行、撤销过了、没有改动都只说一句；有任务在跑不撤。
 */
export async function undoAgentStepFor(
  c: ChatController,
  msg: { turnId: string; callId: string; dirty?: string[] }
): Promise<void> {
  const turn = c.current.turns.find((t) => t.id === msg.turnId);
  const row = turn?.segments?.find((s) => s.kind === 'tool' && s.call.callId === msg.callId);
  const call = row?.kind === 'tool' ? row.call : undefined;
  if (!turn || !call) {
    c.toast('找不到这一步了（会话换过或被改过）。', 'error');
    return;
  }
  if (call.undone) {
    c.toast(`这一步已经撤销过了：${call.undone.summary}`);
    return;
  }
  const step = normalizeAgentStep(call.changes);
  if (!hasChanges(step)) {
    c.toast('这一步没有改动任何东西，没什么可撤销的。');
    return;
  }
  // 撤销的时候占着生成位：不让外部 agent 的下一步与它同时写。
  const lease = c.beginGeneration();
  const busy = !lease || activeTasks(c.project.root).length > 0;
  try {
    const outcome = await undoAgentStep(c.project, step, {
      busy,
      dirty: Array.isArray(msg.dirty) ? msg.dirty.filter((p): p is string => typeof p === 'string') : [],
      label: call.title,
    });
    const summary = describeUndo(outcome);
    if (outcome.refused) {
      c.toast(summary, 'error');
      return;
    }
    call.undone = { at: nowIso(), summary };
    c.toast(`已撤销「${call.title}」：${summary}`, outcome.restored.length + outcome.trashed.length === 0 && outcome.skipped.length > 0 ? 'error' : 'info');
    postRow(c, turn.id, call);
    await persist(c);
    await c.pushState();
  } finally {
    lease?.release();
  }
}

/** 查询那一条路的 `ToolRun`：没人看，说的话进日志。 */
function quietRun(signal: AbortSignal): ToolRun {
  return {
    signal,
    report: (message) => log.debug(message),
    usage: { record: () => undefined },
  };
}

/**
 * 这次调用挂在哪个气泡上：会话最后一轮就是 MCP 的气泡就接着用，否则另起一个。
 * 作者在中间说过话，那就是另一段事了。
 */
function openTurn(c: ChatController): ChatTurn {
  const turns = c.current.turns;
  const last = turns[turns.length - 1];
  if (last?.role === 'assistant' && last.mcp) {
    return last;
  }
  const turn: ChatTurn = { id: makeTurnId(), role: 'assistant', content: '', at: nowIso(), mcp: true };
  turns.push(turn);
  c.post({ type: 'turnDone', turn: serializeTurn(turn) });
  return turn;
}

/**
 * 产出的草稿：直接落盘（落盘卡片那一问由 `askGate` 替作者答掉，记在这一步的代答里）。返回接在工具结果后面的那句话与
 * 工具条摘要上那半句；解析不出可落盘的形状（讨论类的产出）就没有。**不打开文件**：外部 agent 可能连着写好几份，一次次抢编辑器。
 */
async function adopt(
  c: ChatController,
  turnId: string,
  row: TurnToolCall,
  draftIds: string[],
  signal: AbortSignal
): Promise<{ text: string; summary: string } | undefined> {
  const draftId = draftIds[draftIds.length - 1];
  const draft = c.drafts.get(draftId);
  const art = draft?.artifact ? await describeArtifactOf(c, draft.raw, draft) : undefined;
  if (!draft || !art) {
    return undefined;
  }
  c.current.drafts = c.drafts.bySession(c.current.id);
  const r = await askArtifact(c, { turnId, draft, art, byAgent: true, callId: row.callId, open: false, signal });
  return r.relPath
    ? { text: `${r.message}这份产物已经落盘，**不要再写一遍**。`, summary: `已写入 ${r.relPath}` }
    : { text: `没有落盘：${r.message}`, summary: '未落盘' };
}

/** 把这一步的改动账与代答记到那一行上。代答截短（它随会话落盘）；没有就不留这两个键。 */
function recordStep(row: TurnToolCall, step: AgentStepChanges, call: AgentCall): void {
  if (hasChanges(step)) {
    row.changes = step;
  }
  if (call.answers.length > 0) {
    row.answers = call.answers.map((a) => ({
      kind: a.kind,
      question: clip(a.question, QUESTION_LIMIT),
      ...(a.detail ? { detail: clip(a.detail, ANSWER_DETAIL_LIMIT) } : {}),
      answer: clip(a.answer, QUESTION_LIMIT),
    }));
  }
}

/**
 * 回给 agent 的那份清单：改了哪几份、替作者答了什么。**要短**——它每走一步都重烧一遍上下文，所以每样只列前几条，
 * 问题只留第一行。没有改动也没有代答就是空串。
 */
export function describeStepForAgent(step: AgentStepChanges, answers: readonly AgentAnswer[]): string {
  const parts: string[] = [];
  if (hasChanges(step)) {
    const lines = step.files.slice(0, AGENT_LIST_LIMIT).map((f) => `- ${describeChange(f)}`);
    if (step.files.length > AGENT_LIST_LIMIT) {
      lines.push(`- 另有 ${step.files.length - AGENT_LIST_LIMIT} 份`);
    }
    if (step.marks) {
      lines.push('- 推了工程进度（全文大纲 / 叙事线判到第几章）');
    }
    for (const ext of step.external ?? []) {
      lines.push(`- 我的技能库里装了「${ext.name}」`);
    }
    parts.push(`这一步的改动（作者可以在 Novelwarden 对话页上撤销）：\n${lines.join('\n')}`);
  }
  if (answers.length > 0) {
    const lines = answers.slice(0, AGENT_LIST_LIMIT).map((a) => `- ${short(firstLine(a.question), 80)} → ${short(a.answer, 40)}`);
    if (answers.length > AGENT_LIST_LIMIT) {
      lines.push(`- 另有 ${answers.length - AGENT_LIST_LIMIT} 处`);
    }
    parts.push(`途中的确认已按缺省作答：\n${lines.join('\n')}`);
  }
  return parts.join('\n');
}

function describeChange(f: FileChange): string {
  const words =
    f.wordsBefore !== undefined && f.wordsAfter !== undefined ? `，${f.wordsBefore} → ${f.wordsAfter} 字` : f.wordsAfter !== undefined ? `，${f.wordsAfter} 字` : '';
  const verb = f.status === 'created' ? '新建' : f.status === 'deleted' ? '删除（进回收站）' : '修改';
  return `${verb} ${f.path}${words}${f.unsaved ? `（改之前那一版没存下：${f.unsaved}）` : ''}`;
}

function settleRow(row: TurnToolCall, r: { ok: boolean; summary: string; elapsedMs: number; text: string }): void {
  row.ok = r.ok;
  row.summary = r.summary;
  row.elapsedMs = r.elapsedMs;
  row.resultText = r.text ? clip(r.text, RESULT_LIMIT) : undefined;
}

function postRow(c: ChatController, turnId: string, row: TurnToolCall): void {
  c.post({
    type: 'toolResult',
    turnId,
    callId: row.callId,
    name: row.name,
    ok: row.ok,
    summary: row.summary,
    elapsedMs: row.elapsedMs,
    argsText: row.argsText,
    resultText: row.resultText,
    ...(row.changes ? { changes: row.changes } : {}),
    ...(row.answers ? { answers: row.answers } : {}),
    ...(row.undone ? { undone: row.undone } : {}),
  });
}

/** 截一段给界面看的文本。**说出自己截了**（第 2 条：不静默截断）。 */
function clip(text: string, limit: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}\n…（还有 ${trimmed.length - limit} 字，已截断）`;
}

/** 一行里的短引：超长就截断，末尾一个省略号。 */
function short(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describeArgs(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length === 0) {
    return undefined;
  }
  try {
    return clip(JSON.stringify(args, null, 2), ARGS_LIMIT);
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}
