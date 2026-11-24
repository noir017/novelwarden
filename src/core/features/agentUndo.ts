/**
 * 撤销外部 agent 的一步：照那一步的改动账（`workspace/journal.ts`）把动过的每一份放回改之前那一版。
 *
 * 外部 agent 的操作不等人点（AGENTS 第 19 / 25 条），兜底就是这里。按文件退，不碰别的：
 *
 * | 那一步里它 | 现在 | 怎么退 |
 * |---|---|---|
 * | 改过（`modified`） | 与那一步结束时一样 | 写回改之前那一版（历史版本里的快照，字节原样） |
 * | 新建了（`created`） | 与那一步结束时一样 | 搬进回收站（第 6 条：不真删）；已经不在了就算退了 |
 * | 删掉了（`deleted`） | 还不在 | 从改之前那一版写回来 |
 * | 任何一种 | 之后又被改过 / 又建出来了 / 编辑器里有没保存的修改 | **跳过不盖**，照实说为什么 |
 *
 * 写回走网关的 `restoreBytes`（守卫照过、乐观锁带着那一步结束时的指纹、不跑记账——细纲 frontmatter 里的指纹跟着回到
 * 当时，第 18 条）；写回之前把现在这一份（agent 改完的）也存一版，备注「撤销 … 之前」，撤销本身也退得回来。`project.json`
 * 里的两个进度只在之后没再推过时放回去。工程外装进我的技能库的，从技能库卸载（进它自己的回收站）。动过章节就同步一次 manifest。
 */
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { describeError, scoped } from '../runtime/logger';
import { uninstallUserSkill } from '../skills/library';
import { Workspace, WsConflictError, WsError } from '../workspace';
import { readSnapshotBytes, snapshotNow } from '../workspace/history';
import type { AgentStepChanges, FileChange } from '../model/agentStep';
import { kindOfPath, normalizeRel } from '../workspace/kind';
import { readFile } from 'node:fs/promises';

const log = scoped('撤销');

export type UndoSkipReason = 'dirty' | 'changed' | 'appeared' | 'unsaved' | 'unreadable' | 'failed';

export const UNDO_SKIP_TEXT: Record<UndoSkipReason, string> = {
  dirty: '编辑器里有未保存的修改：先保存（或放弃修改），再撤销一次',
  changed: '那一步之后又被改过，没拿旧版去盖',
  appeared: '那一步之后又建出来了，没动',
  unsaved: '那一步之前没存下旧版，退不回去',
  unreadable: '改之前那一版读不出来（可能已经被裁掉了）',
  failed: '写不进去',
};

export interface UndoOutcome {
  /** 没撤销的原因（有任务在跑）。给了它别的都是空的。 */
  refused?: string;
  restored: string[];
  trashed: string[];
  skipped: { path: string; reason: UndoSkipReason; detail?: string }[];
  /** 两个进度：放回去了、之后又推过没动。那一步没推过就没有。 */
  marks?: 'restored' | 'moved';
  /** 工程外撤掉了什么，一件一句。 */
  external: string[];
}

