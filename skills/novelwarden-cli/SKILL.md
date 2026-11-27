---
name: novelwarden-cli
description: 通过 Novelwarden CLI（novelwarden mcp）或同端口 HTTP API 操作运行中的 Novelwarden 独立版服务：查工程状态与进度、读写检索工程文件、调用分阶段生成、批量流水线、同步、角色卡、设定、叙事线、拆书与写作技能。适用于无原生 MCP 连接或需要命令行操控 Novelwarden 的场景。
---

<!-- 由 scripts/gen-cli-skill.js 从源码自动生成，修改工具后运行 npm run skill:cli 更新，勿手改。 -->

# Novelwarden CLI 操控技能

通过 `novelwarden mcp` 命令（底层调用同端口 `/api/*` HTTP REST 接口）操作正在运行的 Novelwarden 独立版服务。

## 1. 连接与环境变量

| 环境变量 | 说明 | 缺省值 |
|---|---|---|
| `NOVELWARDEN_URL` | Novelwarden 独立版服务地址 | `http://127.0.0.1:36800` |
| `NOVELWARDEN_PROJECT` | 目标小说工程目录（已初始化目录可按需自动加载） | 服务端当前默认工程 |
| `NOVELWARDEN_TOKEN` | 访问令牌（开启鉴权时必填，禁止经命令行参数传入） | 无 |

若服务跑在本地未安装全局命令，可用仓库内的 `node bin/novelwarden.js mcp ...` 或 `bun run src/shells/standalone/main.ts mcp ...`。

## 2. 命令速查

```sh
# 查看已打开工程与状态机给出的下一步
novelwarden mcp status [--url URL] [--project DIR] [--json]

# 列出全部工具 / 查看单个工具的参数定义
novelwarden mcp tools [工具名] [--json]

# 调用工具（支持 call <工具名> 或直接省略 call）
novelwarden mcp call <工具名> [--<参数> <值> ...] [--arg k=v ...] [--data '<json>'|@file|-]
novelwarden mcp <工具名> [--<参数> <值> ...] [--project DIR] [--json] [--no-stream]
```

- 长任务（如 `generate`、`pipeline`、`summary`）默认走 SSE 心跳保活，不会因空闲超时断开；按 `Ctrl+C` 断开连接即中断服务端任务。
- 参数传递：`--<参数> <值>` 自动还原布尔、无前导零数字与 JSON 数组/对象（`001` 这类前导零保留为字符串）；复杂长文本优先用 `--data @payload.json` 或 `--data -`（stdin）。
- 纯 HTTP 直调（如 `curl`）：`GET /api/status`、`GET /api/tools`、`POST /api/tools/<工具名>[?project=DIR]`，鉴权头为 `Authorization: Bearer $NOVELWARDEN_TOKEN`。

## 3. 工作原则

Novelwarden 是作者本人的小说创作工具。这几个工具读写的是他此刻在 Novelwarden 里打开的那个小说工程。

- 工程就是一堆 Markdown：.novelwarden/ 下是架构（config.md / premise.md / world.md）、情节大纲（outline.md——磁盘上没有这份文件，它是各章细纲「梗概」的汇总，读写照样认这个路径，写回时按章号拆进各章细纲）、细纲（summaries/ 下，一章一份，与正文同样的相对路径，如 summaries/上部/003-夜访.md；同步会照正文改它）；正文在 chapters/（可以分子目录）。先 list / read / search 看清楚再动手。
- 要产出内容用 generate：它在 Novelwarden 内部按分阶段装配好的上下文调创作模型。正文直接流给作者看，**不会回到你这里**；产出直接落盘，落到哪写在返回里。不要自己拼一份内容用 write 代替 generate——创作质量来自那一层的装配。
- 连续多章（补架构、排细纲、写正文）用 pipeline 的批量动作，不要循环调 generate；同步与全文大纲在 summary，角色卡在 characters，设定条目（记设定、建条目、整合）在 lore，文风 / 叙事线在 extract，导入原稿与拆书在 book，写作技能在 skills。这些是 Novelwarden 工程页上那些按钮背后的同一个函数。
- 工具结果末尾有时附一段「# 当前工程」：那是 Novelwarden 状态机算出的下一步，与界面上的主按钮是同一句话。照它走，不要另做判断；它变了才会再出现。
- 动手的工具不等作者确认：途中的确认（预计调用几次模型、覆盖已有内容……）按缺省作答，每份文件改之前的那一版都会存下，作者可以在 Novelwarden 里撤销这一步。改了哪些文件、答了什么附在结果末尾，据此核对，不要重复同一个动作。
- 没有删除、改名、移动，也不做审稿与修稿——那些由作者自己在 Novelwarden 里做。

## 4. 工具一览（共 13 个）

完整参数与枚举说明见 [references/tools.md](references/tools.md)，或随时运行 `novelwarden mcp tools <工具名>` 查看实时定义。

| 工具 | 性质 | 必填参数 | 用途 |
|---|---|---|---|
| `list` | 只读 | — | 列出工程里某个目录的直接子项（不递归），带类型与字数。 |
| `read` | 只读 | `path` | 读一份文件的内容，返回带行号的文本。 |
| `search` | 只读 | `pattern` | 在工程里全文检索，返回命中的行（带路径与行号），**按章号升序**。 |
| `generate` | 写盘·调模型 | `target`, `capability` | 调用创作模型，为某一份产物生成内容。 |
| `write` | 写盘 | `path` | 把内容写进工程里的一份文件。 |
| `edit` | 写盘 | `path`, `old`, `new` | 把一份文件里的一段文字换成另一段。 |
| `pipeline` | 写盘·调模型 | `action` | 流水线上的批量动作。 |
| `summary` | 写盘·调模型 | `action` | 同步与全文大纲。 |
| `characters` | 写盘·调模型 | `action` | 角色卡。 |
| `lore` | 写盘·调模型 | `action` | 设定条目（地点、势力、物品、概念……）。 |
| `extract` | 写盘·调模型 | `action` | 从已写的正文或情节大纲里提炼一份参考材料。 |
| `book` | 写盘·调模型 | `action` | 拆书：作者有写好的稿子要接上来，或想学别人的书怎么写。 |
| `skills` | 写盘 | `action` | 写作技能（补充的写作方法，装上并绑到某个阶段后，那个阶段的每一次生成都会带上它）。 |
