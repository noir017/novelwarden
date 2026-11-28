/**
 * 工程目录的 Git 自动同步（工程级设置 `project.json` 的 `gitAutoSync`，默认关闭）。
 *
 * - **节流合并**：保存文件或完成一次「同步章节」后，按节流窗口（默认 30 秒，可用 `NOVELWARDEN_GIT_SYNC_MS` 覆盖）
 *   把多次改动合并为一次 `git add -A && git commit`，提交说明列出变更文件。
 * - **空闲推送**：配了远端时，若当前无长任务在跑则先 `git pull --rebase` 再 `git push`；忙碌时延后到空闲再推。
 * - **不丢数据、不卡编辑器**：所有 git 命令异步执行并带超时与 `GIT_TERMINAL_PROMPT=0`；`pull --rebase` 撞上冲突时
 *   立即 `git rebase --abort` 恢复工作区（本地提交与用户文件完好无损），并在界面上给出明确提示。
 * - **单飞排队**：同一工程同一时刻只跑一轮同步，同步期间又有新保存则记下待续跑，结束后按节流再跑一轮。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NovelProject } from '../model/project';
import { scoped } from '../runtime/logger';

const log = scoped('Git同步');

/** 默认节流窗口：30 秒内的多次保存/同步合并成一次提交。 */
export const DEFAULT_GIT_SYNC_THROTTLE_MS = 30_000;
/** 编辑器忙碌时等待空闲的重试间隔。 */
export const DEFAULT_GIT_SYNC_IDLE_RETRY_MS = 5_000;

const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export type GitSyncPhase =
  | 'off'
  | 'idle'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'localOnly'
  | 'notRepo'
  | 'conflict'
  | 'error';

export type GitSyncTrigger = 'save' | 'finalize' | 'manual';

export interface GitSyncStatus {
  enabled: boolean;
  phase: GitSyncPhase;
  /** 简短状态标签（标题栏指示器与设置页显示）。 */
  label: string;
  /** 详细说明（悬停提示、错误/冲突指引、最近一次提交摘要）。 */
  detail?: string;
  /** 最近一次成功提交或同步的时间戳（ms）。 */
  lastSyncAt?: number;
  /** 最近一次提交的短 hash。 */
  lastCommit?: string;
  /** 最近一次提交说明的首行。 */
  lastMessage?: string;
  /** 是否配置了远端。 */
  hasRemote?: boolean;
}

export interface GitRemoteInfo {
  /** 当前分支名；游离 HEAD 时为 undefined。 */
  branch?: string;
  /** 游离 HEAD。 */
  detached: boolean;
  /** 已配置的上游跟踪分支（如 `origin/main`）。 */
  upstream?: string;
  /** 远端名（优先上游所属远端，其次 `origin`，再次第一个远端）。 */
  remote?: string;
}

export interface GitSyncOptions {
  /** 节流窗口（毫秒），默认 30 秒。 */
  throttleMs?: number;
  /** 忙碌时等待空闲的重试间隔（毫秒），默认 5 秒。 */
  idleRetryMs?: number;
  /** 当前是否有生成/批量任务在跑（忙碌时延后 pull/push 到空闲）。 */
  isBusy?: () => boolean;
  /** 状态变化回调（用于推送到前端）。 */
  onStatus?: (status: GitSyncStatus) => void;
  /** 需要主动弹出提示时回调（冲突、错误、非仓库等）。 */
  onNotify?: (message: string, level: 'info' | 'error') => void;
  /** `pull --rebase` 拉回了远端新提交导致磁盘文件变化时回调（用于刷新界面状态）。 */
  onExternalChange?: () => void;
}

interface GitExecError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

// ---------------------------------------------------------------- 纯函数

/**
 * 解析 `git status --porcelain -uall`（配合 `-c core.quotepath=off`）的输出，返回变更文件路径列表。
 * 注意：不能先对整段输出 `.trim()`，第一行可能以空格开头（如 ` M chapters/001.txt`）。
 */
export function parsePorcelainPaths(out: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }
    const xy = line.slice(0, 2);
    let raw = line.slice(3);
    if ((xy.includes('R') || xy.includes('C')) && raw.includes(' -> ')) {
      raw = raw.slice(raw.lastIndexOf(' -> ') + 4);
    }
    const cleaned = unquoteGitPath(raw).trim();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      files.push(cleaned);
    }
  }
  return files;
}

