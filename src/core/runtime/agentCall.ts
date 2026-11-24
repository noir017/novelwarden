import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentAnswer, ExternalChange } from '../model/agentStep';

export type { AgentAnswer, ExternalChange };

/**
 * 「这一次是外部 agent 在做」：MCP 的一次写盘调用跑在 {@link withAgentCall} 里。
 *
 * 外部 agent 的操作**不等人点**（AGENTS 第 19 / 25 条）：这一次里冒出来的每一问——功能层的确认框、调模型之前那一问、
 * 覆盖前审阅、落盘卡片——都由 `getHost()`（`host.ts`）与 `askGate`（`controller/gate.ts`）当场替作者答掉，答了什么
 * 记在 {@link AgentCall.answers} 里，随工具调用那一行留在会话上，也回给 agent。兜底的是改之前那一版：网关在这一次里
 * 动每一份文件之前都先存一版历史（`workspace/journal.ts`），作者在对话页上一键撤销这一步。
 *
 * 作者自己点的按钮不在这个作用域里（别的消息、别的异步链），照旧弹窗。用 `AsyncLocalStorage.run`：同时在跑的
 * 别的任务各在各的上下文里，互不串（`callScope.ts` 同一个理由）。
 */

export interface AgentCall {
  answers: AgentAnswer[];
  external: ExternalChange[];
}

const scope = new AsyncLocalStorage<AgentCall>();

export function newAgentCall(): AgentCall {
  return { answers: [], external: [] };
}

/** 在「外部 agent 的这一次」里跑 `fn`：里面（含所有 await 之后）冒出来的问题都替作者答掉、记进 `call`。 */
export function withAgentCall<T>(call: AgentCall, fn: () => Promise<T>): Promise<T> {
  return scope.run(call, fn);
}

/** 当前这一次；不在外部 agent 的调用里（作者自己点的、启动期）是 undefined。 */
export function currentAgentCall(): AgentCall | undefined {
  return scope.getStore();
}

/** 记一笔替作者答掉的。不在 agent 调用里时什么都不做。 */
export function noteAnswer(answer: AgentAnswer): void {
  scope.getStore()?.answers.push(answer);
}

/** 记一笔工程之外的改动（见 {@link ExternalChange}）。不在 agent 调用里时什么都不做。 */
export function noteExternal(change: ExternalChange): void {
  scope.getStore()?.external.push(change);
}
