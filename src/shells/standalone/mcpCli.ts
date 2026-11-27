/**
 * Novelwarden MCP / HTTP API 命令行客户端。
 *
 * 复用独立版服务的 `/api/*` HTTP 接口，无需 JSON-RPC 样板，零外部依赖：
 *
 * ```sh
 * novelwarden mcp status [--url URL] [--project DIR] [--json]
 * novelwarden mcp tools [name] [--url URL] [--json]
 * novelwarden mcp call <tool> [--arg k=v ...] [--data '<json>'|@file|-] [--<k> <v>] [--url URL] [--project DIR] [--json] [--no-stream]
 * novelwarden mcp <tool> [...]   # call <tool> 的简写
 * ```
 *
 * 令牌只从环境变量 `NOVELWARDEN_TOKEN`（旧名 `NOVELFORGE_TOKEN` 兼容）读取，不走命令行参数。
 */
import * as fs from 'node:fs';
import { API_PREFIX } from '../../core/mcp/rest';
import { tokenFromEnv } from './auth';
import { DEFAULT_PORT } from './cli';

export const URL_ENV = 'NOVELWARDEN_URL';
export const PROJECT_ENV = 'NOVELWARDEN_PROJECT';

export interface McpCliCommand {
  kind: 'help' | 'status' | 'tools' | 'call';
  url: string;
  project?: string;
  json: boolean;
  stream: boolean;
  /** `tools <name>` 或 `call <tool>` 的工具名。 */
  tool?: string;
  /** `--data` 原始值（JSON 字符串、`@文件` 或 `-` 表示 stdin）。 */
  data?: string;
  /** 通过 `--arg k=v` 或 `--k v` 传入的工具参数。 */
  args: Record<string, unknown>;
}

export interface McpCliDeps {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readFile?: (filePath: string) => string;
  readStdin?: () => Promise<string>;
}

const HELP_TEXT = `用法：
  novelwarden mcp status [--url URL] [--project DIR] [--json]
  novelwarden mcp tools [工具名] [--url URL] [--json]
  novelwarden mcp call <工具名> [参数...] [--url URL] [--project DIR] [--json] [--no-stream]
  novelwarden mcp <工具名> [参数...]   （call 的简写）

参数传递：
  --data '<json>' / -d '<json>'   传入 JSON 对象（@路径 读文件，- 读标准输入）
  --arg key=value / -a key=value  设置单个参数（可重复）
  --<参数名> <值>                 直接设置对应工具参数

环境变量：
  NOVELWARDEN_URL                 默认服务地址（缺省 http://127.0.0.1:${DEFAULT_PORT}）
  NOVELWARDEN_PROJECT             默认小说工程目录
  NOVELWARDEN_TOKEN               访问令牌（服务开启鉴权时必填，不走命令行参数）
`;

