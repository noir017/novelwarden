# core/mcp — 把工具端给外部 agent

**多步的活交给外部 agent（Claude Code、Codex……），Novelwarden 只提供工具。**

本项目不自带对话循环。上下文压缩、多步规划、权限模式、各家服务商的 tool calling 兼容——这些通用
agent 做得更好，自己再做一份只是更弱的重复。真正值钱的不在循环里：创作质量来自分阶段装配
（`generate` 内部那次调用），工程动作的不变量在 `features/` 里（`pipeline` / `summary` / `characters` 那几个工具转发过去）。

所以这一层只做一件事：把 [`tools/`](../tools/README.md) 那套工具经 MCP 端出去，外部 agent 自带循环。

| 文件 | 职责 |
|---|---|
| [server.ts](server.ts) | ★ 协议：`initialize` / `ping` / `tools/list` / `tools/call` / `notifications/cancelled`，会话，状态简报 |
| [http.ts](http.ts) | Streamable HTTP 传输：POST 回 JSON（`tools/call` 回 SSE 带进度保活）、会话头、DELETE、GET 405、Origin 校验。只用标准 `Request` / `Response` |
| [rest.ts](rest.ts) | 普通 HTTP REST 传输：`GET /api/status`、`GET /api/tools[/:name]`、`POST /api/tools/:name`（支持 JSON 与 SSE 保活），给 curl 与 CLI 用 |
| [instructions.ts](instructions.ts) | `initialize` 回给客户端的使用说明（只说怎么用工具，不写领域知识） |
| [index.ts](index.ts) | `createNovelMcp` / `createNovelRest`：工具清单 + 说明 + 两种 HTTP 传输，壳只给「当前工程的执行端」 |

执行端在 [controller/mcp.ts](../controller/mcp.ts)：一次调用落到一个工程上，落到哪个由壳决定（`backend(project)`）。

## 怎么接

独立版（含桌面版的 sidecar）启动时在同一个端口上挂 `/mcp`，日志里会打一行：

```
MCP 已就绪：http://127.0.0.1:3000/mcp
    claude mcp add --transport http novelwarden http://127.0.0.1:3000/mcp
HTTP API 已就绪：http://127.0.0.1:3000/api/tools
    CLI：novelwarden mcp status --url http://127.0.0.1:3000
```

调用落在**最近操作的那个网页窗口开着的工程**上；地址带 `?project=<工程目录>`（每次请求都看地址，不必重新 initialize）就落到那个工程——若该目录已是初始化过的小说工程，服务端会按需加载，不必先在网页里打开。没打开工程时工具照样列得出来，调用回一句「先打开工程」。
VS Code 壳还没接（要另起一个 HTTP 服务，等用得上再说）。

## 分层

```
外部 agent ──HTTP──▶ mcp/http.ts ──▶ mcp/server.ts ──McpBackend──▶ controller/mcp.ts ──▶ tools/（ToolRegistry）
                                       （只懂协议）                    （生成位、对话页、代答与改动账）
```

`mcp/` 只认 `tools/` 的契约（`ToolSpec`、`NOVEL_TOOLS`），**不认识 `Workspace` / `DraftStore` /
`ChatController`**；`tools/` 一行都不 import `mcp/` 与 `controller/`。两条由
[tests/contract/layerBoundary.test.js](../../../tests/contract/layerBoundary.test.js) 守着。

## 四条约束

### 1. 产物不回灌

`generate` 的返回里只有形状与 `draftId`，**没有正文**。正文照旧流进对话页那个 MCP 气泡里的工具卡片
（`toolDelta`），外部 agent 看不到——它每走一步都重烧一遍上下文，三千字正文塞回去，十步之后就是
三万字的重复账单。要看内容，等落盘之后 `read`。

### 2. 不等人点，每一步撤销得了（第 19 / 25 条）

花钱或写盘的调用（`gate: 'mutating'`）不在对话页上等作者点：跑在两个作用域里（`controller/mcp.ts`）——

- **替作者作答**（`runtime/agentCall.ts`）：功能层的确认框选第一颗按钮、调模型那一问用缺省模型与详细度、覆盖审阅采纳、
  `generate` 的落盘卡片确认，输入框用缺省值（没有就取消）、好几项的挑选框取消；答了什么记下来。
- **改动账**（`workspace/journal.ts`）：网关动每一份文件之前先存一版历史（备注「Agent：<这一步> 之前」），结束时算出改了、
  建了、删了哪几份；`project.json` 里的两个进度单记；装进我的技能库的由技能库报一笔。

两样都记在对话页那一行工具条上（随会话落盘），也简短地附在工具结果末尾回给 agent。作者在那一行上点两下「撤销」
（`features/agentUndo.ts`）就按文件放回改之前那一版：之后又被改过的、编辑器里有未保存修改的跳过；撤销之前先把 agent 写的
那一版也存一版。宿主（Claude Code 之类）自己那一层「让不让调这个工具」的权限照旧是宿主的事。
### 3. 状态由状态机给（第 20 条）

MCP 没有「每回合往 system 里注入」这个口子，于是状态机给出的那份简报
（[views/stateBrief.ts](../views/stateBrief.ts)）贴在工具结果末尾，**只在它变了的时候贴**：会话的第一次
调用必贴，之后与上一次贴出去的那份逐字比。仍然没有 `status` 工具。

### 4. 与对话页共用一把生成锁

花钱或写盘的调用占的是与对话页单步创作同一个生成位（两条路都往对话页里流正文、挂卡片，同时跑会互相盖）。
占不到就当场回 `isError`（「正在跑另一个生成任务」），不排队——排着的调用作者看不见，等它突然开始写盘时他早就忘了这回事。占到了就走 `runTask`：
进度条上看得见、能停；停止会中断那一次调用。查询（`list` / `read` / `search`、查技能）不占锁、不进对话页。

## 长调用

写一章、批量写几章可能跑几分钟。客户端两道上限都会撞上：等响应头（Claude Code 缺省 60 秒，
报「The operation timed out.」）与等结果的空闲上限（HTTP 缺省 5 分钟，收到进度通知才重新计时）。
所以 `tools/call` 在客户端收 `text/event-stream` 时回 SSE：响应头当场回，跑的期间每 15 秒发一条
`notifications/progress`（请求没带 `progressToken` 就发 SSE 注释），跑完把回复当最后一个事件发出去。
其余请求、以及只收 JSON 的客户端，照旧回整份 JSON。
Bun 缺省 10 秒空闲就断连接，所以壳对 `/mcp` 的请求调 `server.timeout(req, 0)`。

取消有两条路：客户端发 `notifications/cancelled`，或者连接断了——都会中断那一次调用。
