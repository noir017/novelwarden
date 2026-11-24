/**
 * 外部 agent 一次调用的改动账：**这一步动过哪几份文件、每份改之前是哪一版、改完是什么样**。
 *
 * MCP 的写盘调用跑在 {@link withJournal} 里（`controller/mcp.ts`）。网关在这一次里动任何一份文件之前——写、追加、改名、
 * 搬进回收站、复制出来——都先经 `disk.ts` 调到 {@link noteChange}：这份文件第一次被碰到时，把磁盘上此刻的它存一版历史
 * （`history.ts`，跳过节流，备注「Agent：<动作> 之前」），记下它在不在。调用结束时 {@link ChangeJournal.finish} 逐份看现在的
 * 样子，得出改了 / 新建了 / 删掉了哪几份（`FileChange`）。撤销这一步就是按这份账把每份放回改之前那一版
 * （`features/agentUndo.ts`）。
 *
 * - **按文件记，不存整本**：只记这一步碰到的；作者同时在编辑器里保存的不在这个作用域里（别的消息、别的异步链），记不进来。
 * - **第一次碰到才存**：同一步里一份文件被写了几遍，账上只有「这一步之前」那一版。
 * - **不是创作产物的也存**（`anyKind`）：agent 动过的每一份都要找得回来。回收站、历史版本、内部文件不记——它们不是作者的文件，
 *   搬进回收站的那一头记在原路径上（删掉了）。
 * - **工程里的两个进度**（全文大纲、叙事线判到第几章）记在 `project.json` 里，它同时是常被改写的章节索引，整份按文件退会被
 *   跳过：所以单记这两个值（{@link noteMarks}），撤销时只退它们。
 * - **结了账就不再记**：作用域里留下的回调（定时器、监听）在调用结束之后才触发，那是另一件事。
 * - **存不下改之前那一版**（太大、磁盘满）照常写盘（历史版本「绝不挡住保存」），账上记 `unsaved`，那一份撤销不了。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentStepChanges, FileChange, ProgressMarks, sameMarks } from '../model/agentStep';
import { countWords, hash } from '../model/fs';
import { decodeFileText } from '../model/importText';
import type { NovelProject } from '../model/project';
import { scoped } from '../runtime/logger';
import { isInHistory, isInTrash, isInternalPath } from './guard';
import { SnapshotResult, snapshotNow } from './history';
import { normalizeRel } from './kind';

const log = scoped('Agent 改动');

/** 一步动了哪几份文件、两个进度推没推（工程外的由 `runtime/agentCall.ts` 另记）。 */
export type JournalResult = Omit<AgentStepChanges, 'external'>;

interface Before {
  existed: boolean;
  hash?: string;
  words?: number;
  snapshot?: string;
  unsaved?: string;
}

export class ChangeJournal {
  private readonly files = new Map<string, Promise<Before>>();
  private marks?: Promise<ProgressMarks>;
  private closed = false;

  /** `note` 是存下的那几版的备注（「Agent：批量写章 之前」）。 */
  constructor(
    readonly project: NovelProject,
    private readonly note: string
  ) {}