function unquoteGitPath(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p;
}

/** 构造清晰的中文提交说明，列出改了哪些文件。不带 AI 署名。 */
export function buildCommitMessage(files: readonly string[], trigger: GitSyncTrigger = 'save'): string {
  const prefix = trigger === 'finalize' ? '自动同步（同步章节）' : '自动同步';
  if (files.length === 0) {
    return `${prefix}：更新工程文件`;
  }
  if (files.length <= 3) {
    return `${prefix}：更新 ${files.join('、')}`;
  }
  const head = `${prefix}：更新 ${files.slice(0, 3).join('、')} 等 ${files.length} 个文件`;
  const listed = files.slice(0, 50).map((f) => `- ${f}`);
  if (files.length > 50) {
    listed.push(`- ……其余 ${files.length - 50} 个文件`);
  }
  return `${head}\n\n变更文件：\n${listed.join('\n')}`;
}

/** 将常见 git 报错翻译成简明人话，并区分冲突与普通错误。 */
export function classifyGitError(
  stderr: string,
  phase: 'commit' | 'pull' | 'push'
): { phase: 'conflict' | 'error'; label: string; detail: string } {
  const raw = stderr.trim();
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';

  if (/CONFLICT|could not apply|Merge conflict|rebase in progress|needs merge/i.test(raw)) {
    return {
      phase: 'conflict',
      label: '同步冲突',
      detail: '远端与本地修改冲突，已自动中止变基以保护本地文件（本地提交已保留）。请在终端手动处理冲突后重试。',
    };
  }
  if (/Please tell me who you are|unable to auto-detect email|Author identity unknown/i.test(raw)) {
    return {
      phase: 'error',
      label: '提交失败',
      detail: '未配置 Git 用户名或邮箱，请先运行 git config user.name 与 user.email。',
    };
  }
  if (/Authentication failed|Permission denied|could not read Username|Host key verification failed|terminal prompts disabled/i.test(raw)) {
    return {
      phase: 'error',
      label: phase === 'pull' ? '拉取失败' : '推送失败',
      detail: '远端认证失败，请检查 SSH 密钥或凭据配置（本地提交已保留）。',
    };
  }
  if (/Could not resolve host|Failed to connect|Connection refused|Connection timed out|Network is unreachable|unable to access|timed out|ETIMEDOUT/i.test(raw)) {
    return {
      phase: 'error',
      label: phase === 'pull' ? '拉取失败' : '推送失败',
      detail: '无法连接远端仓库，请检查网络后重试（本地提交已保留）。',
    };
  }
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(raw)) {
    return {
      phase: 'error',
      label: '推送被拒',
      detail: '远端有尚未合并的新提交，请稍后重试或在终端检查冲突（本地提交已保留）。',
    };
  }
  if (/index\.lock|Unable to create .*\.lock/i.test(raw)) {
    return {
      phase: 'error',
      label: '仓库被占用',
      detail: '检测到另一个 Git 进程正在操作该仓库，请稍后重试。',
    };
  }

  const label = phase === 'commit' ? '提交失败' : phase === 'pull' ? '拉取失败' : '推送失败';
  const suffix = phase === 'commit' ? '' : '（本地提交已保留）';
  return {
    phase: 'error',
    label,
    detail: firstLine ? `${label}：${firstLine}${suffix}` : `${label}${suffix}`,
  };
}

// ---------------------------------------------------------------- git 执行

function runGit(cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    if (!env.GIT_SSH_COMMAND) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const gitErr = err as GitExecError;
          gitErr.stdout = stdout;
          gitErr.stderr = stderr;
          reject(gitErr);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

function errorText(err: unknown): string {
  const e = err as GitExecError | undefined;
  if (!e) {
    return '';
  }
  if (e.killed && e.signal) {
    return 'timed out';
  }
  return [e.stderr, e.stdout, e.message].filter((s) => typeof s === 'string' && s.trim()).join('\n');
}

export async function probeGitRepo(root: string): Promise<{ ok: true } | { ok: false; reason: 'notInstalled' | 'notRepo' }> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true' ? { ok: true } : { ok: false, reason: 'notRepo' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { ok: false, reason: code === 'ENOENT' ? 'notInstalled' : 'notRepo' };
  }
}

