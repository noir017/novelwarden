/**
 * 旧工程元数据目录（`.novelforge/` / `.novel/`）兼容：
 * - `resolveToolPath` 将 `.novelwarden` / `.novelwarden/...` 映射到实际目录（仅当旧目录生效且工程根无 `.novelwarden/`）
 * - `list` / `read` / `write` / `edit` / `search` 经 `.novelwarden/...` 透明落到旧目录，且绝不新建 `.novelwarden/`
 * - `buildStateBrief` 在旧工程输出 `元数据目录：.novelforge/`（或 `.novel/`），新工程不打扰
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let legacy;
let modern;
let oldV1;

function makeCtx(project) {
  return {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
}

const toolOf = (name) => bundle.tools.NOVEL_TOOLS.find((x) => x.name === name);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    tools: './src/core/tools/novel/index.ts',
    naming: './src/core/tools/novel/naming.ts',
    stateBrief: './src/core/views/stateBrief.ts',
    db: './src/core/runtime/db.ts',
  });
  const h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  h.setReviewVerdict('apply');
  bundle.host.initHost(h.host);

  // 旧工程（.novelforge/）
  legacy = await makeTempProject(bundle.project, { prefix: 'legacy-nf', title: '旧书' });
  fs.renameSync(legacy.rel('.novelwarden'), legacy.rel('.novelforge'));
  legacy.project = bundle.project.NovelProject.open(legacy.dir);
  legacy.write('.novelforge/config.md', '# 小说配置\n\n## 核心梗概\n\n旧工程配置。\n');
  legacy.write(
    '.novelforge/characters/林昭.md',
    '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n青崖旧人。\n'
  );
  legacy.project.invalidate();

  // 更老的工程（.novel/）
  oldV1 = await makeTempProject(bundle.project, { prefix: 'legacy-v1', title: '更旧的书' });
  fs.renameSync(oldV1.rel('.novelwarden'), oldV1.rel('.novel'));
  oldV1.project = bundle.project.NovelProject.open(oldV1.dir);
  oldV1.project.invalidate();

  // 新工程（.novelwarden/）
  modern = await makeTempProject(bundle.project, { prefix: 'modern-nw', title: '新书' });
  modern.write('.novelwarden/config.md', '# 小说配置\n\n## 核心梗概\n\n新工程配置。\n');
  modern.write(
    '.novelwarden/characters/沈青.md',
    '---\nname: 沈青\ntags: [配角]\n---\n\n# 沈青\n\n## 身份\n\n新工程角色。\n'
  );
  modern.project.invalidate();
});

after(() => {
  if (legacy) cleanup(legacy.dir, bundle && bundle.db);
  if (oldV1) cleanup(oldV1.dir, bundle && bundle.db);
  if (modern) cleanup(modern.dir, bundle && bundle.db);
});

describe('resolveToolPath 映射规则', () => {
  test('旧工程 .novelforge/ 下自动映射 .novelwarden 前缀', () => {
    const map = (p) => bundle.naming.resolveToolPath(legacy.project, p);
    assert.equal(map('.novelwarden'), '.novelforge');
    assert.equal(map('.novelwarden/'), '.novelforge');
    assert.equal(map('.novelwarden/characters'), '.novelforge/characters');
    assert.equal(map('./.novelwarden/config.md'), '.novelforge/config.md');
    assert.equal(map('chapters/001.md'), 'chapters/001.md');
    assert.equal(map('.novelforge/config.md'), '.novelforge/config.md');
    assert.equal(map('.novelwarden-extra/a.md'), '.novelwarden-extra/a.md');
    assert.equal(map('../../etc/passwd'), '../../etc/passwd');
  });

  test('旧工程 .novel/ 下自动映射为 .novel', () => {
    assert.equal(bundle.naming.resolveToolPath(oldV1.project, '.novelwarden/characters'), '.novel/characters');
  });

  test('新工程 .novelwarden/ 保持原样不受影响', () => {
    assert.equal(bundle.naming.resolveToolPath(modern.project, '.novelwarden/characters'), '.novelwarden/characters');
    assert.equal(bundle.naming.resolveToolPath(modern.project, '.novelwarden/config.md'), '.novelwarden/config.md');
  });
});

describe('旧工程 .novelforge/ 经 .novelwarden/ 路径调用工具', () => {
  test('list .novelwarden/characters 返回 .novelforge/characters 里的角色卡', async () => {
    const r = await toolOf('list').run(makeCtx(legacy.project), { path: '.novelwarden/characters' });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('林昭.md'), r.text);
    assert.ok(r.text.startsWith('.novelforge/characters'), r.text);
  });

  test('read .novelwarden/config.md 读到 .novelforge/config.md', async () => {
    const r = await toolOf('read').run(makeCtx(legacy.project), { path: '.novelwarden/config.md' });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('旧工程配置'), r.text);
    assert.ok(r.text.startsWith('.novelforge/config.md\n'), r.text);
  });

  test('write .novelwarden/characters/林汐.md 落到 .novelforge/ 且绝不新建 .novelwarden/', async () => {
    const card = '---\nname: 林汐\ntags: [配角]\n---\n\n# 林汐\n\n## 身份\n\n医女。\n';
    const r = await toolOf('write').run(makeCtx(legacy.project), {
      path: '.novelwarden/characters/林汐.md',
      content: card,
    });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.text.includes('.novelforge/characters/林汐.md'), r.text);
    assert.equal(legacy.has('.novelforge/characters/林汐.md'), true);
    assert.equal(legacy.has('.novelwarden'), false, '绝不能在旧工程旁静默新建 .novelwarden/');
  });

  test('edit 与 search 同样走映射', async () => {
    const ed = await toolOf('edit').run(makeCtx(legacy.project), {
      path: '.novelwarden/characters/林汐.md',
      old: '医女。',
      new: '游方医女。',
    });
    assert.equal(ed.error, undefined, ed.error);
    assert.ok(legacy.read('.novelforge/characters/林汐.md').includes('游方医女。'));

    const sr = await toolOf('search').run(makeCtx(legacy.project), {
      pattern: '游方医女',
      path: '.novelwarden/characters',
    });
    assert.equal(sr.error, undefined, sr.error);
    assert.ok(sr.text.includes('.novelforge/characters/林汐.md'), sr.text);
  });

  test('新工程 .novelwarden/ 的 list / read / write 行为不变', async () => {
    const ls = await toolOf('list').run(makeCtx(modern.project), { path: '.novelwarden/characters' });
    assert.ok(ls.text.includes('沈青.md'), ls.text);
    const rd = await toolOf('read').run(makeCtx(modern.project), { path: '.novelwarden/config.md' });
    assert.ok(rd.text.includes('新工程配置'), rd.text);
  });
});

describe('stateBrief 旧目录提示', () => {
  test('旧工程 .novelforge/ 与 .novel/ 输出实际元数据目录', async () => {
    const b1 = await bundle.stateBrief.buildStateBrief(legacy.project);
    assert.ok(b1.includes('元数据目录：.novelforge/'), b1);

    const b2 = await bundle.stateBrief.buildStateBrief(oldV1.project);
    assert.ok(b2.includes('元数据目录：.novel/'), b2);
  });

  test('新工程 .novelwarden/ 不输出元数据目录提示行', async () => {
    const b = await bundle.stateBrief.buildStateBrief(modern.project);
    assert.equal(b.includes('元数据目录：'), false, b);
  });
});
