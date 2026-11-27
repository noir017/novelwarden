/**
 * MCP 普通 HTTP REST 传输（`src/core/mcp/rest.ts`）：只测传输与路由，用假 `McpBackend`。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mcp = loadModule('src/core/mcp/index.ts');

function fakeBackend() {
  const b = {
    calls: [],
    brief: '# 当前工程\n下一步：写第 1 章细纲',
    reply: (name, args) => ({ text: `ran ${name} ${JSON.stringify(args)}`, isError: false }),
    hold: undefined,
    backend: {
      call: async (name, args, signal) => {
        b.calls.push({ name, args, signal });
        if (b.hold) {
          await b.hold(signal);
        }
        return b.reply(name, args);
      },
      brief: async () => b.brief,
    },
  };
  return b;
}

function makeRest({ backend, projects, allowOrigin, heartbeatMs } = {}) {
  return mcp.createNovelRest(
    typeof backend === 'function' ? backend : () => backend,
    {
      ...(projects ? { projects } : {}),
      ...(allowOrigin ? { allowOrigin } : {}),
      ...(heartbeatMs ? { heartbeatMs } : {}),
    }
  );
}

describe('HTTP REST /api/tools', () => {
  test('GET /api/tools 列出十三个工具及只读/写盘标记', async () => {
    const h = makeRest();
    const res = await h.handle(new Request('http://127.0.0.1:36800/api/tools'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tools.length, 13);
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]));
    assert.equal(byName.list.readOnly, true);
    assert.equal(byName.list.mutating, false);
    assert.equal(byName.write.readOnly, false);
    assert.equal(byName.write.mutating, true);
    assert.equal(byName.generate.costly, true);
  });

  test('GET /api/tools/:name 返回单个工具，不存在回 404', async () => {
    const h = makeRest();
    const ok = await h.handle(new Request('http://127.0.0.1:36800/api/tools/read'));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.tool.name, 'read');
    assert.ok(body.tool.parameters);

    const miss = await h.handle(new Request('http://127.0.0.1:36800/api/tools/nope'));
    assert.equal(miss.status, 404);
  });
});

describe('HTTP REST /api/status', () => {
  test('返回已打开工程与状态简报', async () => {
    const fb = fakeBackend();
    const h = makeRest({
      backend: async () => fb.backend,
      projects: () => ({ open: ['/books/a', '/books/b'], default: '/books/a' }),
    });
    const res = await h.handle(new Request('http://127.0.0.1:36800/api/status'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.connected, true);
    assert.equal(body.project, '/books/a');
    assert.deepEqual(body.projects.open, ['/books/a', '/books/b']);
    assert.equal(body.brief, fb.brief);
  });

  test('没打开工程时 connected 为 false、brief 为 null', async () => {
    const h = makeRest({ backend: undefined, projects: () => ({ open: [], default: undefined }) });
    const res = await h.handle(new Request('http://127.0.0.1:36800/api/status'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connected, false);
    assert.equal(body.brief, null);
  });
});

describe('HTTP REST POST /api/tools/:name', () => {
  test('JSON 模式：透传参数、支持异步 backend 与 ?project=、回 ok/text/brief', async () => {
    const fb = fakeBackend();
    let seenProject;
    const h = makeRest({
      backend: async (project) => {
        seenProject = project;
        return fb.backend;
      },
    });
    const res = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools/list?project=%2Fbooks%2Fdemo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'chapters' }),
      })
    );
    assert.equal(res.status, 200);
    assert.equal(seenProject, '/books/demo');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.text, 'ran list {"path":"chapters"}');
    assert.equal(body.brief, fb.brief);
  });

  test('SSE 模式：发 progress 心跳并最终回 result 事件', async () => {
    const fb = fakeBackend();
    fb.hold = () => new Promise((r) => setTimeout(r, 45));
    const h = makeRest({ backend: fb.backend, heartbeatMs: 15 });
    const res = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: '{}',
      })
    );
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes(': open'), text);
    assert.ok(text.includes('event: progress'), text);
    assert.ok(text.includes('event: result'), text);
    const m = /event: result\ndata: (.+)\n/.exec(text);
    assert.ok(m);
    const payload = JSON.parse(m[1]);
    assert.equal(payload.ok, true);
    assert.equal(payload.text, 'ran list {}');
  });

  test('错误与防护：未知工具 404、坏 JSON 400、没工程 400、方法错 405、跨源 403', async () => {
    const h = makeRest({
      backend: undefined,
      allowOrigin: (origin) => !origin || origin === 'http://127.0.0.1:36800',
    });

    const badOrigin = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools', { headers: { origin: 'http://evil.example' } })
    );
    assert.equal(badOrigin.status, 403);

    const badMethod = await h.handle(new Request('http://127.0.0.1:36800/api/tools', { method: 'DELETE' }));
    assert.equal(badMethod.status, 405);

    const unknown = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools/unknown', { method: 'POST', body: '{}' })
    );
    assert.equal(unknown.status, 404);

    const badJson = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools/list', { method: 'POST', body: '{bad' })
    );
    assert.equal(badJson.status, 400);

    const noProj = await h.handle(
      new Request('http://127.0.0.1:36800/api/tools/list', { method: 'POST', body: '{}' })
    );
    assert.equal(noProj.status, 400);
  });
});