export async function probeGitRemote(root: string): Promise<GitRemoteInfo> {
  let branch: string | undefined;
  let detached = false;
  try {
    const { stdout } = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
    branch = stdout.trim() || undefined;
  } catch {
    // 可能是游离 HEAD，也可能是尚未有任何提交的新仓库（symbolic-ref 在无提交仓库里仍返回分支名，失败则多半是游离 HEAD）
    try {
      const { stdout } = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const name = stdout.trim();
      if (name === 'HEAD') {
        detached = true;
      } else if (name) {
        branch = name;
      }
    } catch {
      detached = false;
    }
  }

  let upstream: string | undefined;
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    upstream = stdout.trim() || undefined;
  } catch {
    upstream = undefined;
  }

  let remote: string | undefined;
  if (upstream) {
    remote = upstream.split('/')[0];
  } else {
    try {
      const { stdout } = await runGit(root, ['remote']);
      const remotes = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch {
      remote = undefined;
    }
  }

  return { branch, detached, upstream, remote };
}

async function isRebaseInProgress(root: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    try {
      const { stdout } = await runGit(root, ['rev-parse', '--git-path', name]);
      const p = stdout.trim();
      if (!p) {
        continue;
      }
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      await fs.access(abs);
      return true;
    } catch {
      // 不存在
    }
  }
  return false;
}

