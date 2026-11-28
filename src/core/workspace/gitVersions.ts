/**
 * 「版本」时间线上的第三个来源：工程在 git 仓库里时，这份文件**被提交过的各版**。只读——`git log` 与 `git cat-file`，
 * 不写 `.git`（`GIT_OPTIONAL_LOCKS=0`，连索引的顺手刷新都不做），也不碰工作区；仓库由谁、怎么提交与这里无关。
 *
 * - **一次 log、一次 cat-file**：`git log --follow --raw -z` 拿到每次提交里这份文件的 blob（改名也跟得过去：按 blob 读，
 *   不按当时的路径），再把这些 blob 一次喂给 `cat-file --batch` 读全文、算字数。最多 {@link GIT_LOG_LIMIT} 次提交。
 * - **连着几次一字没变的只列最早那一次**（纯改名、只改了别的文件的合并……），与存档点那几行同一个口径。
 * - **没有就是没有**：不是 git 仓库、机器上没装 git（手机上的内置服务）、仓库不认这个目录（`safe.directory`）、文件没提交过、
 *   超时……一律当没有这一来源，只记一条 debug，时间线照样列快照与存档点（第 1 条）。
 * - **读一版只认这份文件历史上的 blob**：id 是 `git:<提交>:<blob>`，前端传上来的；读之前核对它确实在这份文件的提交历史里
 *   （上一次列出来的记着，不在就重列一次），不让一个 id 读出仓库里别的文件（第 7 条：工程根可能只是大仓库里的一个子目录）。
 * - 超过 2 MB 的那一版不列（与历史版本、存档点一样不收）；路径按字面传（`--literal-pathspecs`），文件名里的 `*` `?` 不当通配。
 */
import { execFile } from 'node:child_process';
import { countWords } from '../model/fs';
import { decodeFileText } from '../model/importText';
import type { NovelProject } from '../model/project';
import { scoped } from '../runtime/logger';
import { MAX_EDITABLE_BYTES, WsError } from './guard';
import { normalizeRel } from './kind';

const log = scoped('历史版本');

/** git 那几行的 id 前缀：`git:<提交>:<blob>`。快照的 id 是文件名、存档点是 `cp:`，不会撞。 */
export const GIT_VERSION_PREFIX = 'git:';
/** 最多往回看几次提交。 */
export const GIT_LOG_LIMIT = 30;
/** 一次 git 调用最多等多久。 */
const GIT_TIMEOUT_MS = 10_000;
/** cat-file 一次读回来的上限：{@link GIT_LOG_LIMIT} 版、每版至多 2 MB。 */
const GIT_MAX_BUFFER = GIT_LOG_LIMIT * MAX_EDITABLE_BYTES + 1024 * 1024;

export interface GitVersionInfo {
  /** `git:<提交>:<blob>`。 */
  id: string;
  /** 提交时间（毫秒时间戳，committer time）。 */
  time: number;
  words: number;
  bytes: number;
  commit: string;
  subject: string;
  author: string;
}

/** `git log` 里这份文件的一次提交。 */
export interface GitLogEntry {
  commit: string;
  time: number;
  author: string;
  subject: string;
  /** 这次提交之后这份文件的 blob。 */
  blob: string;
}

const HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ZERO = /^0+$/;
const LOG_FORMAT = '%x1e%H%x1f%ct%x1f%an%x1f%s';

// ---------------------------------------------------------------- 纯函数

/**
 * 读 `git log -z --raw --no-abbrev --format=<LOG_FORMAT>` 的输出：每次提交一条，新的在前。合并提交（没有 raw 那一行）、
 * 这次提交把它删了的（新 blob 全零）不收；读不懂的那一条跳过（第 1 条）。
 */
export function parseGitLog(out: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const chunk of out.split('\x1e')) {
    const end = chunk.indexOf('\0');
    if (end < 0) {
      continue;
    }
    const [commit, ct, author = '', subject = ''] = chunk.slice(0, end).split('\x1f');
    const time = Number(ct) * 1000;
    if (!HEX.test(commit ?? '') || !Number.isFinite(time)) {
      continue;
    }
    // raw 那一段：「:<旧模式> <新模式> <旧 blob> <新 blob> <状态>」\0 路径 \0（改名、复制再多一个路径）。只要第一条的新 blob。
    const meta = chunk
      .slice(end + 1)
      .split('\0')
      .map((s) => s.trim())
      .find((s) => s.startsWith(':'));
    const blob = meta?.split(' ')[3];
    if (!blob || !HEX.test(blob) || ZERO.test(blob)) {
      continue;
    }
    entries.push({ commit, time, author, subject, blob });
  }
  return entries;
}

/** 连着几次 blob 一样的只留最早那一次（列表新的在前，留一段里的最后一条）。 */
export function dedupeGitLog(entries: readonly GitLogEntry[]): GitLogEntry[] {
  return entries.filter((e, i) => entries[i + 1]?.blob !== e.blob);
}

