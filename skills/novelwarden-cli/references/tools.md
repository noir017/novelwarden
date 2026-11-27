<!-- 由 scripts/gen-cli-skill.js 从 src/core/tools/novel/ 自动生成，勿手改。 -->

# Novelwarden CLI 工具参数参考

## `list`（只读）

列出工程里某个目录的直接子项（不递归），带类型与字数。path 是工程内相对路径、用正斜杠，留空则列工程根。几个固定位置：小说配置、故事前提、世界观是 .novelwarden/config.md、premise.md、world.md，情节大纲是 .novelwarden/outline.md（磁盘上没有这份文件，list 列不出来：它是各章细纲「梗概」的汇总，read / write 照样认这个路径，写回时按章号拆进各章细纲），细纲在 .novelwarden/summaries/（一章一份，与正文同样的相对路径、扩展名 .md：chapters/上部/003-夜访.txt 的细纲是 .novelwarden/summaries/上部/003-夜访.md；同步会照正文改它），正文在章节根目录（默认 chapters/，可以分子目录），全文大纲是 .novelwarden/summaries/global.md，角色卡在 .novelwarden/characters/，设定在 .novelwarden/lore/，叙事线（剧情线，一条线一个文件，伏笔挂在线下，可选）在 .novelwarden/threads/，挂不上线的伏笔在 .novelwarden/threads/未归属的伏笔.md。一次最多返回 60 项，超出会截断并告诉你还有多少。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 否 | 要列的目录，工程内相对路径。留空列工程根。 |

```sh
novelwarden mcp list
```

## `read`（只读）

读一份文件的内容，返回带行号的文本。path 是工程内相对路径、用正斜杠。一次最多返回 400 行或 20000 字符（取先到的），截断时会告诉你还剩多少行，用 offset 接着读下一段。offset 是起始行号（从 1 开始），limit 是最多读几行。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 要读的文件，工程内相对路径。 |
| `offset` | integer | 否 | 从第几行开始读，从 1 开始。留空从头读。 |
| `limit` | integer | 否 | 最多读几行。留空按上限 400 行。 |

```sh
novelwarden mcp read --path .novelwarden/premise.md
```

## `search`（只读）

在工程里全文检索，返回命中的行（带路径与行号），**按章号升序**。默认按字面量搜（作者搜的多半是人名地名），regex=true 才当正则。path 可限定目录，kinds 可限定产物种类（setting=小说配置 / 故事前提 / 世界观，plot=细纲（情节大纲就是各章细纲的「梗概」，搜它就搜到了），chapter=正文，character=角色卡，lore=设定，style=文风指南，globalSummary=全文大纲，threads=叙事线（.novelwarden/threads/ 下一条线一个文件），draft=章节草稿）。一次最多返回 40 条、每个文件最多 4 条；有命中因为超上限被丢掉时会明确告诉你丢了几条——那时不要断言「全书只有这几处」。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | string | 是 | 要找的字符串（或正则）。 |
| `path` | string | 否 | 限定在这个目录下搜，工程内相对路径。留空搜全工程。 |
| `kinds` | string[] | 否 | 限定产物种类，可多个。可用值：setting / style / globalSummary / threads / skill / plot / chapter / draft / character / lore / other。 |
| `regex` | boolean | 否 | 把 pattern 当正则。缺省 false（按字面量搜）。 |
| `limit` | integer | 否 | 最多返回几条，上限 40。 |

```sh
novelwarden mcp search --pattern "<值>"
```

## `generate`（写盘·调模型）

