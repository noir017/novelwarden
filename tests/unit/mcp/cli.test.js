/**
 * MCP CLI 客户端（`src/shells/standalone/mcpCli.ts`）：参数解析、类型还原、鉴权与 SSE/JSON 调用。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mcp = loadModule('src/core/mcp/index.ts');
const cli = loadModule('src/shells/standalone/mcpCli.ts');

describe('parseMcpArgs & parseValue', () => {
  test('parseValue 保留前导零字符串并还原布尔、数字与 JSON', () => {
    assert.equal(cli.parseValue('true'), true);
    assert.equal(cli.parseValue('false'), false);
    assert.equal(cli.parseValue('null'), null);
    assert.equal(cli.parseValue('42'), 42);
    assert.equal(cli.parseValue('-3.5'), -3.5);
    assert.equal(cli.parseValue('001'), '001');
    assert.deepEqual(cli.parseValue('[1,2]'), [1, 2]);
    assert.equal(cli.parseValue('chapters/001.md'), 'chapters/001.md');
  });

  test('解析 call、简写、环境变量与参数合并', () => {
    const env = { NOVELWARDEN_URL: 'http://127.0.0.1:3680/', NOVELWARDEN_PROJECT: '/data/book' };
    const c1 = cli.parseMcpArgs(['call', 'pipeline', '--action', 'batchPlots', '--from', '1', '--to=5', '--review', 'false'], env);
    assert.equal(c1.kind, 'call');
    assert.equal(c1.url, 'http://127.0.0.1:3680');
    assert.equal(c1.project, '/data/book');
    assert.equal(c1.tool, 'pipeline');
    assert.deepEqual(c1.args, { action: 'batchPlots', from: 1, to: 5, review: false });

    const c2 = cli.parseMcpArgs(['read', '--path', 'chapters/001.md', '-a', 'limit=100', '--json', '--no-stream'], env);
    assert.equal(c2.kind, 'call');
    assert.equal(c2.tool, 'read');
    assert.equal(c2.json, true);
    assert.equal(c2.stream, false);
    assert.deepEqual(c2.args, { path: 'chapters/001.md', limit: 100 });
  });
});

describe('runMcpCli 对接 McpRestHandler', () => {
  function harness({ reply, token } = {}) {
    const calls = [];
    const seenHeaders = [];
    const rest = mcp.createNovelRest(
      async (project) => ({
        call: async (name, args) => {
          calls.push({ name, args, project });
          return reply ? reply(name, args) : { text: `ok:${name}`, isError: false };
        },
        brief: async () => '# 当前工程\n下一步：继续写',
      }),
      {
        projects: () => ({ open: ['/books/demo'], default: '/books/demo' }),
        heartbeatMs: 10,
      }
    );

    const run = async (argv, extra = {}) => {
      let out = '';
      let err = '';
      const code = await cli.runMcpCli(argv, {
        env: { ...(token ? { NOVELWARDEN_TOKEN: token } : {}), ...(extra.env ?? {}) },
        stdout: (s) => { out += s; },
        stderr: (s) => { err += s; },
        readFile: extra.readFile,
        readStdin: extra.readStdin,
        fetch: async (input, init) => {
          const req = new Request(String(input), init);
          seenHeaders.push(req.headers.get('authorization'));
          return rest.handle(req);
        },
      });
      return { code, out, err };
    };
    return { run, calls, seenHeaders };
  }

  test('status 与 tools 输出正常并带 Bearer 令牌', async () => {
    const h = harness({ token: 'secret-token-123456' });
    const st = await h.run(['status']);
    assert.equal(st.code, 0, st.err);
    assert.ok(st.out.includes('/books/demo'));
    assert.ok(st.out.includes('下一步：继续写'));
    assert.equal(h.seenHeaders[0], 'Bearer secret-token-123456');

    const tl = await h.run(['tools']);
    assert.equal(tl.code, 0, tl.err);
    assert.ok(tl.out.includes('generate'));

    const one = await h.run(['tools', 'read']);
    assert.equal(one.code, 0, one.err);
    assert.ok(one.out.includes('read（只读）'));
  });

  test('SSE 与 --no-stream 调用、--data @file、工具报错返回非零退出码', async () => {
    const h = harness({
      reply: (name, args) =>
        name === 'write'
          ? { text: '写入失败：模拟错误', isError: true }
          : { text: `got ${name}:${args.path}`, isError: false },
    });

    const sse = await h.run(['read', '--path', 'chapters/001.md', '--project', '/books/demo']);
    assert.equal(sse.code, 0, sse.err);
    assert.ok(sse.out.includes('got read:chapters/001.md'));
    assert.equal(h.calls[0].project, '/books/demo');

    const plain = await h.run(['call', 'read', '--no-stream', '--json', '--data', '@args.json'], {
      readFile: () => JSON.stringify({ path: 'premise.md' }),
    });
    assert.equal(plain.code, 0, plain.err);
    const parsed = JSON.parse(plain.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text, 'got read:premise.md');

    const fail = await h.run(['write', '--path', 'a.md']);
    assert.equal(fail.code, 1);
    assert.ok(fail.err.includes('写入失败'));
  });
});