/** 解析 `novelwarden mcp` 后面的参数。纯函数，便于单测。 */
export function parseMcpArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): McpCliCommand {
  let url = env[URL_ENV]?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`;
  let project = env[PROJECT_ENV]?.trim() || undefined;
  let json = false;
  let stream = true;
  let data: string | undefined;
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { kind: 'help', url, project, json, stream, args };
    }
    if (a === '--url' || a === '-u') {
      const next = argv[++i];
      if (!next) {
        throw new Error(`${a} 缺少参数值。`);
      }
      url = next.trim();
      continue;
    }
    if (a.startsWith('--url=')) {
      url = a.slice('--url='.length).trim();
      continue;
    }
    if (a === '--project' || a === '-p') {
      const next = argv[++i];
      if (!next) {
        throw new Error(`${a} 缺少参数值。`);
      }
      project = next.trim() || undefined;
      continue;
    }
    if (a.startsWith('--project=')) {
      project = a.slice('--project='.length).trim() || undefined;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--no-stream') {
      stream = false;
      continue;
    }
    if (a === '--data' || a === '-d') {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error(`${a} 缺少参数值。`);
      }
      data = next;
      continue;
    }
    if (a.startsWith('--data=')) {
      data = a.slice('--data='.length);
      continue;
    }
    if (a === '--arg' || a === '-a') {
      const next = argv[++i];
      if (!next) {
        throw new Error(`${a} 缺少 key=value。`);
      }
      applyKeyValue(args, next);
      continue;
    }
    if (a.startsWith('--arg=')) {
      applyKeyValue(args, a.slice('--arg='.length));
      continue;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        const key = a.slice(2, eq);
        args[key] = parseValue(a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const peek = argv[i + 1];
        if (peek === undefined || peek.startsWith('-')) {
          args[key] = true;
        } else {
          args[key] = parseValue(argv[++i]);
        }
      }
      continue;
    }
    positionals.push(a);
  }

  url = url.replace(/\/+$/, '');
  const sub = positionals[0];
  if (!sub || sub === 'help') {
    return { kind: 'help', url, project, json, stream, args };
  }
  if (sub === 'status') {
    return { kind: 'status', url, project, json, stream, args };
  }
  if (sub === 'tools') {
    return { kind: 'tools', url, project, json, stream, tool: positionals[1], args };
  }
  if (sub === 'call') {
    const tool = positionals[1];
    if (!tool) {
      throw new Error('请指定要调用的工具名，例如：novelwarden mcp call list');
    }
    return { kind: 'call', url, project, json, stream, tool, data, args };
  }
  // 简写：novelwarden mcp <tool> [...]
  return { kind: 'call', url, project, json, stream, tool: sub, data, args };
}

/** 执行一条 `novelwarden mcp` 命令，返回进程退出码。 */
export async function runMcpCli(argv: string[], deps: McpCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const readStdin = deps.readStdin ?? defaultReadStdin;

  let cmd: McpCliCommand;
  try {
    cmd = parseMcpArgs(argv, env);
  } catch (err) {
    stderr(`参数错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (cmd.kind === 'help') {
    stdout(HELP_TEXT);
    return 0;
  }

  const token = tokenFromEnv(env);
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const onSignal = () => ctrl.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (cmd.kind === 'status') {
      const target = withProject(`${cmd.url}${API_PREFIX}/status`, cmd.project);
      const res = await fetchFn(target, { method: 'GET', headers, signal: ctrl.signal });
      const body = await readJsonOrError(res);
      if (!res.ok) {
        stderr(`${formatHttpError(res.status, body)}\n`);
        return 1;
      }
      if (cmd.json) {
        stdout(`${JSON.stringify(body, null, 2)}\n`);
        return 0;
      }
      stdout(formatStatus(body));
      return 0;
    }

    if (cmd.kind === 'tools') {
      const pathPart = cmd.tool ? `${API_PREFIX}/tools/${encodeURIComponent(cmd.tool)}` : `${API_PREFIX}/tools`;
      const res = await fetchFn(`${cmd.url}${pathPart}`, { method: 'GET', headers, signal: ctrl.signal });
      const body = await readJsonOrError(res);
      if (!res.ok) {
        stderr(`${formatHttpError(res.status, body)}\n`);
        return 1;
      }
      if (cmd.json) {
        stdout(`${JSON.stringify(body, null, 2)}\n`);
        return 0;
      }
      stdout(cmd.tool ? formatSingleTool(body) : formatToolList(body));
      return 0;
    }

    // call
    let mergedArgs: Record<string, unknown> = {};
    if (cmd.data !== undefined) {
      const rawJson = cmd.data === '-' ? await readStdin() : cmd.data.startsWith('@') ? readFile(cmd.data.slice(1)) : cmd.data;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        stderr('错误：--data 内容不是合法的 JSON。\n');
        return 2;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        stderr('错误：--data 必须是 JSON 对象。\n');
        return 2;
      }
      mergedArgs = { ...(parsed as Record<string, unknown>) };
    }
    Object.assign(mergedArgs, cmd.args);

    const target = withProject(`${cmd.url}${API_PREFIX}/tools/${encodeURIComponent(cmd.tool!)}`, cmd.project);
    const res = await fetchFn(target, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: cmd.stream ? 'text/event-stream, application/json' : 'application/json',
      },
      body: JSON.stringify(mergedArgs),
      signal: ctrl.signal,
    });

    const ct = res.headers.get('content-type') ?? '';
    let payload: Record<string, unknown>;
    if (res.ok && ct.startsWith('text/event-stream')) {
      payload = await readSseResult(res);
    } else {
      payload = await readJsonOrError(res);
      if (!res.ok) {
        stderr(`${formatHttpError(res.status, payload)}\n`);
        return 1;
      }
    }

    if (cmd.json) {
      stdout(`${JSON.stringify(payload, null, 2)}\n`);
      return payload.ok === false ? 1 : 0;
    }

    const text = typeof payload.text === 'string' ? payload.text : typeof payload.error === 'string' ? payload.error : JSON.stringify(payload);
    const brief = typeof payload.brief === 'string' && payload.brief ? `\n\n${payload.brief}` : '';
    if (payload.ok === false) {
      stderr(`${text}${brief}\n`);
      return 1;
    }
    stdout(`${text}${brief}\n`);
    return 0;
  } catch (err) {
    if (ctrl.signal.aborted) {
      stderr('已取消。\n');
      return 130;
    }
    stderr(`请求失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function applyKeyValue(target: Record<string, unknown>, pair: string): void {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    throw new Error(`参数格式应为 key=value，收到：${pair}`);
  }
  const key = pair.slice(0, eq).trim();
  if (!key) {
    throw new Error(`参数名不能为空：${pair}`);
  }
  target[key] = parseValue(pair.slice(eq + 1));
}

/** 轻量类型还原：布尔、无前导零数字、JSON 数组/对象；其余保持字符串（如 `001`）。 */
export function parseValue(raw: string): unknown {
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw === 'null') {
    return null;
  }
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function withProject(baseUrl: string, project?: string): string {
  if (!project) {
    return baseUrl;
  }
  const u = new URL(baseUrl);
  u.searchParams.set('project', project);
  return u.toString();
}

async function readJsonOrError(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { text };
  } catch {
    return { error: text.trim() };
  }
}

async function readSseResult(res: Response): Promise<Record<string, unknown>> {
  if (!res.body) {
    throw new Error('服务端返回了空的 SSE 流。');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: Record<string, unknown> | undefined;

  const consume = (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (eventName === 'result' && dataLines.length > 0) {
      result = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      consume(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) {
    consume(buf);
  }
  if (!result) {
    throw new Error('SSE 流在收到结果前已关闭。');
  }
  return result;
}

function formatHttpError(status: number, body: Record<string, unknown>): string {
  const msg = typeof body.error === 'string' ? body.error : typeof body.text === 'string' ? body.text : '';
  if (status === 401) {
    return `HTTP 401 未授权：请通过环境变量 NOVELWARDEN_TOKEN 提供访问令牌。`;
  }
  return msg ? `HTTP ${status}：${msg}` : `HTTP ${status}`;
}

function formatStatus(body: Record<string, unknown>): string {
  const projects = (body.projects as { open?: string[]; default?: string } | undefined) ?? {};
  const open = Array.isArray(projects.open) ? projects.open : [];
  const lines: string[] = [];
  lines.push(`当前工程：${typeof body.project === 'string' && body.project ? body.project : '（未打开）'}`);
  if (open.length > 0) {
    lines.push(`已打开工程（${open.length}）：`);
    for (const p of open) {
      lines.push(`  - ${p}${p === projects.default ? '（默认）' : ''}`);
    }
  }
  if (typeof body.brief === 'string' && body.brief) {
    lines.push('', body.brief);
  }
  return `${lines.join('\n')}\n`;
}

function formatToolList(body: Record<string, unknown>): string {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  const lines = tools.map((t) => {
    const name = String(t.name ?? '');
    const tag = t.readOnly ? '[只读]' : '[写盘]';
    const desc = String(t.description ?? '').split('\n')[0];
    return `${name.padEnd(12)} ${tag} ${desc}`;
  });
  return `${lines.join('\n')}\n`;
}

function formatSingleTool(body: Record<string, unknown>): string {
  const tool = (body.tool as Record<string, unknown> | undefined) ?? body;
  const name = String(tool.name ?? '');
  const tag = tool.readOnly ? '只读' : '写盘';
  const desc = String(tool.description ?? '');
  const params = (tool.parameters as { properties?: Record<string, Record<string, unknown>>; required?: string[] } | undefined) ?? {};
  const reqSet = new Set(Array.isArray(params.required) ? params.required : []);
  const lines = [`${name}（${tag}）`, '', desc];
  const props = params.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length > 0) {
    lines.push('', '参数：');
    for (const k of keys) {
      const p = props[k];
      const req = reqSet.has(k) ? '必填' : '可选';
      const type = Array.isArray(p.enum) ? `enum(${p.enum.join('|')})` : String(p.type ?? 'any');
      const pDesc = p.description ? ` — ${String(p.description)}` : '';
      lines.push(`  --${k} <${type}> [${req}]${pDesc}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