调用创作模型，为某一份产物生成内容。target 是那份产物的工程内相对路径，层由路径决定：.novelwarden/config.md、premise.md、world.md 是架构层，角色图谱给角色目录 .novelwarden/characters 本身（一次排出一批角色卡），设定清单给设定目录 .novelwarden/lore 本身（一次排一批设定条目），展开一条设定给那一条条目的路径（.novelwarden/lore/ 下的 .md，如 .novelwarden/lore/宗门/天机阁.md：照已排的细纲把它往前想细，可能建议拆出几条空条目），.novelwarden/outline.md 是大纲层（各章细纲「梗概」的汇总，采纳时按章号写回各章细纲），.novelwarden/summaries/ 下的细纲是细纲层（一章一份，与正文同样的相对路径、扩展名 .md，如 .novelwarden/summaries/上部/003-夜访.md），正文层给那一章的章节路径（chapters/ 下，可以在子目录里；还没写过的章写成 chapters/<章号>.md 即可，按章号认到这一章的细纲）。**细纲路径永远是细纲层**，要写正文不要给细纲路径。这一章已经有正文时用 writeMode 说清是接着写（continue）还是整章重写（rewrite，缺省）。各层可用的 capability 不同：setting=discuss/generate；outline=discuss/generate；plot=discuss/settle/generate；manuscript=discuss/generate（审稿只能由作者在对话页发起，这个工具不做）。**返回的只有形状与 draftId，没有正文**——正文会直接流给作者看；你要看内容就等它落盘之后再 read。产出直接落盘（改之前那一版会存下，作者可以撤销），落到哪写在返回里；不必也不要再用 write 写同一份。这个工具会真的调模型花钱，每次调用都会记账，不要重复生成同一份东西。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | string | 是 | 要生成的那份产物的工程内相对路径。 |
| `capability` | `discuss` \| `generate` \| `settle` \| `review` | 是 | 要它干什么。discuss=讨论，generate=生成，settle=落定 |
| `ask` | string | 否 | 补充要求，可留空。留空时按上一层的产物照常生成。 |
| `targetWords` | integer | 否 | 目标字数，只对正文层有意义。留空取细纲的目标字数，再没有取小说配置的每章字数；不到八成会自动续写。 |
| `writeMode` | `continue` \| `rewrite` | 否 | 正文层这一章已经有字时怎么写，其余层不认：continue=接着已有的正文往下写，落盘时追加到末尾；rewrite=整章重写，落盘时覆盖（作者会先逐行对比）。缺省 rewrite。这一章还没有正文时两者一样，就是从头写。 |

```sh
novelwarden mcp generate --target .novelwarden/premise.md --capability discuss
```

## `write`（写盘）

把内容写进工程里的一份文件。path 是工程内相对路径、用正斜杠。内容有两种给法，二选一：draftId 用 generate 产出的那份草稿（会按该路径应有的格式渲染、并记上游指纹，等价于作者在落盘卡片上点了「写入」），content 直接给文本。mode=create 新建（目标已存在会报错，这是缺省），mode=overwrite 整份替换，mode=append 追加到末尾。写入不等作者确认：改之前的那一版会存下来，作者可以在对话页撤销这一步。删除、改名、移动没有对应的工具——那些由作者自己做。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 要写的文件，工程内相对路径。 |
| `draftId` | string | 否 | 要落盘的那份草稿的 id（generate 的返回值里有）。与 content 二选一。 |
| `content` | string | 否 | 直接写进去的文本。与 draftId 二选一。 |
| `mode` | `create` \| `overwrite` \| `append` | 否 | 写入方式：create 新建（缺省，已存在会报错）、overwrite 整份替换、append 追加到末尾。 |

```sh
novelwarden mcp write --path .novelwarden/premise.md
```

## `edit`（写盘）

把一份文件里的一段文字换成另一段。path 是工程内相对路径、用正斜杠。old 必须与文件里的现有内容**逐字相同**（含标点与空格），并且在这份文件里**唯一**——命中多处会报错并告诉你几处，这时把 old 写长一点（带上前后文）让它唯一，或者传 all=true 全部替换。改一个名字、修一句话、调一个数字用它，比重新 generate 整份产物省得多。拿不准现在写的是什么就先 read 一遍。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 要改的文件，工程内相对路径。 |
| `old` | string | 是 | 要被替换掉的原文，逐字相同且在文件里唯一。 |
| `new` | string | 是 | 替换成什么。留空表示删掉这段。 |
| `all` | boolean | 否 | 命中多处时是否全部替换。缺省 false：不唯一就报错，不猜改哪一处。 |

```sh
novelwarden mcp edit --path .novelwarden/premise.md --old "<值>" --new "<值>"
```

## `pipeline`（写盘·调模型）