export async function undoAgentStep(
  project: NovelProject,
  step: AgentStepChanges,
  opts: { busy: boolean; dirty?: readonly string[]; label: string }
): Promise<UndoOutcome> {
  const out: UndoOutcome = { restored: [], trashed: [], skipped: [], external: [] };
  if (opts.busy) {
    return { ...out, refused: '有任务在跑（或正在生成）：等它跑完、或先停下，再撤销。' };
  }
  const dirty = new Set((opts.dirty ?? []).map(normalizeRel).filter((p): p is string => !!p));
  const skip = (path: string, reason: UndoSkipReason, detail?: string) => out.skipped.push({ path, reason, ...(detail ? { detail } : {}) });
  const ws = new Workspace(project);
  const note = `撤销「${opts.label}」之前`;
  let chapters = false;

  for (const change of step.files) {
    const rel = normalizeRel(change.path);
    if (rel === undefined) {
      continue;
    }
    if (dirty.has(rel)) {
      skip(rel, 'dirty');
      continue;
    }
    const now = await currentHash(project, rel);
    try {
      if (change.status === 'created') {
        if (now === undefined) {
          continue; // 已经不在了：本来就是要它不在。
        }
        if (now !== change.after) {
          skip(rel, 'changed');
          continue;
        }
        await snapshotNow(project, rel, { anyKind: true, note });
        await ws.remove(rel);
        out.trashed.push(rel);
      } else {
        if (change.status === 'deleted' ? now !== undefined : now !== change.after) {
          skip(rel, change.status === 'deleted' ? 'appeared' : 'changed');
          continue;
        }
        const bytes = await beforeBytes(project, change);
        if (typeof bytes === 'string') {
          skip(rel, bytes === 'unsaved' ? 'unsaved' : 'unreadable', bytes === 'unsaved' ? change.unsaved : undefined);
          continue;
        }
        if (change.status === 'modified') {
          await snapshotNow(project, rel, { anyKind: true, note });
        }
        await ws.restoreBytes(rel, bytes, change.status === 'deleted' ? { absent: true } : { baseHash: change.after });
        out.restored.push(rel);
      }
      chapters ||= kindOfPath(project, rel).kind === 'chapter';
    } catch (err) {
      if (err instanceof WsConflictError) {
        skip(rel, 'changed');
      } else if (err instanceof WsError && err.code === 'exists') {
        skip(rel, 'appeared');
      } else {
        skip(rel, 'failed', describeError(err));
      }
    }
  }

  if (step.marks) {
    try {
      out.marks = (await ws.restoreMarks(step.marks.before, step.marks.after)) ? 'restored' : 'moved';
    } catch (err) {
      log.warn('撤销时没能放回进度', describeError(err));
      out.marks = 'moved';
    }
  }
  for (const ext of step.external ?? []) {
    if (ext.kind === 'userSkill') {
      try {
        const dest = await uninstallUserSkill(ext.name);
        out.external.push(dest ? `从我的技能库卸载了「${ext.name}」（搬进了技能库的回收站）` : `我的技能库里已经没有「${ext.name}」了`);
      } catch (err) {
        out.external.push(`没能卸载「${ext.name}」：${describeError(err)}`);
      }
    }
  }
  if (chapters) {
    await project.syncManifest().catch((err) => log.warn('撤销之后同步章节清单失败', describeError(err)));
  }
  log.info(
    `撤销 Agent 的一步：${opts.label}`,
    `放回 ${out.restored.length} 份｜搬进回收站 ${out.trashed.length} 份｜跳过 ${out.skipped.length} 份` +
      (out.marks ? `｜进度${out.marks === 'restored' ? '已放回' : '之后又推过，没动'}` : '') +
      (out.external.length > 0 ? `｜${out.external.join('；')}` : '')
  );
  return out;
}

/** 撤销的汇总（toast 与工具条上那一句）：放回几份、搬进回收站几份、跳过的逐份说为什么（多了只列前几份）。 */
export function describeUndo(o: UndoOutcome): string {
  if (o.refused) {
    return o.refused;
  }
  const parts: string[] = [];
  const done = o.restored.length + o.trashed.length;
  parts.push(
    done === 0
      ? '没有文件被放回'
      : `已放回 ${o.restored.length} 份` + (o.trashed.length > 0 ? `，搬进回收站 ${o.trashed.length} 份` : '')
  );
  if (o.marks === 'restored') {
    parts.push('进度已放回');
  } else if (o.marks === 'moved') {
    parts.push('进度之后又推过，没动');
  }
  parts.push(...o.external);
  if (o.skipped.length > 0) {
    const shown = o.skipped.slice(0, 3).map((s) => `${s.path}（${s.detail ?? UNDO_SKIP_TEXT[s.reason]}）`);
    parts.push(`跳过 ${o.skipped.length} 份：${shown.join('；')}${o.skipped.length > 3 ? ' 等，明细在日志里' : ''}`);
    for (const s of o.skipped) {
      log.info(`撤销时跳过 ${s.path}`, s.detail ?? UNDO_SKIP_TEXT[s.reason]);
    }
  }
  return parts.join('；');
}

async function beforeBytes(project: NovelProject, change: FileChange): Promise<Buffer | 'unsaved' | 'unreadable'> {
  if (!change.before) {
    return 'unsaved';
  }
  try {
    return await readSnapshotBytes(project, change.path, change.before);
  } catch {
    return 'unreadable';
  }
}

/** 磁盘上此刻这一份的指纹（与网关乐观锁同一口径：按 utf8 读出来算 `hash`）。不在给 undefined。 */
async function currentHash(project: NovelProject, rel: string): Promise<string | undefined> {
  try {
    return hash(await readFile(project.pathOf(rel), 'utf8'));
  } catch {
    return undefined;
  }
}
