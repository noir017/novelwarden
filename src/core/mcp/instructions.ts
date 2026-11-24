/**
 * MCP 那一头的说明：`initialize` 回给客户端的 `instructions`。宿主把它放进外部 agent 的
 * 上下文，**只说怎么用这几个工具**——领域知识（细纲写到什么程度、看点怎么留）在
 * `context/prompts.ts`，由 `generate` 内部那次调用自己带着，这里不写第二份。
 */
export const MCP_INSTRUCTIONS = [
  'Novelwarden 是作者本人的小说创作工具。这几个工具读写的是他此刻在 Novelwarden 里打开的那个小说工程。',
  '',
  '- 工程就是一堆 Markdown：.novelwarden/ 下是架构（config.md / premise.md / world.md）、情节大纲（outline.md——磁盘上没有这份文件，它是各章细纲「梗概」的汇总，读写照样认这个路径，写回时按章号拆进各章细纲）、' +
    '细纲（summaries/ 下，一章一份，与正文同样的相对路径，如 summaries/上部/003-夜访.md；同步会照正文改它）；正文在 chapters/（可以分子目录）。先 list / read / search 看清楚再动手。',
  '- 要产出内容用 generate：它在 Novelwarden 内部按分阶段装配好的上下文调创作模型。正文直接流给作者看，**不会回到你这里**；' +
    '产出直接落盘，落到哪写在返回里。不要自己拼一份内容用 write 代替 generate——创作质量来自那一层的装配。',
  '- 连续多章（补架构、排细纲、写正文）用 pipeline 的批量动作，不要循环调 generate；同步与全文大纲在 summary，角色卡在 characters，' +
    '设定条目（记设定、建条目、整合）在 lore，文风 / 叙事线在 extract，导入原稿与拆书在 book，写作技能在 skills。这些是 Novelwarden 工程页上那些按钮背后的同一个函数。',
  '- 工具结果末尾有时附一段「# 当前工程」：那是 Novelwarden 状态机算出的下一步，与界面上的主按钮是同一句话。' +
    '照它走，不要另做判断；它变了才会再出现。',
  '- 动手的工具不等作者确认：途中的确认（预计调用几次模型、覆盖已有内容……）按缺省作答，每份文件改之前的那一版都会存下，' +
    '作者可以在 Novelwarden 里撤销这一步。改了哪些文件、答了什么附在结果末尾，据此核对，不要重复同一个动作。',
  '- 没有删除、改名、移动，也不做审稿与修稿——那些由作者自己在 Novelwarden 里做。',
].join('\n');