流水线上的批量动作。它们背着固定流程（只补空白不覆盖已有产物、正文落盘在细纲上记指纹），所以走这里，不要自己用 write 拼。调模型的动作不等作者确认，预计调用几次随结果回给你；改动作者可以撤销。可用的 action：completeSettings=补齐故事架构（小说配置 / 故事前提 / 角色图谱 / 世界观 / 设定清单，只补空白）（调模型）；batchPlots=批量拆细纲（缺省从下一个该写的章起 5 章；已有细纲的章跳过）（调模型）；batchManuscripts=批量写章，一章一章串行写（缺省从下一个该写的章起 3 章、只写正文；已有正文的章跳过）（调模型）；newPlot=新建一章的细纲骨架（接在最后一章之后）（不调模型）。**连续多章的同类工作用这里**（batchPlots / batchManuscripts），比一章一章 generate 省钱，而且有进度条、能停、失败的会挂在那一章上。from / to 指定章号区间，只给 from 时按缺省章数往后数。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `completeSettings` \| `batchPlots` \| `batchManuscripts` \| `newPlot` | 是 | 要执行哪个动作。 |
| `from` | integer | 否 | 章号区间的起点。留空从下一个该写的章起。 |
| `to` | integer | 否 | 章号区间的终点（含）。要给就同时给 from。 |
| `mode` | `draft` \| `finalize` | 否 | 批量写章的模式：draft=只写正文（缺省），finalize=每写完一章就同步（照正文更新细纲 + 出场角色的当前状态 + 叙事线）。 |
| `review` | boolean | 否 | 批量写章时每写完一章先审稿，报告放进一个新会话。缺省 false。 |

```sh
novelwarden mcp pipeline --action completeSettings
```

## `summary`（写盘·调模型）

同步与全文大纲。同步 = 照正文反向更新那一章的细纲，没有正文的章同步不了。可用的 action：finalize=同步一章（照正文反向更新它的细纲与连续性事实，再更新出场角色的当前状态、认这一章在叙事线上发生了什么（带原文证据记下事件、更新各条线的当前进度，正文里新长出来的线也认出来）、推这一章的故事时间）（调模型，要 path）；sync=把所有没同步、或同步后正文又改过的章逐章同步（照正文更新细纲，再更新出场角色的当前状态、认每一章在叙事线上发生了什么、推每一章的故事时间）（调模型）；rebuildGlobal=从同步过的各章细纲重建全文大纲（调模型）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `finalize` \| `sync` \| `rebuildGlobal` | 是 | 要执行哪个动作。 |
| `path` | string | 否 | 那一章的章节路径或细纲路径（按章号认到同一章）。 |

```sh
novelwarden mcp summary --action finalize
```

## `characters`（写盘·调模型）

角色卡。出场人物以各章同步过的细纲为准：先同步（summary finalize）再建卡、更新卡。可用的 action：extract=通读已写正文，提取主要角色写成角色卡（调模型）；create=给一位还没有卡的出场人物建卡（调模型，要 name）；createAll=给同步过的章里所有还没有卡的出场人物建卡（调模型）；update=按新出场的章增量更新一张角色卡（调模型，要 path）；rebuild=按全部出场章重写一张角色卡（调模型，要 path）；updateAll=把所有角色卡按新出场的章增量更新一遍（调模型）；rebuildAll=按全部出场章重写所有角色卡（调模型）；cleanAliases=清理角色卡别名里的泛称与别人的名字（只改 aliases，正文不动）（不调模型）；mergeDuplicates=找出指向同一个人的重复角色卡并合并（每组留出场最多的那张，其余并进去）（不调模型）；reviewState=同步时作者改过、机器没覆盖的那张卡的「当前状态」：拿出机器那一版请作者对比决定换不换（不调模型，要 path）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `extract` \| `create` \| `createAll` \| `update` \| `rebuild` \| `updateAll` \| `rebuildAll` \| `cleanAliases` \| `mergeDuplicates` \| `reviewState` | 是 | 要执行哪个动作。 |
| `path` | string | 否 | 那张角色卡的工程内相对路径。 |
| `name` | string | 否 | 出场人物的名字，与细纲里的写法一致。 |

```sh
novelwarden mcp characters --action extract
```

## `lore`（写盘·调模型）

