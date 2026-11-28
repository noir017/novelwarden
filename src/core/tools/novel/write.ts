/**
 * `write` —— agent 的落盘口。**一次 `ws.write`，没有别的。**
 *
 * ## 这里为什么没有任何保护代码
 *
 * 越界、回收站、大小上限、同名不覆盖、覆盖前审阅、乐观锁——八条守卫全在
 * `workspace/guard.ts` 里做过一次，渲染、`upstreamHash` 记账、
 * 伴生搬迁在 handler 里做过一次。这一层要做的只有三件**属于 agent 的**事：
 *
 * 1. **把 draftId 换成 artifact**（等价于作者在那张落盘卡片上点了「写入」）；
 * 2. **把守卫的结论翻译成模型能照着改的话**（越界了、已存在了、没落盘）；
 * 3. **记账失败**（第 16 条）。
 *
 * 如果哪天要在这里写一段路径检查，说明绕过了 workspace——停下来重想。
 *
 * ## 五条硬约束
 *
 * 1. **`review` 永远 `true`，且不作为工具参数暴露。** 外部 agent 这条路上那一问由宿主替作者答「采纳」并记进这一步的代答
 *    （`host.ts`），改之前那一版由改动账存下——覆盖照样留痕、撤销得了（第 3 / 19 条）。
 * 2. **`draftId` 找不到时 `error`，不静默降级成写空文件。**
 * 3. **draft 没有 `artifact`（讨论这类 text 产出）时 `error`**——
 *    一段批评意见不该被写成一份细纲。
 * 4. **审阅放弃了这次写入 → 明说「没有落盘」**，让它别原地重试（重试同一个
 *    动作是最常见的烧钱方式）。
 * 5. **写失败 `recordFailure` 挂在对应细纲上，成功 `clearFailures`**（第 16 条）。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { clip, describeForReview, describePath, resolveToolPath, text } from './naming';
import { WsError, kindOfPath } from '../../workspace';
import type { PathKind, WriteInput } from '../../workspace';
import type { Artifact } from '../../features/artifact';
import { clearFailures, recordFailure } from '../../runtime/errorLog';
import { countWords } from '../../model/fs';
import { asString, inspectFrontmatter } from '../../model/markdown';
import { describeError } from '../../runtime/logger';

/** 写入模式。与 `WriteOptions.mode` 同一套值，不另造名字。 */
const MODES = ['create', 'overwrite', 'append'] as const;
type WriteMode = (typeof MODES)[number];

/** 失败记录的 op。清记录时按它筛，两处必须一致。 */
export const WRITE_OP = 'mcpWrite';

