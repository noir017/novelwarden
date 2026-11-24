/**
 * 网关落盘的那几个动作：**写、改名、复制、删**。每个都先记账（`journal.ts`：外部 agent 的这一步动了哪份文件、改之前是哪一版），
 * 再动磁盘。
 *
 * `workspace/` 里改作者文件的地方只调这里，不直接调 `fs` 的改盘方法——漏一处，agent 经那条路改的文件就撤销不了，而且
 * 界面上看不出来。`tests/contract/gatewayWrites.test.js` 数着：除了这里、`history.ts`（网关自己的副本）与
 * `checkpoints.ts`（存档点），`workspace/` 下出现直接改盘的 `fs` 调用就红。建目录不算改动（不进账）。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NovelProject } from '../model/project';
import { noteChange, noteMove } from './journal';

/** 写一份文件（字符串按 utf8）。`mkdir`：父目录不在就补齐。`flag` 原样交给 `writeFile`（`wx`：已经有了就失败）。 */
export async function writeOnDisk(
  project: NovelProject,
  abs: string,
  data: string | Buffer,
  opts: { mkdir?: boolean; flag?: string } = {}
): Promise<void> {
  await noteChange(project, abs);
  if (opts.mkdir) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }
  await fs.writeFile(abs, data, typeof data === 'string' ? { encoding: 'utf8', flag: opts.flag } : { flag: opts.flag });
}

/** 改名 / 搬家（一份文件或整个目录），父目录不在就补齐。搬进回收站也是它。 */
export async function renameOnDisk(project: NovelProject, fromAbs: string, toAbs: string): Promise<void> {
  await noteMove(project, fromAbs, toAbs);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
}

/** 复制一份文件，字节原样。`mode` 原样交给 `copyFile`（`COPYFILE_EXCL`：落点已有就失败）。 */
export async function copyOnDisk(project: NovelProject, fromAbs: string, toAbs: string, mode?: number): Promise<void> {
  await noteChange(project, toAbs);
  await fs.copyFile(fromAbs, toAbs, mode);
}

/** 删掉一份文件（网关自己换了文件名、旧名那一份）。作者的文件不走这里删——删除一律进回收站（第 6 条）。 */
export async function unlinkOnDisk(project: NovelProject, abs: string): Promise<void> {
  await noteChange(project, abs);
  await fs.unlink(abs);
}