  /** 这份文件马上要被动了（`rel` 已规范化）。第一次碰到时存下改之前那一版。 */
  touch(rel: string): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    let pending = this.files.get(rel);
    if (!pending) {
      pending = this.before(rel);
      this.files.set(rel, pending);
    }
    return pending.then(() => undefined);
  }

  /** 两个进度马上要被推了。第一次时记下推之前的值。 */
  touchMarks(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.marks ??= readMarks(this.project);
    return this.marks.then(() => undefined);
  }

  /** 结账：逐份看现在的样子。之后再碰什么都不记。前后一字不差的、建了又删掉的不算改动。 */
  async finish(): Promise<JournalResult> {
    this.closed = true;
    const files: FileChange[] = [];
    for (const [rel, pending] of this.files) {
      const before = await pending;
      const now = await readState(this.project, rel);
      if (!before.existed && !now) {
        continue;
      }
      if (before.existed && now && before.hash === now.hash) {
        continue;
      }
      files.push({
        path: rel,
        status: !before.existed ? 'created' : !now ? 'deleted' : 'modified',
        ...(before.snapshot ? { before: before.snapshot } : {}),
        ...(before.unsaved ? { unsaved: before.unsaved } : {}),
        ...(now ? { after: now.hash, wordsAfter: now.words } : {}),
        ...(before.words !== undefined ? { wordsBefore: before.words } : {}),
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    let marks: JournalResult['marks'];
    if (this.marks) {
      const before = await this.marks;
      const after = await readMarks(this.project);
      if (!sameMarks(before, after)) {
        marks = { before, after };
      }
    }
    return { files, ...(marks ? { marks } : {}) };
  }

  private async before(rel: string): Promise<Before> {
    const state = await readState(this.project, rel);
    if (!state) {
      return { existed: false };
    }
    const r = await snapshotNow(this.project, rel, { anyKind: true, note: this.note });
    const snapshot = r.saved ?? r.latest;
    if (!snapshot) {
      log.warn(`没能存下 ${rel} 改之前那一版，这一份撤销不了`, describeUnsaved(r));
    }
    return { existed: true, hash: state.hash, words: state.words, ...(snapshot ? { snapshot } : { unsaved: describeUnsaved(r) }) };
  }
}

const scope = new AsyncLocalStorage<ChangeJournal>();

/** 在这本账下跑 `fn`：里面经网关动的每一份文件都记进 `journal`。 */
export function withJournal<T>(journal: ChangeJournal, fn: () => Promise<T>): Promise<T> {
  return scope.run(journal, fn);
}

/**
 * 网关动 `abs` 之前调（`disk.ts`）。不在哪本账下、不是这个工程、不是作者的文件（回收站、历史版本、内部文件、工程外）
 * 什么都不做。目录逐个文件记。
 */
export async function noteChange(project: NovelProject, abs: string): Promise<void> {
  const journal = journalFor(project);
  if (!journal) {
    return;
  }
  for (const rel of await filesUnder(project, abs)) {
    await journal.touch(rel);
  }
}

/** 网关把 `from` 搬到 `to` 之前调：两头都记（原路径「删掉了」、新路径「新建了」）。目录逐个文件对应着记。 */
export async function noteMove(project: NovelProject, fromAbs: string, toAbs: string): Promise<void> {
  const journal = journalFor(project);
  if (!journal) {
    return;
  }
  for (const rel of await filesUnder(project, fromAbs)) {
    await journal.touch(rel);
    const sub = path.relative(fromAbs, project.pathOf(rel));
    const target = trackedRel(project, sub ? path.join(toAbs, sub) : toAbs);
    if (target !== undefined) {
      await journal.touch(target);
    }
  }
}

/** 网关推 `project.json` 里那两个进度之前调。 */
export async function noteMarks(project: NovelProject): Promise<void> {
  await journalFor(project)?.touchMarks();
}

function journalFor(project: NovelProject): ChangeJournal | undefined {
  const journal = scope.getStore();
  return journal && path.resolve(journal.project.root) === path.resolve(project.root) ? journal : undefined;
}

/** 工程里作者的文件的相对路径；工程外、回收站、历史版本、内部文件给 undefined。 */
function trackedRel(project: NovelProject, abs: string): string | undefined {
  const rel = normalizeRel(project.relPath(abs));
  if (rel === undefined || isInTrash(project, rel) || isInHistory(project, rel) || isInternalPath(project, rel)) {
    return undefined;
  }
  return rel;
}

/** `abs` 是文件就是它自己；是目录就是它下面的每一份文件（不跟符号链接）；不在也算它自己（马上要建出来）。 */
async function filesUnder(project: NovelProject, abs: string): Promise<string[]> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(abs);
  } catch {
    const rel = trackedRel(project, abs);
    return rel === undefined ? [] : [rel];
  }
  if (!stat.isDirectory()) {
    const rel = trackedRel(project, abs);
    return rel === undefined || stat.isSymbolicLink() ? [] : [rel];
  }
  const out: string[] = [];
  for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) {
      out.push(...(await filesUnder(project, path.join(abs, entry.name))));
    }
  }
  return out;
}

/** 磁盘上此刻这一份：指纹与字数。不在（或不是文件）给 undefined。 */
async function readState(project: NovelProject, rel: string): Promise<{ hash: string; words: number } | undefined> {
  try {
    const buf = await fs.readFile(project.pathOf(rel));
    return { hash: hash(buf.toString('utf8')), words: countWords(decodeFileText(buf)) };
  } catch {
    return undefined;
  }
}

async function readMarks(project: NovelProject): Promise<ProgressMarks> {
  const m = await project.readManifest();
  return {
    ...(m.globalSummaryThrough !== undefined ? { globalSummaryThrough: m.globalSummaryThrough } : {}),
    ...(m.threadsThrough !== undefined ? { threadsThrough: m.threadsThrough } : {}),
    ...(m.threadsJudged !== undefined ? { threadsJudged: [...m.threadsJudged] } : {}),
  };
}

function describeUnsaved(r: SnapshotResult): string {
  if (r.error) {
    return `存的时候出错：${r.error}`;
  }
  switch (r.skipped) {
    case 'tooLarge':
      return '超过 2 MB，不存历史版本';
    case 'notTracked':
      return '这里还不是小说工程（没有 .novelwarden/），不存历史版本';
    default:
      return '没存下';
  }
}
