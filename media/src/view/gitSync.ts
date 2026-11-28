/**
 * 工程级 Git 自动同步的前端视图：设置页「通用 → Git 自动同步」的开关、状态区、立即同步按钮，
 * 以及独立版标题栏上的常驻状态徽标（未开启时隐藏，点击跳到设置页）。
 */
import { maybeById, setHidden } from '../dom';
import type { GitSyncPhase, GitSyncStatus } from '../protocol';
import { showSettingsCategory } from './settings';
import { hasWorkspace, store, vscode } from './store';
import { showTab } from './tabs';

let lastStatus: GitSyncStatus = { enabled: false, phase: 'off', label: '已关闭' };

function phaseTone(phase: GitSyncPhase): 'ok' | 'warn' | 'error' | 'busy' | 'muted' {
  switch (phase) {
    case 'synced':
    case 'idle':
      return 'ok';
    case 'syncing':
    case 'pending':
      return 'busy';
    case 'localOnly':
    case 'notRepo':
      return 'warn';
    case 'conflict':
    case 'error':
      return 'error';
    case 'off':
    default:
      return 'muted';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function installGitSync(): void {
  const checkbox = maybeById<HTMLInputElement>('setGitAutoSync');
  checkbox?.addEventListener('change', () => {
    vscode.postMessage({ type: 'setGitAutoSync', enabled: checkbox.checked });
  });

  const syncNowBtn = maybeById<HTMLButtonElement>('gitSyncNowBtn');
  syncNowBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'gitSyncNow' });
  });

  const pill = maybeById<HTMLButtonElement>('wbGitSync');
  pill?.addEventListener('click', () => {
    showTab('settings');
    showSettingsCategory('general');
  });

  render();
}

export function renderGitSync(status: GitSyncStatus): void {
  lastStatus = status;
  render();
}

export function syncGitSyncAvailability(): void {
  render();
}

function render(): void {
  const ready = hasWorkspace() && store.state?.initialized === true;
  const status = ready ? lastStatus : { enabled: false, phase: 'off' as const, label: '已关闭' };
  const tone = phaseTone(status.phase);

  const checkbox = maybeById<HTMLInputElement>('setGitAutoSync');
  if (checkbox) {
    checkbox.disabled = !ready;
    checkbox.checked = ready && status.enabled;
  }

  const badge = maybeById('gitSyncBadge');
  if (badge) {
    badge.textContent = status.label;
    badge.className = `git-sync-badge is-${tone}`;
  }

  const detail = maybeById('gitSyncDetail');
  if (detail) {
    if (!ready) {
      detail.textContent = '请先打开并初始化小说工程。';
    } else if (status.detail) {
      const suffix = status.lastSyncAt ? ` · ${formatTime(status.lastSyncAt)}` : '';
      detail.textContent = `${status.detail}${suffix}`;
    } else if (status.phase === 'off') {
      detail.textContent = '默认关闭，仅在当前工程生效。';
    } else {
      detail.textContent = '';
    }
  }

  const syncNowBtn = maybeById<HTMLButtonElement>('gitSyncNowBtn');
  if (syncNowBtn) {
    const showBtn = ready && status.enabled && status.phase !== 'notRepo';
    setHidden(syncNowBtn, !showBtn);
    syncNowBtn.disabled = status.phase === 'syncing';
  }

  const pill = maybeById<HTMLButtonElement>('wbGitSync');
  if (pill) {
    const showPill = ready && status.enabled && status.phase !== 'off';
    setHidden(pill, !showPill);
    if (showPill) {
      const timeSuffix = status.phase === 'synced' && status.lastSyncAt ? ` ${formatTime(status.lastSyncAt)}` : '';
      pill.textContent = `⎇ ${status.label}${timeSuffix}`;
      pill.className = `wb-git-sync is-${tone}`;
      pill.title = status.detail ? `Git 自动同步：${status.detail}` : `Git 自动同步：${status.label}`;
    }
  }
}