设定条目（地点、势力、物品、概念……）。出现在哪几章以各章同步过的细纲为准：先同步再建条目、整合。可用的 action：record=记设定：给了 path 就单独记那一章（只换细纲的「设定」一节），没给就补记所有同步过、还没记过设定的章（调模型）；build=给同步过的章里出现过、还没有条目的设定建条目；给了 name 就建那一条，没给就建出现 2 章以上的全部（调模型）；integrate=把同步过的章里的新内容并进设定条目；给了 path 就整合那一条，没给就是有新内容的全部（调模型）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `record` \| `build` \| `integrate` | 是 | 要执行哪个动作。 |
| `path` | string | 否 | 章节路径（record），或设定条目的工程内相对路径（integrate）。 |
| `name` | string | 否 | 名录里还没有条目的设定名字，与细纲里的写法一致。 |

```sh
novelwarden mcp lore --action record
```

## `extract`（写盘·调模型）

从已写的正文或情节大纲里提炼一份参考材料。可用的 action：style=从已写的正文里提取文风指南（写进 style.md，覆盖已有的那份；旧版存进历史版本）（调模型）；threads=从情节大纲排出叙事线（剧情线，伏笔挂在线下；一条线一个文件，写进 .novelwarden/threads/；已有的不动、同名跳过）（调模型）；threadsFromText=从已写正文补记叙事线：同步过、叙事线还没判的章按章号逐章认这一章在叙事线上发生了什么（每章写 1–3 次、每次写完转写 1 次；一条线都没有时先从情节大纲排一次），只往 .novelwarden/threads/ 里追加（调模型）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `style` \| `threads` \| `threadsFromText` | 是 | 要执行哪个动作。 |

```sh
novelwarden mcp extract --action style
```

## `book`（写盘·调模型）

拆书：作者有写好的稿子要接上来，或想学别人的书怎么写。txt 要先放在工程里。典型顺序：import 导入原稿 → derive 从已写正文补齐细纲、角色卡、架构与大纲。可用的 action：import=导入原稿：把一本 txt 按章标题切成章节，接在已有章节之后（导入本身不调模型；导入完接着从已写正文补齐，那一步要调模型）（调模型，要 path）；derive=从已写正文补齐：照第 1 章起连续写成的正文，补上缺的细纲（梗概就是情节大纲那一条）、角色卡、架构几件、设定条目与全文大纲（只补空白，已有的不动；动手前报调用次数）（调模型）；learn=从一本参考书学写法：文风写进 style.md，结构与节奏写成一份「规划」阶段的写作技能（只学怎么写，不复述原书的情节与人名，原文不进工程）（调模型，要 path）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `import` \| `derive` \| `learn` | 是 | 要执行哪个动作。 |
| `path` | string | 否 | 工程里那本 txt 的相对路径。 |

```sh
novelwarden mcp book --action import
```

## `skills`（写盘）

写作技能（补充的写作方法，装上并绑到某个阶段后，那个阶段的每一次生成都会带上它）。装 GitHub 上的一份：先 inspect 再 install（同一个 url），装完用 bind 绑到阶段才会用上。安装与绑定不等作者确认，作者可以在对话页撤销。可用的 action：list=列出可用的写作技能（内置 / 我的技能库 / 本工程）与本工程每个阶段绑了哪一份（不调模型）；inspect=检查一份 GitHub 上的写作技能（下载来看是不是纯提示词，不安装、不写文件）（不调模型，要 url）；install=把检查过的那份写作技能装进我的技能库（要先 inspect；装完还要 bind 才会用上）（不调模型，要 url）；bind=把一份写作技能绑到本工程的某个阶段（换掉那个阶段原来绑的）（不调模型，要 id / stage）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `list` \| `inspect` \| `install` \| `bind` | 是 | 要执行哪个动作。 |
| `url` | string | 否 | GitHub 上那份 SKILL.md（或它所在目录 / 仓库）的地址。inspect 与 install 用同一个。 |
| `id` | string | 否 | 技能 id，list 列出的那个（如 builtin:plain-prose）。 |
| `stage` | `planning` \| `drafting` \| `review` \| `refinement` | 否 | 绑到哪个阶段：planning=架构 / 大纲 / 细纲，drafting=写正文，review=审稿，refinement=修稿。 |

```sh
novelwarden mcp skills --action list
```