async function headRev(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', 'HEAD']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function shortHead(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--short', 'HEAD']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function aheadCount(root: string, upstream: string): Promise<number> {
  try {
    const { stdout } = await runGit(root, ['rev-list', '--count', `${upstream}..HEAD`]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function remoteBranchExists(root: string, remote: string, branch: string): Promise<boolean> {
  try {
    await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function defaultThrottleMs(explicit?: number): number {
  if (explicit !== undefined) {
    return Math.max(0, explicit);
  }
  const raw = process.env.NOVELWARDEN_GIT_SYNC_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  return DEFAULT_GIT_SYNC_THROTTLE_MS;
}

function offStatus(): GitSyncStatus {
  return { enabled: false, phase: 'off', label: '已关闭' };
}

// ---------------------------------------------------------------- GitSyncManager

export class GitSyncManager {
  private readonly throttleMs: number;
  private readonly idleRetryMs: number;
  private status: GitSyncStatus = offStatus();
  private enabled = false;
  private running = false;
  private rerunAfterSync = false;
  private pendingPaths = new Set<string>();
  private pendingTrigger: GitSyncTrigger = 'save';
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly project: NovelProject,
    private readonly opts: GitSyncOptions = {}
  ) {
    this.throttleMs = defaultThrottleMs(opts.throttleMs);
    this.idleRetryMs = opts.idleRetryMs ?? DEFAULT_GIT_SYNC_IDLE_RETRY_MS;
  }

  getStatus(): GitSyncStatus {
    return { ...this.status };
  }

  /** 启动时从 `project.json` 读工程级开关；若开启则异步探测仓库与远端状态。 */
  async init(): Promise<GitSyncStatus> {
    const on = (await this.project.isInitialized()) && (await this.project.readGitAutoSync());
    if (this.disposed) {
      return this.getStatus();
    }
    this.enabled = on;
    if (!on) {
      this.setStatus(offStatus());
      return this.getStatus();
    }
    return this.probeInitialStatus(false);
  }

  /** 切换工程级「自动同步」开关并写回 `project.json`。 */
  async setEnabled(enabled: boolean): Promise<GitSyncStatus> {
    if (!(await this.project.isInitialized())) {
      this.opts.onNotify?.('当前目录还不是小说工程，请先初始化小说工程。', 'error');
      this.enabled = false;
      this.setStatus(offStatus());
      return this.getStatus();
    }
    await this.project.setGitAutoSync(enabled);
    if (this.disposed) {
      return this.getStatus();
    }
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimers();
      this.pendingPaths.clear();
      this.rerunAfterSync = false;
      this.setStatus(offStatus());
      log.info('已关闭 Git 自动同步');
      return this.getStatus();
    }
    log.info('已开启 Git 自动同步');
    return this.probeInitialStatus(true);
  }

  /**
   * 收到保存文件或同步章节事件：记录变更并在节流窗口内合并为一次提交与推送。
   * 绝不阻塞调用方。
   */
  notifyChange(trigger: GitSyncTrigger, relPath?: string): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (relPath) {
      this.pendingPaths.add(relPath);
    }
    if (trigger === 'finalize') {
      this.pendingTrigger = 'finalize';
    }
    if (this.running) {
      this.rerunAfterSync = true;
      return;
    }
    this.clearIdleTimer();
    const count = this.pendingPaths.size;
    this.setStatus({
      ...this.status,
      enabled: true,
      phase: 'pending',
      label: '待同步',
      detail: count > 0 ? `已记录 ${count} 处改动，将在节流窗口结束后自动提交` : '已记录改动，将在节流窗口结束后自动提交',
    });
    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = undefined;
        void this.runSync(false);
      }, this.throttleMs);
      this.throttleTimer.unref?.();
    }
  }

  /** 立即执行一次提交与推送（跳过节流等待）。 */
  async syncNow(): Promise<GitSyncStatus> {
    if (!this.enabled || this.disposed) {
      return this.getStatus();
    }
    this.clearTimers();
    return this.runSync(true);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  // ---------------------------------------------------------------- 内部流程

  private async probeInitialStatus(notify: boolean): Promise<GitSyncStatus> {
    const repo = await probeGitRepo(this.project.root);
    if (this.disposed || !this.enabled) {
      return this.getStatus();
    }
    if (!repo.ok) {
      const detail =
        repo.reason === 'notInstalled'
          ? '未检测到 git 命令，无法自动同步。'
          : '当前工程目录不是 Git 仓库，无法自动同步。请先在目录中执行 git init。';
      this.setStatus({
        enabled: true,
        phase: 'notRepo',
        label: repo.reason === 'notInstalled' ? '未安装 Git' : '非 Git 仓库',
        detail,
        hasRemote: false,
      });
      if (notify) {
        this.opts.onNotify?.(detail, 'error');
      }
      return this.getStatus();
    }

    const remote = await probeGitRemote(this.project.root);
    if (this.disposed || !this.enabled) {
      return this.getStatus();
    }
    if (!remote.remote) {
      const detail = '已开启自动同步（当前仓库未配置远端，将仅自动提交到本地）。';
      this.setStatus({
        enabled: true,
        phase: 'localOnly',
        label: '仅本地提交',
        detail,
        hasRemote: false,
      });
      if (notify) {
        this.opts.onNotify?.(detail, 'info');
      }
      return this.getStatus();
    }

    this.setStatus({
      enabled: true,
      phase: 'idle',
      label: '自动同步已开启',
      detail: `远端 ${remote.remote}${remote.branch ? `（分支 ${remote.branch}）` : ''}，保存文件或同步章节后自动提交并推送`,
      hasRemote: true,
    });
    return this.getStatus();
  }

  private async runSync(manual: boolean): Promise<GitSyncStatus> {
    if (this.disposed || !this.enabled) {
      return this.getStatus();
    }
    if (this.running) {
      this.rerunAfterSync = true;
      return this.getStatus();
    }
    this.running = true;
    const prevPhase = this.status.phase;
    const trigger: GitSyncTrigger = manual ? 'manual' : this.pendingTrigger;
    this.pendingPaths.clear();
    this.pendingTrigger = 'save';

    this.setStatus({
      ...this.status,
      enabled: true,
      phase: 'syncing',
      label: '同步中…',
      detail: '正在检查变更并同步到 Git…',
    });

    try {
      // 1. 检查是否为 git 仓库
      const repo = await probeGitRepo(this.project.root);
      if (this.disposed || !this.enabled) {
        return this.getStatus();
      }
      if (!repo.ok) {
        const detail =
          repo.reason === 'notInstalled'
            ? '未检测到 git 命令，无法自动同步。'
            : '当前工程目录不是 Git 仓库，无法自动同步。';
        this.setStatus({
          enabled: true,
          phase: 'notRepo',
          label: repo.reason === 'notInstalled' ? '未安装 Git' : '非 Git 仓库',
          detail,
          hasRemote: false,
        });
        if (manual || prevPhase !== 'notRepo') {
          this.opts.onNotify?.(detail, 'error');
        }
        return this.getStatus();
      }

      // 2. 检查变更并自动 git add -A && git commit
      let committed = false;
      let commitHash = this.status.lastCommit;
      let commitSubject = this.status.lastMessage;

      const statusRes = await runGit(this.project.root, ['status', '--porcelain', '-uall']);
      const changedFiles = parsePorcelainPaths(statusRes.stdout);
      if (changedFiles.length > 0) {
        const message = buildCommitMessage(changedFiles, trigger);
        try {
          await runGit(this.project.root, ['add', '-A']);
          await runGit(this.project.root, ['commit', '-m', message]);
          committed = true;
          commitHash = await shortHead(this.project.root);
          commitSubject = message.split('\n')[0];
          log.info(`已自动提交 ${commitHash ?? ''}`, commitSubject);
        } catch (err) {
          const stderr = errorText(err);
          // 极少数情况下 git add -A 后发现全是已忽略或无实际改动，git commit 返回 nothing to commit
          if (!/nothing to commit|no changes added/i.test(stderr)) {
            const classified = classifyGitError(stderr, 'commit');
            log.error(`Git 自动提交失败：${classified.detail}`, stderr);
            this.setStatus({
              ...this.status,
              enabled: true,
              phase: classified.phase,
              label: classified.label,
              detail: classified.detail,
            });
            this.opts.onNotify?.(classified.detail, 'error');
            return this.getStatus();
          }
        }
      }

      if (this.disposed || !this.enabled) {
        return this.getStatus();
      }

      // 3. 检查远端配置
      const remote = await probeGitRemote(this.project.root);
      if (remote.detached) {
        const detail = committed
          ? `已提交到本地（${commitHash ?? ''}），当前处于游离 HEAD，未推送到远端。`
          : '当前处于游离 HEAD，无法自动推送到远端。';
        this.setStatus({
          enabled: true,
          phase: 'localOnly',
          label: '仅本地提交',
          detail,
          lastSyncAt: committed ? Date.now() : this.status.lastSyncAt,
          lastCommit: commitHash,
          lastMessage: commitSubject,
          hasRemote: !!remote.remote,
        });
        return this.getStatus();
      }

      if (!remote.remote) {
        const detail = committed
          ? `已自动提交到本地仓库（${commitHash ?? ''}，未配置远端，未推送）。`
          : '工作区无新改动（当前仓库未配置远端，仅本地提交）。';
        this.setStatus({
          enabled: true,
          phase: 'localOnly',
          label: '仅本地提交',
          detail,
          lastSyncAt: committed ? Date.now() : this.status.lastSyncAt,
          lastCommit: commitHash,
          lastMessage: commitSubject,
          hasRemote: false,
        });
        return this.getStatus();
      }

      // 4. 配了远端：空闲时先 pull --rebase 再 push
      if (!manual && this.opts.isBusy?.()) {
        const detail = committed
          ? `已提交到本地（${commitHash ?? ''}），当前有任务运行，将在空闲后拉取并推送到远端。`
          : '当前有任务运行，将在空闲后同步远端。';
        this.setStatus({
          enabled: true,
          phase: 'pending',
          label: '等待空闲推送',
          detail,
          lastSyncAt: committed ? Date.now() : this.status.lastSyncAt,
          lastCommit: commitHash,
          lastMessage: commitSubject,
          hasRemote: true,
        });
        this.scheduleIdleRetry();
        return this.getStatus();
      }

      // 若仓库还没有任何提交，无法 pull/push
      const beforeHead = await headRev(this.project.root);
      if (!beforeHead) {
        this.setStatus({
          enabled: true,
          phase: 'idle',
          label: '已就绪',
          detail: '仓库尚无提交，保存改动后将自动首次提交并推送。',
          hasRemote: true,
        });
        return this.getStatus();
      }

      // 4a. pull --rebase
      try {
        if (remote.upstream) {
          await runGit(this.project.root, ['pull', '--rebase'], NETWORK_TIMEOUT_MS);
        } else if (remote.branch) {
          await runGit(this.project.root, ['fetch', remote.remote], NETWORK_TIMEOUT_MS);
          if (await remoteBranchExists(this.project.root, remote.remote, remote.branch)) {
            await runGit(this.project.root, ['pull', '--rebase', remote.remote, remote.branch], NETWORK_TIMEOUT_MS);
          }
        }
      } catch (err) {
        const stderr = errorText(err);
        const rebasing = await isRebaseInProgress(this.project.root);
        const classified = rebasing
          ? {
              phase: 'conflict' as const,
              label: '同步冲突',
              detail: '远端与本地修改冲突，已自动中止变基以保护本地文件（本地提交已保留）。请在终端手动处理冲突后重试。',
            }
          : classifyGitError(stderr, 'pull');

        if (rebasing || classified.phase === 'conflict') {
          try {
            await runGit(this.project.root, ['rebase', '--abort']);
          } catch {
            // 已经不在 rebase 状态时忽略
          }
        }
        log.error(`Git 拉取变基失败：${classified.detail}`, stderr);
        this.setStatus({
          enabled: true,
          phase: classified.phase,
          label: classified.label,
          detail: classified.detail,
          lastSyncAt: committed ? Date.now() : this.status.lastSyncAt,
          lastCommit: commitHash,
          lastMessage: commitSubject,
          hasRemote: true,
        });
        this.opts.onNotify?.(classified.detail, 'error');
        return this.getStatus();
      }

      const afterPullHead = await headRev(this.project.root);
      if (afterPullHead && afterPullHead !== beforeHead) {
        commitHash = (await shortHead(this.project.root)) ?? commitHash;
        this.opts.onExternalChange?.();
      }

      if (this.disposed || !this.enabled) {
        return this.getStatus();
      }

      // 4b. push
      const needPush =
        committed ||
        !remote.upstream ||
        (await aheadCount(this.project.root, remote.upstream)) > 0;

      if (needPush) {
        try {
          const pushArgs = remote.upstream
            ? ['push']
            : remote.branch
              ? ['push', '-u', remote.remote, remote.branch]
              : ['push'];
          await runGit(this.project.root, pushArgs, NETWORK_TIMEOUT_MS);
          log.info(`已推送到远端 ${remote.remote}`, commitHash);
        } catch (err) {
          const stderr = errorText(err);
          const classified = classifyGitError(stderr, 'push');
          log.error(`Git 推送失败：${classified.detail}`, stderr);
          this.setStatus({
            enabled: true,
            phase: classified.phase,
            label: classified.label,
            detail: classified.detail,
            lastSyncAt: committed ? Date.now() : this.status.lastSyncAt,
            lastCommit: commitHash,
            lastMessage: commitSubject,
            hasRemote: true,
          });
          this.opts.onNotify?.(classified.detail, 'error');
          return this.getStatus();
        }
      }

      const finalHash = (await shortHead(this.project.root)) ?? commitHash;
      const now = Date.now();
      this.setStatus({
        enabled: true,
        phase: 'synced',
        label: '已同步',
        detail: commitSubject
          ? `已同步到远端 ${remote.remote}（${finalHash ?? ''}：${commitSubject}）`
          : `已与远端 ${remote.remote} 同步`,
        lastSyncAt: now,
        lastCommit: finalHash,
        lastMessage: commitSubject,
        hasRemote: true,
      });
      return this.getStatus();
    } finally {
      this.running = false;
      if (this.rerunAfterSync && this.enabled && !this.disposed) {
        this.rerunAfterSync = false;
        if (!this.throttleTimer) {
          this.throttleTimer = setTimeout(() => {
            this.throttleTimer = undefined;
            void this.runSync(false);
          }, this.throttleMs);
          this.throttleTimer.unref?.();
        }
      }
    }
  }

  private scheduleIdleRetry(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.runSync(false);
    }, this.idleRetryMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearTimers(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    this.clearIdleTimer();
  }

  private setStatus(next: GitSyncStatus): void {
    this.status = next;
    this.opts.onStatus?.({ ...next });
  }
}