/**
 * 读 `git cat-file --batch` 的输出：`<sha> blob <字节数>\n<内容>\n` 一条接一条；缺了的那一条是 `<sha> missing\n`。
 * 读不懂就停在那里，前面读到的照给。
 */
export function parseCatFileBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) {
      break;
    }
    const [sha, type, size] = buf.toString('utf8', pos, nl).split(' ');
    pos = nl + 1;
    if (type === 'missing' || size === undefined) {
      continue;
    }
    const n = Number(size);
    if (!Number.isInteger(n) || n < 0 || pos + n > buf.length) {
      break;
    }
    if (type === 'blob') {
      out.set(sha, buf.subarray(pos, pos + n));
    }
    pos += n + 1;
  }
  return out;
}

/** `git:<提交>:<blob>` → 两段；认不出给 undefined。 */
export function parseGitVersionId(id: string): { commit: string; blob: string } | undefined {
  if (!id.startsWith(GIT_VERSION_PREFIX)) {
    return undefined;
  }
  const [commit, blob, ...rest] = id.slice(GIT_VERSION_PREFIX.length).split(':');
  return rest.length === 0 && HEX.test(commit ?? '') && HEX.test(blob ?? '') ? { commit, blob } : undefined;
}

// ---------------------------------------------------------------- 跑 git

function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', '--literal-pathspecs', ...args],
      {
        cwd,
        encoding: 'buffer',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** 上一次列出来的每份文件的 id（读一版之前核对用）。键：工程根 + 相对路径。 */
const known = new Map<string, Set<string>>();
const KNOWN_MAX = 200;

function remember(key: string, ids: Set<string>): void {
  known.delete(key);
  known.set(key, ids);
  if (known.size > KNOWN_MAX) {
    known.delete(known.keys().next().value!);
  }
}

/**
 * 这份文件在 git 里被提交过的各版，新的在前。没有这一来源（不是仓库、没装 git、没提交过、出错）给空数组，**不抛**。
 * 调用方先判过 `historyUnavailable`（只给创作产物列）。
 */
export async function listGitVersions(project: NovelProject, rel: string): Promise<GitVersionInfo[]> {
  const normalized = normalizeRel(rel);
  if (normalized === undefined) {
    return [];
  }
  const key = `${project.root}\0${normalized}`;
  try {
    const out = await git(project.root, [
      'log',
      '-z',
      '--follow',
      '--raw',
      '--no-abbrev',
      '--no-color',
      `--format=${LOG_FORMAT}`,
      '-n',
      String(GIT_LOG_LIMIT),
      '--',
      normalized,
    ]);
    const entries = dedupeGitLog(parseGitLog(out.toString('utf8')));
    if (entries.length === 0) {
      remember(key, new Set());
      return [];
    }
    const blobs = parseCatFileBatch(await git(project.root, ['cat-file', '--batch'], `${[...new Set(entries.map((e) => e.blob))].join('\n')}\n`));
    const versions: GitVersionInfo[] = [];
    for (const e of entries) {
      const buf = blobs.get(e.blob);
      if (!buf || buf.length > MAX_EDITABLE_BYTES) {
        continue;
      }
      versions.push({
        id: `${GIT_VERSION_PREFIX}${e.commit}:${e.blob}`,
        time: e.time,
        words: countWords(decodeFileText(buf)),
        bytes: buf.length,
        commit: e.commit,
        subject: e.subject,
        author: e.author,
      });
    }
    remember(key, new Set(versions.map((v) => v.id)));
    return versions;
  } catch (err) {
    // 不是仓库（128）、没装 git（ENOENT）、超时……都是「没有这一来源」。
    const e = err as NodeJS.ErrnoException & { code?: unknown; stderr?: Buffer };
    log.debug(`没有 ${normalized} 的 git 历史`, String(e.stderr?.toString('utf8').trim() || e.code || e.message));
    remember(key, new Set());
    return [];
  }
}

/** 读某一版 git 里的全文。id 不在这份文件的提交历史里、读不到，抛 `WsError('notFound')`。 */
export async function readGitVersion(project: NovelProject, rel: string, id: string): Promise<string> {
  const parsed = parseGitVersionId(id);
  const normalized = normalizeRel(rel);
  if (!parsed || normalized === undefined) {
    throw new WsError('notFound', `找不到这一版：${id}`);
  }
  const key = `${project.root}\0${normalized}`;
  if (!known.get(key)?.has(id)) {
    await listGitVersions(project, normalized);
  }
  if (!known.get(key)?.has(id)) {
    throw new WsError('notFound', `这一版不在这份文件的 git 历史里：${parsed.commit.slice(0, 7)}`);
  }
  let buf: Buffer | undefined;
  try {
    buf = parseCatFileBatch(await git(project.root, ['cat-file', '--batch'], `${parsed.blob}\n`)).get(parsed.blob);
  } catch {
    buf = undefined;
  }
  if (!buf) {
    throw new WsError('notFound', `git 里读不到这一版：${parsed.commit.slice(0, 7)}`);
  }
  return decodeFileText(buf);
}
