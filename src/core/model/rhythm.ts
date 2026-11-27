import { hasContent } from './markdown';
import type { HighlightType, RhythmIssue } from './pipeline';
import { sectionItems } from './plotFile';

export { describeRhythmIssue, rhythmTouches } from './pipeline';
export type { RhythmIssue } from './pipeline';

/**
 * 节奏体检（2026-11-27，设计见 docs/design/plans/2026-11-27-rhythm-and-foreshadow.md「一期」）：逐章读细纲的「看点」与「状态变更」，
 * 找出连着几章没有兑现、同一类看点连用、章末没有钩子、这一章什么都没变。
 *
 * - **纯函数、不调模型、不落盘**（第 18 条）：取数在 views/threads.ts，工程页「叙事线」页签、叙事线总览、写前检查共用这一份。
 * - **看点的类型写在每一行行首**（`- 打脸：……`），排细纲与同步的提示词同一句。认不出类型的行照旧是看点，只是不进统计（第 1 条）；
 *   一章一条都认不出就当「不知道」，切断连续——老书、作者手写的细纲不误报。
 * - **只摆给作者看**：调研里 inkos 早期为「伏笔只加不收」加了排期、催收，后来又删了，改成「不要因为章龄制造紧迫感」。这里的结论
 *   只进提醒（零调用、不拦人、不进主按钮，第 20 条），不进任何一步的上下文。
 *
 * 问题的形状与说法（`RhythmIssue`、`describeRhythmIssue`）在 model/pipeline.ts：前端也要（批量写章弹窗、工程页那几行），那个文件零 import。
 */

/** 看点的八种类型。前七种是「兑现」，钩子是章末吊着读者的那一下。 */
export const HIGHLIGHT_TYPES = ['打脸', '逆袭', '收获', '对决', '反转', '揭秘', '情感', '钩子'] as const satisfies readonly HighlightType[];
export type { HighlightType } from './pipeline';

/**
 * 「看点」一行怎么写类型：排细纲（context/prompts.ts 的 `blueprintFormat`）与同步（features/summarizePrompt.ts）同一句，
 * 认法是下面的 {@link highlightTypeOf}。
 */
export const HIGHLIGHT_TYPE_RULE = `每条行首先写类型和冒号（如「- 打脸：……」），类型是${HIGHLIGHT_TYPES.join('、')}之一，照抄这几个字；前七种是兑现，钩子是章末吊着读者的那一下`;

/** 是不是兑现（钩子之外的七种）。 */
export function isPayoffType(type: HighlightType): boolean {
  return type !== '钩子';
}

/**
 * 类型的几种写法（⚑ 自定）。整个词对得上才算（同叙事线的事件类型），模型多半照抄八种之一，别名接住作者手写与模型顺手的说法。
 */
const HIGHLIGHT_ALIASES: ReadonlyMap<string, HighlightType> = new Map<string, HighlightType>([
  ...HIGHLIGHT_TYPES.map((t): [string, HighlightType] => [t, t]),
  ['装逼打脸', '打脸'],
  ['翻盘', '逆袭'],
  ['以弱胜强', '逆袭'],
  ['越级', '逆袭'],
  ['奖励', '收获'],
  ['机缘', '收获'],
  ['高光对决', '对决'],
  ['交锋', '对决'],
  ['逆转', '反转'],
  ['揭开', '揭秘'],
  ['真相', '揭秘'],
  ['掉马', '揭秘'],
  ['身份揭露', '揭秘'],
  ['感情', '情感'],
  ['心动', '情感'],
  ['发糖', '情感'],
  ['章末钩子', '钩子'],
  ['悬念', '钩子'],
  ['卡点', '钩子'],
  ['断章', '钩子'],
]);

/** 行首的类型：`打脸：……`、`打脸:……`、`【打脸】……`、`[打脸]……`。没有分隔的「收获三枚灵石」不认（分不清是不是类型）。 */
const PREFIXED = /^\s*(\S{1,6}?)\s*[：:｜|]/u;
const BRACKETED = /^\s*[【\[]\s*(\S{1,6}?)\s*[】\]]/u;

/** 看点里一条的类型。认不出返回 undefined。 */
export function highlightTypeOf(item: string): HighlightType | undefined {
  const m = BRACKETED.exec(item) ?? PREFIXED.exec(item);
  return m ? HIGHLIGHT_ALIASES.get(m[1]) : undefined;
}

/** 「看点」一节里认得出的类型，按出现的顺序、去重。 */
export function highlightTypesOf(section: string): HighlightType[] {
  const out: HighlightType[] = [];
  for (const item of sectionItems(section)) {
    const type = highlightTypeOf(item);
    if (type && !out.includes(type)) {
      out.push(type);
    }
  }
  return out;
}

