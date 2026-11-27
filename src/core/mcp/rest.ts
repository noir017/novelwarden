/**
 * MCP 工具的普通 HTTP REST 传输。**只用标准的 `Request` / `Response`**，Bun 与 Node 都跑得动。
 *
 * 与 [http.ts](http.ts)（JSON-RPC 2.0 Streamable HTTP）并行挂载，共用同一份 `ToolSpec[]` 与
 * `McpBackend`，给 curl、脚本和 CLI 直接调用：
 *
 * - `GET  /api/status[?project=DIR]`      → 已打开工程、默认工程与当前状态简报
 * - `GET  /api/tools`                     → 全部工具清单（名称、说明、参数 schema、只读/写盘标记）
 * - `GET  /api/tools/:name`               → 单个工具的完整声明
 * - `POST /api/tools/:name[?project=DIR]` → 请求体为工具参数 JSON；`Accept: text/event-stream` 时走 SSE 保活，
 *                                           其余回 JSON `{ ok, text, brief? }`
 *
 * 鉴权归壳管，这里只管 `Origin`（规则同 [http.ts](http.ts)）。
 */
import type { ToolSpec } from '../tools/types';
import { describeError, scoped } from '../runtime/logger';
import { HEARTBEAT_MS } from './http';
import type { McpBackend } from './server';

const log = scoped('HTTP-API');

/** 挂在独立版服务上的前缀。 */
export const API_PREFIX = '/api';

export interface RestToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  mutating: boolean;
  costly: boolean;
}

export interface McpRestOptions {
  /** 工具清单。与工程无关，没打开工程时 `GET /api/tools` 照样回得出来。 */
  tools: ToolSpec[];
  /** 工程的执行端，同 `McpServerOptions.backend`。 */
  backend(project?: string): McpBackend | undefined | Promise<McpBackend | undefined>;
  /** 可选：当前打开的所有工程与默认工程（供 `GET /api/status` 返回）。 */
  projects?(): { open: string[]; default?: string };
  /** 浏览器发来的 `Origin` 认不认。不给就一律放过（测试用）。 */
  allowOrigin?(origin: string | null, req: Request): boolean;
  /** SSE 保活间隔，缺省 `HEARTBEAT_MS`（测试调小）。 */
  heartbeatMs?: number;
}

export class McpRestHandler {
  private readonly toolMap: Map<string, ToolSpec>;
  private readonly inflight = new Set<AbortController>();

  constructor(private readonly opts: McpRestOptions) {
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  }

  async handle(req: Request): Promise<Response> {
    if (this.opts.allowOrigin && !this.opts.allowOrigin(req.headers.get('origin'), req)) {
      log.warn('拒绝了一个跨源 HTTP API 请求', `Origin: ${req.headers.get('origin')}`);
      return new Response('Forbidden origin', { status: 403 });
    }
    const url = new URL(req.url);
    const sub = stripPrefix(url.pathname, API_PREFIX);
    if (sub === undefined) {
      return json({ ok: false, error: 'Not Found' }, 404);
    }

    if (sub === '/status') {
      if (req.method !== 'GET') {
        return methodNotAllowed('GET');
      }
      return this.status(url);
    }
    if (sub === '/tools') {
      if (req.method !== 'GET') {
        return methodNotAllowed('GET');
      }
      return json({ tools: this.opts.tools.map(toRestTool) }, 200);
    }
    if (sub.startsWith('/tools/')) {
      const rawName = sub.slice('/tools/'.length);
      if (!rawName || rawName.includes('/')) {
        return json({ ok: false, error: 'Not Found' }, 404);
      }
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return json({ ok: false, error: '工具名不是合法的 URL 编码。' }, 400);
      }
      if (req.method === 'GET') {
        const spec = this.toolMap.get(name);
        if (!spec) {
          return json({ ok: false, error: `没有叫 ${name} 的工具。` }, 404);
        }
        return json({ tool: toRestTool(spec) }, 200);
      }
      if (req.method === 'POST') {
        return this.callTool(name, req, url);
      }
      return methodNotAllowed('GET, POST');
    }