export const writeTool: ToolDef = {
  name: 'write',
  mutating: true,

  /** 写盘（`mutating`）：不等人点，改之前那一版由改动账存下（`workspace/journal.ts`），作者在对话页上撤销这一步。 */
  intent(args, project): ToolIntent {
    const mode = text(args.mode) || 'create';
    const rawTarget = text(args.path);
    const target = project ? resolveToolPath(project, rawTarget) : rawTarget;
    if (mode === 'overwrite') {
      return { gate: 'mutating', title: `覆盖「${describePath(target, project)}」` };
    }
    return {
      gate: 'mutating',
      title: `写入「${describePath(target, project)}」`,
      detail: `${target}（${mode === 'append' ? '追加到末尾' : '新建'}）`,
    };
  },

  description:
    '把内容写进工程里的一份文件。path 是工程内相对路径、用正斜杠。' +
    '内容有两种给法，二选一：draftId 用 generate 产出的那份草稿（会按该路径应有的格式渲染、' +
    '并记上游指纹，等价于作者在落盘卡片上点了「写入」），content 直接给文本。' +
    'mode=create 新建（目标已存在会报错，这是缺省），mode=overwrite 整份替换，mode=append 追加到末尾。' +
    '写入不等作者确认：改之前的那一版会存下来，作者可以在对话页撤销这一步。' +
    '删除、改名、移动没有对应的工具——那些由作者自己做。',

  parameters: objectSchema(
    {
      path: str('要写的文件，工程内相对路径。'),
      draftId: str('要落盘的那份草稿的 id（generate 的返回值里有）。与 content 二选一。'),
      content: str('直接写进去的文本。与 draftId 二选一。'),
      mode: str(
        '写入方式：create 新建（缺省，已存在会报错）、overwrite 整份替换、append 追加到末尾。',
        [...MODES]
      ),
    },
    ['path']
  ),

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rawRel = typeof args.path === 'string' ? args.path.trim() : '';
    if (!rawRel) {
      return { text: '', error: 'path 是必填的：给一个工程内相对路径。' };
    }
    const rel = resolveToolPath(ctx.project, rawRel);

    const rawMode = typeof args.mode === 'string' ? args.mode.trim() : '';
    if (rawMode && !(MODES as readonly string[]).includes(rawMode)) {
      return { text: '', error: `mode 只能是 ${MODES.join(' / ')}，收到的是「${rawMode}」。` };
    }
    const mode = (rawMode || 'create') as WriteMode;

    const draftId = typeof args.draftId === 'string' ? args.draftId.trim() : '';
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (draftId && content !== undefined) {
      return {
        text: '',
        error: 'draftId 与 content 只能给一个：给了 draftId 就写那份草稿，给了 content 就写这段文本。',
      };
    }
    if (!draftId && content === undefined) {
      return {
        text: '',
        error:
          '没有要写的内容：给 draftId（落盘 generate 产出的草稿）或者给 content（直接写文本）。',
      };
    }

    // ---- draftId → artifact。找不到、或者是讨论类产出，一律不写。
    let words: number;
    let input: WriteInput;
    if (draftId) {
      const draft = ctx.drafts.get(draftId);
      if (!draft) {
        return {
          text: '',
          error:
            `没有 draftId 为 ${draftId} 的草稿。它可能来自更早的轮次、已经被挤掉了。` +
            '重新 generate 一份再写，或者直接用 content 给文本。',
        };
      }
      const artifact = artifactOf(draft);
      if (!artifact) {
        return {
          text: '',
          error:
            `${draftId} 那次是讨论类产出，没有可落盘的结构化产物，不能写成一份产物。` +
            '结论说给作者听就行；要落盘得先用 capability=generate 生成一份真正的产物。',
        };
      }
      input = { artifact };
      words = draft.words;
    } else {
      input = { text: content! };
      words = countWords(content!);
    }

    const path = kindOfPath(ctx.project, rel);
    if (
      !draftId &&
      (mode === 'create' || mode === 'overwrite') &&
      (path.kind === 'character' || path.kind === 'lore')
    ) {
      const fmError = validateCardFrontmatter(path.kind, content!);
      if (fmError) {
        return { text: '', error: fmError };
      }
    }
    const what = describeForReview(path, rel);

    try {
      const r = await ctx.workspace.write(rel, input, {
        // ★ 恒为 true。不接受参数，模型没有关掉它的口子。
        review: true,
        mode,
        what,
      });

      if (r.skipped) {
        // 覆盖审阅放弃了这次写入（外部 agent 这条路上替作者答「采纳」，走到这里是宿主交回了取消）。**说清楚**，否则它会原地重试。
        return {
          text: `这次写入没有落盘（${what}，${r.rel}），磁盘上那份一字未改。不要原样重试——先 read 看看现在的内容。`,
          display: { title: `write ${r.rel}`, detail: '未落盘' },
        };
      }

      await clearFailure(ctx, path);
      const side = r.side && r.side.length > 0 ? `\n连带：${r.side.join('；')}` : '';
      return {
        text: `已写入 ${r.rel}（${words} 字，${MODE_LABEL[mode]}）${side}`,
        display: { title: `write ${r.rel}`, detail: `${MODE_LABEL[mode]} · ${words} 字` },
      };
    } catch (err) {
      const message = describe(err, rel, mode);
      await noteFailure(ctx, path, `写入 ${rel} 失败：${message}`);
      return { text: '', error: message };
    }
  },
};

const MODE_LABEL: Record<WriteMode, string> = {
  create: '新建',
  overwrite: '覆盖',
  append: '追加',
};

/** draft 上那份结构化产物。讨论（唯一的 text 类能力）没有。 */
function artifactOf(draft: { artifact?: unknown }): Artifact | undefined {
  return draft.artifact as Artifact | undefined;
}

/**
 * 异常 → 一句模型能照着改的话。
 *
 * `WsError` 的 message 本来就是人话，原样转述再补一句「那接下来该怎么办」——
 * 「已存在」这一条尤其要指路，否则它会换十个文件名继续试。
 */
function describe(err: unknown, rel: string, mode: WriteMode): string {
  if (err instanceof WsError) {
    switch (err.code) {
      case 'exists':
        return (
          `${err.message}。要替换它就用 mode=overwrite（改之前那一版会存下，作者可以撤销）；` +
          '要接在后面写用 mode=append。'
        );
      case 'outOfRoot':
        return `${err.message}。只能写工程目录之内的相对路径，不要用绝对路径或 ../。`;
      case 'protected':
      case 'inTrash':
        return err.message;
      case 'tooLarge':
        return `${err.message} 分几次写，或者只改需要改的那一段（用 edit）。`;
      default:
        return err.message;
    }
  }
  return `写 ${rel} 失败（${MODE_LABEL[mode]}）：${describeError(err)}`;
}

/**
 * 失败挂在**细纲**上（工程页那一行）——与 `generation/generate.ts` 同一套
 * 归属规则。不属于任何一章的产物（大纲、角色卡）只进日志。
 */
async function noteFailure(ctx: ToolContext, path: PathKind, message: string): Promise<void> {
  const plotRelPath = path.plotRelPath;
  if (!plotRelPath) {
    return;
  }
  await recordFailure(ctx.project, {
    scope: 'MCP',
    targetKind: 'plot',
    targetKey: plotRelPath,
    severity: 'error',
    op: WRITE_OP,
    message,
    detail: '这一次写入没有落盘，磁盘上那份未改动。',
  });
}