/**
 * 阈值（⚑ 作者定的：先写死，同叙事线的 `STALL_CHAPTERS`）。细纲提示词里「每 3–5 章一个小高潮」「同一类看点不连用 3 章以上」
 * 与这里同一组数。
 */
export const RHYTHM_LIMITS = Object.freeze({
  /** 连续这么多章只有钩子、没有兑现。 */
  dry: 5,
  /** 同一种兑现连着这么多章都有。 */
  repeat: 3,
  /** 连续这么多章没有钩子。 */
  noHook: 2,
});

/** 体检要的一章：取数那一半给（views/threads.ts）。 */
export interface RhythmChapter {
  no: number;
  /** 「看点」一节原文。 */
  highlights: string;
  /** 「状态变更」一节原文。 */
  stateChange: string;
  /** 细纲排过没有（「关键事件」有内容，`isPlotFilled`）：只有梗概的空壳不算「什么都没变」。 */
  filled: boolean;
  /** 还是计划：没同步过（细纲没有 `sourceHash`，或正文不在了）。 */
  planned: boolean;
}

/** 「状态变更」写的是「无」：模型没东西写时照合同写「无」，作者偶尔写「没有变化」。 */
const NOTHING_CHANGED = /^(?:无|没有|没有变化|无变化|无明显变化|暂无)[。.！!]?$/u;

/**
 * 全书的节奏问题，按章号排。`chapters` 不必有序、可以缺号；同一个章号给了两次时认第一次（取数那一半已经按路径配好）。
 *
 * 连续性按章号算：缺号、一章没认出类型都切断。`dry`、`noHook`、`repeat` 只看「有类型」的章；`static` 只看排过的细纲。
 */
export function rhythmIssues(chapters: readonly RhythmChapter[]): RhythmIssue[] {
  const byNo = new Map<number, RhythmChapter>();
  for (const c of chapters) {
    if (!byNo.has(c.no)) {
      byNo.set(c.no, c);
    }
  }
  const sorted = [...byNo.values()].sort((a, b) => a.no - b.no);
  const typed = sorted.map((c) => ({ c, types: highlightTypesOf(c.highlights) }));
  const out: RhythmIssue[] = [];

  // 连续的一段（章号挨着、都认得出类型）里，满足 `test` 的最长那几截，够 `min` 章的报出来。
  const runs = (test: (types: HighlightType[]) => boolean, min: number, make: (from: number, to: number, planned: boolean) => RhythmIssue): void => {
    let start = -1;
    const flush = (end: number): void => {
      if (start >= 0 && end - start + 1 >= min) {
        const seg = typed.slice(start, end + 1);
        out.push(make(seg[0].c.no, seg[seg.length - 1].c.no, seg.some((x) => x.c.planned)));
      }
      start = -1;
    };
    typed.forEach((x, i) => {
      const linked = i > 0 && typed[i - 1].c.no === x.c.no - 1 && typed[i - 1].types.length > 0;
      if (x.types.length === 0 || !test(x.types)) {
        flush(i - 1);
        return;
      }
      if (start >= 0 && !linked) {
        flush(i - 1);
      }
      if (start < 0) {
        start = i;
      }
    });
    flush(typed.length - 1);
  };

  runs((types) => !types.some(isPayoffType), RHYTHM_LIMITS.dry, (from, to, planned) => ({ kind: 'dry', from, to, planned }));
  for (const type of HIGHLIGHT_TYPES.filter(isPayoffType)) {
    runs((types) => types.includes(type), RHYTHM_LIMITS.repeat, (from, to, planned) => ({ kind: 'repeat', from, to, type, planned }));
  }
  runs((types) => !types.includes('钩子'), RHYTHM_LIMITS.noHook, (from, to, planned) => ({ kind: 'noHook', from, to, planned }));
  for (const c of sorted) {
    const text = c.stateChange.trim();
    if (c.filled && hasContent(text) && NOTHING_CHANGED.test(text)) {
      out.push({ kind: 'static', from: c.no, to: c.no, planned: c.planned });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

const KIND_ORDER: readonly RhythmIssue['kind'][] = ['dry', 'repeat', 'noHook', 'static'];

/** 总览「看点」那一行一格写的字：第一种兑现的头一个字，只有钩子的写「钩」，认不出类型的给空串。 */
export function highlightGlyph(types: readonly HighlightType[]): string {
  const first = types.find(isPayoffType) ?? types[0];
  return first ? first.slice(0, 1) : '';
}
