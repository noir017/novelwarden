/**
 * 「哪个任务交给哪一档」的对照表。
 *
 * 八行，每行一个下拉框。默认值来自后端的 `DEFAULT_TASK_TIERS`（同一份定义，
 * 经 protocol.ts 引入）——设置页上写着「定稿 → 快速档」，跑起来就必须是
 * 快速档，两边各写一份迟早会漂。
 *
 * 只有与内置默认不同的项才会写进配置：这样日后调整默认值时，用户没动过的
 * 任务会跟着新默认走，而不是被一份「当年抄下来的默认值」钉死。
 */
import { el as mk, maybeById } from '../../dom';
import {
  DEFAULT_TASK_TIERS,
  LLM_TASKS,
  MODEL_TIERS,
  TASK_HINT,
  TASK_LABEL,
  TIER_LABEL,
  isModelTier,
} from '../../protocol';
import type { LlmTask, TaskTarget } from '../../protocol';
import { allRefs, draft, touch } from './draft';

export function renderTaskTiers(): void {
  const box = maybeById<HTMLElement>('taskTierTable');
  if (!box) {
    return;
  }
  box.innerHTML = '';
  const available = allRefs();
  for (const task of LLM_TASKS) {
    box.appendChild(buildRow(task, available));
  }
}

function buildRow(task: LlmTask, available: string[]): HTMLElement {
  const row = mk('div', 'task-tier-row');

  const label = mk('div', 'task-tier-label');
  label.appendChild(mk('span', 'task-tier-name', TASK_LABEL[task]));
  label.appendChild(mk('span', 'task-tier-hint', TASK_HINT[task]));
  row.appendChild(label);

  const current = draft.taskTiers[task] ?? DEFAULT_TASK_TIERS[task];
  const sel = document.createElement('select');
  sel.className = 'task-tier-select';

  const tierGroup = document.createElement('optgroup');
  tierGroup.label = '按档位';
  for (const tier of MODEL_TIERS) {
    const opt = document.createElement('option');
    opt.value = tier;
    // 标出哪个是内置默认，用户改乱了能找回来。
    opt.textContent = tier === DEFAULT_TASK_TIERS[task] ? `${TIER_LABEL[tier]}（默认）` : TIER_LABEL[tier];
    tierGroup.appendChild(opt);
  }
  sel.appendChild(tierGroup);

  const missingRef = !isModelTier(current) && !available.includes(current) ? current : '';
  if (available.length > 0 || missingRef) {
    const modelGroup = document.createElement('optgroup');
    modelGroup.label = '指定模型';
    if (missingRef) {
      const opt = document.createElement('option');
      opt.value = missingRef;
      opt.textContent = `${missingRef}（未配置）`;
      modelGroup.appendChild(opt);
    }
    for (const ref of available) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = ref;
      modelGroup.appendChild(opt);
    }
    sel.appendChild(modelGroup);
  }

  sel.value = current;
  sel.addEventListener('change', () => {
    const picked = sel.value as TaskTarget;
    if (picked === DEFAULT_TASK_TIERS[task]) {
      // 选回默认就把覆盖删掉，配置里只留真正改过的项。
      delete draft.taskTiers[task];
    } else {
      draft.taskTiers[task] = picked;
    }
    touch();
  });
  row.appendChild(sel);
  return row;
}
