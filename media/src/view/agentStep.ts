/**
 * 外部 agent 一步的记录，画在对话页那一行工具条（与 generate 卡）上：**改了哪几份、替作者答了什么、撤销这一步**。
 * 后端一半在 `core/controller/mcp.ts`（记）与 `core/features/agentUndo.ts`（退）。
 *
 * - 摘要行上一个小标：「改 3 份 · 撤销」，撤销过就是「已撤销」。点它不开合折叠块（`preventDefault`）。
 * - 展开之后两段清单：改动（点一份在编辑区开对比标签：改之前那一版 ↔ 现在，没有内置编辑器就打开文件）、
 *   替作者答的那几问（问的什么、答的什么，说明折叠着）。
 * - 「撤销」点两下才发（第一下换字，同存档点的退回）：放回去会盖掉 agent 写的那几份（它们先存一版历史）。
 *   编辑器里有未保存修改的那几份经 `nf-dirty-query` 带上，后端跳过。
 */
import type { SerializedToolCall } from '../protocol';
import { el as mk } from '../dom';
import { commandVersionDiff, queryDirtyPaths, queryVersionDiff } from '../globals';
import { openPath, vscode } from './store';

type Step = Pick<SerializedToolCall, 'callId' | 'title' | 'changes' | 'answers' | 'undone'>;
type Change = NonNullable<SerializedToolCall['changes']>['files'][number];

const VERB: Record<Change['status'], string> = { modified: '改', created: '建', deleted: '删' };

/** 有没有要画的：改过东西、或替作者答过。 */
export function hasStep(call: Step): boolean {
  return countChanges(call) > 0 || (call.answers?.length ?? 0) > 0;
}

/** 摘要行上的小标。没改东西也没撤销过就不给。 */
export function stepChip(call: Step): HTMLElement | undefined {
  const n = countChanges(call);
  if (n === 0) {
    return undefined;
  }
  const chip = mk('span', 'step-chip');
  const files = call.changes?.files.length ?? 0;
  chip.appendChild(mk('span', 'step-count', files > 0 ? `改 ${files} 份` : '有改动'));
  if (call.undone) {
    const done = mk('span', 'step-undone', '已撤销');
    done.title = call.undone.summary;
    chip.appendChild(done);
  } else {
    chip.appendChild(undoButton(call));
  }
  return chip;
}

/** 展开之后的两段清单。都没有就不给。 */
export function buildStepDetail(call: Step): HTMLElement | undefined {
  if (!hasStep(call)) {
    return undefined;
  }
  const box = mk('div', 'step-detail');
  const changes = call.changes;
  if (changes && countChanges(call) > 0) {
    box.appendChild(mk('div', 'tool-detail-label', call.undone ? `改动（已撤销：${call.undone.summary}）` : '改动（点一份看改之前 ↔ 现在）'));
    const ul = mk('ul', 'step-files');
    for (const f of changes.files) {
      ul.appendChild(changeRow(call, f));
    }
    if (changes.marks) {
      ul.appendChild(mk('li', 'step-note', '推了工程进度（全文大纲 / 叙事线判到第几章），撤销时一起放回'));
    }
    for (const ext of changes.external ?? []) {
      ul.appendChild(mk('li', 'step-note', `我的技能库里装了「${ext.name}」，撤销时卸掉`));
    }
    box.appendChild(ul);
  }
  if (call.answers && call.answers.length > 0) {
    box.appendChild(mk('div', 'tool-detail-label', '途中的确认（已按缺省作答）'));
    const ul = mk('ul', 'step-answers');
    for (const a of call.answers) {
      const li = mk('li');
      const line = `${a.question} → ${a.answer}`;
      if (a.detail) {
        const det = mk('details');
        det.appendChild(mk('summary', undefined, line));
        det.appendChild(mk('pre', 'tool-detail-text', a.detail));
        li.appendChild(det);
      } else {
        li.textContent = line;
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

function changeRow(call: Step, f: Change): HTMLElement {
  const li = mk('li', `step-file step-${f.status}`);
  li.appendChild(mk('span', 'step-verb', VERB[f.status]));
  const link = mk('button', 'link step-path', f.path);
  link.type = 'button';
  link.title = f.status === 'created' ? '这一步新建的：打开看' : '改之前那一版 ↔ 现在';
  link.addEventListener('click', () => openChange(call, f));
  li.appendChild(link);
  const words =
    f.wordsBefore !== undefined && f.wordsAfter !== undefined
      ? `${f.wordsBefore} → ${f.wordsAfter} 字`
      : f.wordsAfter !== undefined
        ? `${f.wordsAfter} 字`
        : f.wordsBefore !== undefined
          ? `原 ${f.wordsBefore} 字`
          : '';
  if (words) {
    li.appendChild(mk('span', 'step-words', words));
  }
  if (f.unsaved) {
    const warn = mk('span', 'step-unsaved', '撤销不了');
    warn.title = `改之前那一版没存下：${f.unsaved}`;
    li.appendChild(warn);
  }
  return li;
}

function openChange(call: Step, f: Change): void {
  if (!queryVersionDiff()) {
    if (f.status !== 'deleted') {
      openPath(f.path);
    }
    return;
  }
  commandVersionDiff({
    kind: 'snapshot',
    path: f.path,
    status: f.status === 'modified' ? 'changed' : f.status === 'created' ? 'added' : 'deleted',
    ...(f.before ? { snapshot: { id: f.before, label: `「${call.title}」之前` } } : {}),
  });
}

/** 两段式：第一下换字，第二下才发。点到别处（失焦）退回第一段。 */
function undoButton(call: Step): HTMLButtonElement {
  const btn = mk('button', 'link step-undo', '撤销');
  btn.type = 'button';
  btn.title = '把这一步改过的文件放回改之前那一版（之后又被改过的不动）';
  let armed = false;
  btn.addEventListener('click', (e) => {
    // 按钮长在 <summary> 里：不让这一下开合折叠块。
    e.preventDefault();
    e.stopPropagation();
    if (!armed) {
      armed = true;
      btn.textContent = '确定撤销？';
      btn.classList.add('is-armed');
      return;
    }
    armed = false;
    btn.disabled = true;
    btn.textContent = '撤销中…';
    const turnId = btn.closest<HTMLElement>('[data-turn]')?.dataset.turn;
    if (!turnId) {
      return;
    }
    vscode.postMessage({ type: 'undoAgentStep', turnId, callId: call.callId, dirty: queryDirtyPaths() });
  });
  btn.addEventListener('blur', () => {
    if (armed) {
      armed = false;
      btn.textContent = '撤销';
      btn.classList.remove('is-armed');
    }
  });
  return btn;
}

function countChanges(call: Step): number {
  const c = call.changes;
  return c ? c.files.length + (c.marks ? 1 : 0) + (c.external?.length ?? 0) : 0;
}
