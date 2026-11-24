/**
 * 外部 agent 一步的记录：**替作者答了什么、动了哪几份文件、每份改之前是哪一版**。随工具调用那一行留在会话上
 * （`TurnToolCall`），对话页画出来，「撤销这一步」照它退（`features/agentUndo.ts`）。
 *
 * 只是形状与几个纯函数：谁来记在 `runtime/agentCall.ts`（替作者答的）与 `workspace/journal.ts`（改动账）。
 * 会话文件是作者能手改的东西，读回来经 {@link normalizeAgentStep} 容错（第 1 条）。
 */

/** 替作者答掉的一问。 */
export interface AgentAnswer {
  /** 哪一类问法：确认框、调模型之前那一问、输入框、挑选框、覆盖审阅、逐段合并、对话页卡片。 */
  kind: 'confirm' | 'call' | 'input' | 'pick' | 'review' | 'merge' | 'gate';
  /** 问的那句话（原样，给人看）。 */
  question: string;
  /** 问题下面那段说明（调几次模型、改什么）。 */
  detail?: string;
  /** 答的什么：按钮上的字、填的值，或「取消」。 */
  answer: string;
}

/**
 * 这一步在工程之外动了的东西：网关记不到，由动手的那一处自己报（目前只有装进我的技能库）。存的是数据不是闭包——
 * 它随会话落盘，撤销时按 `kind` 找回去。
 */
export type ExternalChange = { kind: 'userSkill'; name: string };

export type ChangeStatus = 'modified' | 'created' | 'deleted';

/** 这一步里一份文件的改动。 */
export interface FileChange {
  path: string;
  status: ChangeStatus;
  /** 改之前那一版在历史版本里的快照 id（`workspace/history.ts` 的文件名）。新建的没有；存不下时也没有（见 `unsaved`）。 */
  before?: string;
  /** 改之前那一版为什么没存下。有它这一份就撤销不了。 */
  unsaved?: string;
  /** 这一步结束时的内容指纹（`hash`，与网关乐观锁同一口径）。删掉的没有。撤销时比它：之后又被改过就不盖。 */
  after?: string;
  wordsBefore?: number;
  wordsAfter?: number;
}

/** `project.json` 里的两个进度（`ProjectManifest` 的同名字段）。 */
export interface ProgressMarks {
  globalSummaryThrough?: number;
  threadsThrough?: number;
  threadsJudged?: number[];
}

/** 一步动了什么。 */
export interface AgentStepChanges {
  files: FileChange[];
  /** 两个进度被推过时：推之前与这一步结束时的值。 */
  marks?: { before: ProgressMarks; after: ProgressMarks };
  external?: ExternalChange[];
}

/** 撤销过了：什么时候、结果那一句。 */
export interface AgentStepUndo {
  at: string;
  summary: string;
}

/** 两份进度是不是一样（`threadsJudged` 按值比）。 */
export function sameMarks(a: ProgressMarks, b: ProgressMarks): boolean {
  return (
    a.globalSummaryThrough === b.globalSummaryThrough &&
    a.threadsThrough === b.threadsThrough &&
    JSON.stringify(a.threadsJudged ?? []) === JSON.stringify(b.threadsJudged ?? [])
  );
}

/** 一步有没有可撤销的东西。 */
export function hasChanges(step: AgentStepChanges | undefined): step is AgentStepChanges {
  return !!step && (step.files.length > 0 || !!step.marks || (step.external?.length ?? 0) > 0);
}

const STATUSES: readonly ChangeStatus[] = ['modified', 'created', 'deleted'];
const ANSWER_KINDS: readonly AgentAnswer['kind'][] = ['confirm', 'call', 'input', 'pick', 'review', 'merge', 'gate'];

/** 会话文件里读回来的改动账：认不出的条目丢掉，整个认不出给 undefined。 */
export function normalizeAgentStep(raw: unknown): AgentStepChanges | undefined {
  if (!isObject(raw) || !Array.isArray(raw.files)) {
    return undefined;
  }
  const files: FileChange[] = [];
  for (const f of raw.files) {
    if (!isObject(f) || typeof f.path !== 'string' || !STATUSES.includes(f.status as ChangeStatus)) {
      continue;
    }
    files.push({
      path: f.path,
      status: f.status as ChangeStatus,
      ...(typeof f.before === 'string' ? { before: f.before } : {}),
      ...(typeof f.unsaved === 'string' ? { unsaved: f.unsaved } : {}),
      ...(typeof f.after === 'string' ? { after: f.after } : {}),
      ...(typeof f.wordsBefore === 'number' ? { wordsBefore: f.wordsBefore } : {}),
      ...(typeof f.wordsAfter === 'number' ? { wordsAfter: f.wordsAfter } : {}),
    });
  }
  const marks =
    isObject(raw.marks) && isObject(raw.marks.before) && isObject(raw.marks.after)
      ? { before: normalizeMarks(raw.marks.before), after: normalizeMarks(raw.marks.after) }
      : undefined;
  const external = Array.isArray(raw.external)
    ? raw.external.filter((e): e is ExternalChange => isObject(e) && e.kind === 'userSkill' && typeof e.name === 'string')
    : [];
  return { files, ...(marks ? { marks } : {}), ...(external.length > 0 ? { external } : {}) };
}

/** 会话文件里读回来的「替作者答了什么」。 */
export function normalizeAgentAnswers(raw: unknown): AgentAnswer[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out = raw.filter(
    (a): a is AgentAnswer =>
      isObject(a) &&
      ANSWER_KINDS.includes(a.kind as AgentAnswer['kind']) &&
      typeof a.question === 'string' &&
      typeof a.answer === 'string' &&
      (a.detail === undefined || typeof a.detail === 'string')
  );
  return out.length > 0 ? out : undefined;
}

function normalizeMarks(raw: Record<string, unknown>): ProgressMarks {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const judged = Array.isArray(raw.threadsJudged) ? raw.threadsJudged.filter((x): x is number => typeof x === 'number') : undefined;
  return {
    ...(n(raw.globalSummaryThrough) !== undefined ? { globalSummaryThrough: n(raw.globalSummaryThrough) } : {}),
    ...(n(raw.threadsThrough) !== undefined ? { threadsThrough: n(raw.threadsThrough) } : {}),
    ...(judged ? { threadsJudged: judged } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