async function clearFailure(ctx: ToolContext, path: PathKind): Promise<void> {
  if (path.plotRelPath) {
    await clearFailures(ctx.project, 'plot', path.plotRelPath, WRITE_OP);
  }
}

const HEADING_FM_RE = /^#{1,3}\s+(?:name|title)\s*:/i;
const SQUASHED_NO_FENCE_RE =
  /^(?:name|title)\s*:\s*.*\s+(?:name|title|aliases|tags|gender|firstAppear|lastSeen|appearsIn|keywords|brief)\s*:/i;
const SQUASHED_FIELD_RE =
  /\s+(?:name|title|aliases|tags|gender|firstAppear|lastSeen|appearsIn|updatedThrough|stateThrough|stateHash|keywords|brief|bodyHash)\s*:/;

/**
 * 角色卡 / 设定条目的 YAML frontmatter 轻量前置校验（供 `write` 纯文本新建/覆盖使用）。
 *
 * 复用 `model/markdown.ts` 的 `inspectFrontmatter` 与 `asString`，只拦截明显损坏的 frontmatter
 * （未闭合 `---`、压成标题行或单行、非法断行、数组未闭合、角色卡缺有效 `name`），
 * 遵循第 1 条容错精神：不带 frontmatter 的合法手写 Markdown 卡片照常放行。
 */
export function validateCardFrontmatter(kind: 'character' | 'lore', content: string): string | undefined {
  const label = kind === 'character' ? '角色卡' : '设定条目';
  const example =
    kind === 'character'
      ? '---\nname: 角色名\naliases: []\ntags: []\n---'
      : '---\ntitle: 设定名\nkeywords: []\n---';

  const normalized = content.replace(/^\uFEFF/, '');
  const firstLine = normalized.trimStart().split(/\r?\n/, 1)[0] ?? '';

  if (HEADING_FM_RE.test(firstLine)) {
    return (
      `${label}的 YAML frontmatter 被压成了标题行（${clip(firstLine, 60)}），未落盘。` +
      `请用单独的 --- 包裹并逐行写字段，例如：\n${example}`
    );
  }

  const inspected = inspectFrontmatter(normalized);
  if (inspected.brokenFence) {
    if (inspected.brokenFence === 'inlineOpen') {
      return (
        `${label}的 YAML frontmatter 开头 --- 必须单独占一行，不要把字段和 --- 写在同一行（${clip(firstLine, 60)}），未落盘。` +
        `正确写法：\n${example}`
      );
    }
    if (inspected.brokenFence === 'leadingSpace') {
      return `${label}的 YAML frontmatter 开头 --- 必须在文件第一行，前面不要留空行或空格，未落盘。`;
    }
    return (
      `${label}的 YAML frontmatter 开头 --- 没有成对闭合，未落盘。` +
      `请在元数据末尾单独加一行 ---，再接正文，例如：\n${example}`
    );
  }

  if (!inspected.hasFence) {
    if (SQUASHED_NO_FENCE_RE.test(firstLine)) {
      return (
        `${label}的 YAML frontmatter 缺少 --- 包裹且多个字段被压在同一行（${clip(firstLine, 60)}），未落盘。` +
        `请改写成：\n${example}`
      );
    }
    return undefined;
  }

  if (inspected.unclosedArrays.length > 0) {
    const first = inspected.unclosedArrays[0];
    return (
      `${label}的 YAML frontmatter 中「${first.key}」的数组未闭合（${clip(first.line, 60)}），未落盘。` +
      `行内数组请写在同一行「${first.key}: [甲, 乙]」，或改用多行「- 项」写法。`
    );
  }

  if (inspected.invalidLines.length > 0) {
    const first = inspected.invalidLines[0];
    return (
      `${label}的 YAML frontmatter 中存在无法解析的行（可能是非法断行或缺少冒号）：「${clip(first, 60)}」，未落盘。` +
      '每行应为「键: 值」格式，或接在空值键后的「- 列表项」。'
    );
  }

  for (const entry of inspected.entries) {
    const v = entry.rawValue;
    const quoted =
      v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
    if (!quoted && SQUASHED_FIELD_RE.test(v)) {
      return (
        `${label}的 YAML frontmatter 中多个字段被压在同一行（「${clip(entry.line, 60)}」），未落盘。` +
        '请将每个「键: 值」拆成单独一行。'
      );
    }
  }

  if (kind === 'character' && !asString(inspected.frontmatter.name).trim()) {
    return (
      `${label}的 YAML frontmatter 中缺少有效的 name 字段，未落盘。` +
      `请在 --- 之间写明角色名，例如：\n${example}`
    );
  }

  if (kind === 'lore' && 'title' in inspected.frontmatter && !asString(inspected.frontmatter.title).trim()) {
    return (
      `${label}的 YAML frontmatter 中 title 不能为空，未落盘。` +
      `请在 --- 之间写明设定标题，例如：\n${example}`
    );
  }

  return undefined;
}