    return json({ ok: false, error: 'Not Found' }, 404);
  }

  /** 服务停掉时调：还在跑的调用全中断。 */
  closeAll(): void {
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
    this.inflight.clear();
  }

  private async status(url: URL): Promise<Response> {
    const requested = url.searchParams.get('project')?.trim() || undefined;
    const projects = this.opts.projects ? this.opts.projects() : { open: [], default: undefined };
    const backend = await this.opts.backend(requested);
    const updated = this.opts.projects ? this.opts.projects() : projects;
    let brief: string | null = null;
    if (backend) {
      try {
        brief = (await backend.brief()) || null;
      } catch (err) {
        log.warn('HTTP API 状态简报生成失败', describeError(err));
      }
    }
    return json(
      {
        ok: true,
        projects: updated,
        project: requested ?? updated.default ?? null,
        connected: !!backend,
        brief,
      },
      200
    );
  }

  private async callTool(name: string, req: Request, url: URL): Promise<Response> {
    if (!this.toolMap.has(name)) {
      const available = this.opts.tools.map((t) => t.name).join(', ');
      return json({ ok: false, error: `没有叫 ${name} 的工具，可用的是：${available}` }, 404);
    }

    let args: Record<string, unknown> = {};
    const raw = (await req.text()).trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: '请求体不是合法的 JSON。' }, 400);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json({ ok: false, error: '请求体必须是 JSON 对象。' }, 400);
      }
      args = parsed as Record<string, unknown>;
    }

    const project = url.searchParams.get('project')?.trim() || undefined;
    const backend = await this.opts.backend(project);
    if (!backend) {
      const error = project
        ? `Novelwarden 里没有打开这个小说工程：${project}。请确认目录已初始化或先在 Novelwarden 里打开它。`
        : 'Novelwarden 现在没有打开任何小说工程。请先在 Novelwarden 里打开一个工程，或通过 ?project=<目录> 指定。';
      return json({ ok: false, error }, 400);
    }

    if ((req.headers.get('accept') ?? '').includes('text/event-stream')) {
      return this.streamCall(name, args, backend, req.signal);
    }

    const payload = await this.execute(name, args, backend, req.signal);
    return json(payload, 200);
  }

  private streamCall(
    name: string,
    args: Record<string, unknown>,
    backend: McpBackend,
    signal: AbortSignal
  ): Response {
    const encoder = new TextEncoder();
    const gone = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (chunk: string) => {
          if (!gone.signal.aborted) {
            controller.enqueue(encoder.encode(chunk));
          }
        };
        send(': open\n\n');
        let beat = 0;
        timer = setInterval(() => {
          beat++;
          send(sseEvent('progress', { beat, message: '仍在运行' }));
        }, this.opts.heartbeatMs ?? HEARTBEAT_MS);
        try {
          const payload = await this.execute(name, args, backend, AbortSignal.any([signal, gone.signal]));
          send(sseEvent('result', payload));
        } finally {
          clearInterval(timer);
          if (!gone.signal.aborted) {
            controller.close();
          }
        }
      },
      cancel: () => {
        clearInterval(timer);
        gone.abort();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
    backend: McpBackend,
    signal: AbortSignal
  ): Promise<{ ok: boolean; text: string; brief?: string }> {
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    if (signal.aborted) {
      ctrl.abort();
    } else {
      signal.addEventListener('abort', relay, { once: true });
    }
    this.inflight.add(ctrl);
    try {
      const result = await backend.call(name, args, ctrl.signal);
      let brief: string | undefined;
      try {
        brief = (await backend.brief()) || undefined;
      } catch (err) {
        log.warn('HTTP API 状态简报生成失败', describeError(err));
      }
      return {
        ok: !result.isError,
        text: result.text,
        ...(brief ? { brief } : {}),
      };
    } catch (err) {
      const message = describeError(err);
      log.error(`HTTP API 调用 ${name} 失败：${message}`, err);
      return { ok: false, text: `执行失败：${message}` };
    } finally {
      this.inflight.delete(ctrl);
      signal.removeEventListener('abort', relay);
    }
  }
}

export function toRestTool(spec: ToolSpec): RestToolInfo {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    readOnly: !spec.costly && !spec.mutating,
    mutating: !!spec.mutating,
    costly: !!spec.costly,
  };
}

function stripPrefix(pathname: string, prefix: string): string | undefined {
  if (pathname === prefix) {
    return '/';
  }
  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length);
  }
  return undefined;
}

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method Not Allowed', { status: 405, headers: { allow } });
}

function json(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
