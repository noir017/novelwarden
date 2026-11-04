import * as path from 'node:path';
import { NON_CHAPTER_EXTENSIONS } from './model/chapterFile';
import { LEGACY_NOVEL_DIRS, NOVEL_DIR } from './model/project';
import { NovelConfig } from './model/types';

/**
 * 「工程里哪些改动值得刷新界面」——**策略**在这里，**机制**在壳里。
 *
 * 两个壳的监听机制天差地别（插件用 VS Code 的 FileSystemWatcher 吃 glob，
 * 独立版用 `fs.watch` 吃事件流），但要看的是同一批东西：章节根、草稿目录、
 * 元数据目录（`.novelwarden/`，旧工程是 `.novelforge/` / `.novel/`）。这份知识属于 core——
 * 章节能是什么扩展名、草稿在哪、哪些目录算元数据，都是 core 定义的规则，壳照抄一遍就会跟着规则变化一起腐烂。
 */

/** 元数据目录名，从新到旧。旧工程没迁移时数据在旧目录里，三处都要看。 */
const METADATA_DIRS = [NOVEL_DIR, ...LEGACY_NOVEL_DIRS];

/**
 * 给吃 glob 的宿主用的模式清单（相对工程根）。
 *
 * 三处不显然的地方：
 * - `${chaptersDir}/**` 是**全量**的，不是 `**\/*.md`：目录本身的增删要看得见
 *   （工程页上文件夹是可见节点，新建空文件夹不动任何 .md），顺带也覆盖了非 .md
 *   的章节（.txt / 无扩展名 / .json），所以章节扩展名放宽不需要在这里加模式。
 * - 草稿目录也要监听：手工建的草稿也该让工程页上的「有草稿」标记翻过来。
 * - `<元数据目录>/characters/**` 与 `lore/**`（旧工程同理，三处元数据目录都出）用全量而不是 `*.md`：
 *   那两个区允许子目录收纳。
 */
export function watchGlobs(config: NovelConfig): string[] {
  return [
    `${config.chaptersDir}/**/*.md`,
    ...METADATA_DIRS.flatMap((dir) => [
      `${dir}/**/*.md`,
      `${dir}/project.json`,
      `${dir}/characters/**`,
      `${dir}/lore/**`,
    ]),
    `${config.chaptersDir}/**`,
    `${config.draftsDir}/**`,
  ];
}

/** 元数据目录的哪个子目录（相对、绝对路径都认）。新旧目录名都算。 */
function metadataSubdirRe(sub: string): RegExp {
  return new RegExp(`(^|/)\\.(?:novelwarden|novelforge|novel)/${sub}(/|$)`);
}

/** `.novelwarden/history`（旧工程 `.novelforge/history` 等）本身或它下面的任何东西。 */
const HISTORY_RE = metadataSubdirRe('history');
/** 存档点目录同上。 */
const CHECKPOINTS_RE = metadataSubdirRe('checkpoints');

/**
 * 给吃事件流的宿主用的过滤：这条变更该不该忽略。
 *
 * 用**黑名单**而不是白名单：章节可以是 `.txt`、可以没有扩展名，目录事件也没有
 * 扩展名——白名单式过滤会让这些改动看不见。放行面因此偏宽，调用方要自己去抖
 * （一次 onChange 会触发全量重扫）。
 *
 * @param name 事件带回来的路径或文件名（相对、绝对都行；`fs.watch` 给的是相对）
 */
export function shouldIgnoreChange(name: string): boolean {
  if (!name) {
    return false;
  }
  // 依赖目录与回收站里的动静与工程内容无关。回收站尤其要挡：删除是「搬进
  // .trash/」，不挡的话每次删除都会多触发一轮重扫。
  if (name.includes('node_modules') || name.includes('.trash')) {
    return true;
  }
  // 历史版本同理：网关每覆盖一份产物就先往 `<元数据目录>/history/` 存一版（workspace/history.ts），
  // 不挡的话每存一个快照就多一轮全量重扫。插件壳那边快照是 `.txt`，`watchGlobs` 本来就扫不到。
  // 存档点（workspace/checkpoints.ts）一次存几十上百个对象，更要挡。
  const posix = name.replace(/\\/g, '/');
  if (HISTORY_RE.test(posix) || CHECKPOINTS_RE.test(posix)) {
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  return ext !== '' && NON_CHAPTER_EXTENSIONS.has(ext);
}
