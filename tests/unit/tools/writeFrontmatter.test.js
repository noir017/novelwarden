/**
 * `write` 工具对角色卡 / 设定条目的 YAML frontmatter 轻量前置校验：
 * - 拦截明显损坏的 frontmatter（未闭合 `---`、压成标题行或单行、非法断行、数组未闭合、角色卡缺 `name`），不落盘
 * - 遵循第 1 条容错精神：不带 frontmatter 的合法手写 Markdown 卡片照常放行；append 模式不拦
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let ctx;

const writeTool = () => bundle.tools.NOVEL_TOOLS.find((x) => x.name === 'write');
const run = (args) => writeTool().run(ctx, args);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    tools: './src/core/tools/novel/index.ts',
    write: './src/core/tools/novel/write.ts',
    db: './src/core/runtime/db.ts',
  });
  const h = makeFakeHost({ name: 'standalone', settings: () => ({}) });
  h.setReviewVerdict('apply');
  bundle.host.initHost(h.host);

  t = await makeTempProject(bundle.project, { prefix: 'write-fm', title: '校验测试' });
  ctx = {
    project: t.project,
    workspace: new bundle.ws.Workspace(t.project),
    drafts: { get: () => undefined, put: () => {}, bySession: () => [] },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report: () => {},
    onDelta: () => {},
  };
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

describe('validateCardFrontmatter 纯函数校验', () => {
  const check = (kind, text) => bundle.write.validateCardFrontmatter(kind, text);

  test('拦截未闭合的 ---', () => {
    const err = check('character', '---\nname: 林汐\naliases: [汐儿]\n\n# 林汐\n');
    assert.ok(err && err.includes('没有成对闭合'), err);
  });

  test('拦截开头 --- 与字段写在同一行', () => {
    const err = check('character', '--- name: 林汐 ---\n\n# 林汐\n');
    assert.ok(err && err.includes('单独占一行'), err);
  });

  test('拦截 --- 前有空行或空格', () => {
    const err = check('lore', '\n---\ntitle: 青云宗\n---\n');
    assert.ok(err && err.includes('第一行'), err);
  });

  test('拦截被压成标题行的 frontmatter（## name: ... / ## title: ...）', () => {
    const e1 = check('character', '## name: 林汐 aliases: [汐儿] tags: [配角]\n\n正文');
    assert.ok(e1 && e1.includes('压成了标题行'), e1);

    const e2 = check('lore', '# title: 青云宗 keywords: [宗门]\n\n正文');
    assert.ok(e2 && e2.includes('压成了标题行'), e2);
  });

  test('拦截单行塞多个字段的畸形 frontmatter（带 --- 与不带 ---）', () => {
    const e1 = check('character', '---\nname: 林汐 aliases: [汐儿] tags: [配角]\n---\n\n正文');
    assert.ok(e1 && e1.includes('压在同一行'), e1);

    const e2 = check('character', 'name: 林汐 aliases: [汐儿] tags: [配角]\n\n正文');
    assert.ok(e2 && e2.includes('缺少 ---'), e2);
  });

  test('拦截 frontmatter 内的非法断行与未闭合数组', () => {
    const e1 = check('character', '---\nname: 林汐\n这是一行断掉的文字\n---\n');
    assert.ok(e1 && e1.includes('无法解析的行'), e1);

    const e2 = check('character', '---\nname: 林汐\naliases: [汐儿,\n  林姑娘]\n---\n');
    assert.ok(e2 && e2.includes('数组未闭合'), e2);
  });

  test('拦截角色卡 frontmatter 缺少有效 name 或设定条目 title 为空', () => {
    const e1 = check('character', '---\naliases: [汐儿]\ntags: [配角]\n---\n\n# 林汐\n');
    assert.ok(e1 && e1.includes('name'), e1);

    const e2 = check('character', '---\nname:\n---\n\n# 林汐\n');
    assert.ok(e2 && e2.includes('name'), e2);

    const e3 = check('lore', '---\ntitle:\nkeywords: [青云]\n---\n\n# 青云宗\n');
    assert.ok(e3 && e3.includes('title'), e3);
  });

  test('放行合法的 YAML frontmatter（行内数组、块状数组、注释、带引号）', () => {
    assert.equal(
      check('character', '---\n# 主角\nname: "林汐"\naliases:\n  - 汐儿\n  - 小林\ntags: [主角]\n---\n\n# 林汐\n'),
      undefined
    );
    assert.equal(
      check('lore', '---\ntitle: 青崖镇\nkeywords: [青崖, 停舟]\nbrief: 偏僻小镇\n---\n\n# 青崖镇\n'),
      undefined
    );
  });

  test('放行不带 frontmatter 的合法手写 Markdown 卡片（第 1 条容错）', () => {
    assert.equal(check('character', '# 林昭\n\n## 身份\n\n北地少年。\n'), undefined);
    assert.equal(check('lore', '# 青崖镇\n\n偏僻小镇。\n'), undefined);
  });
});

describe('write 工具落盘前置校验', () => {
  test('损坏的角色卡 frontmatter 直接报错且不落盘', async () => {
    const rel = '.novelwarden/characters/损坏角色.md';
    const r = await run({
      path: rel,
      content: '## name: 损坏角色 aliases: [阿坏]\n\n## 身份\n\n测试。',
    });
    assert.ok(r.error && r.error.includes('压成了标题行'), JSON.stringify(r));
    assert.equal(t.has(rel), false, '校验失败不应落盘');
  });

  test('未闭合 --- 的设定条目在 overwrite 时同样被拦且保留原文件', async () => {
    const rel = '.novelwarden/lore/青崖镇.md';
    const good = '---\ntitle: 青崖镇\nkeywords: [青崖]\n---\n\n# 青崖镇\n\n小镇。\n';
    const ok = await run({ path: rel, content: good });
    assert.equal(ok.error, undefined, ok.error);

    const bad = await run({
      path: rel,
      mode: 'overwrite',
      content: '---\ntitle: 青崖镇\nkeywords: [青崖]\n\n# 青崖镇\n',
    });
    assert.ok(bad.error && bad.error.includes('没有成对闭合'), JSON.stringify(bad));
    assert.equal(t.read(rel), good, 'overwrite 被拦时磁盘内容不能被破坏');
  });

  test('合法手写无 frontmatter 角色卡与 append 模式正常放行', async () => {
    const rel = '.novelwarden/characters/手写角色.md';
    const r1 = await run({ path: rel, content: '# 手写角色\n\n## 身份\n\n手写内容。\n' });
    assert.equal(r1.error, undefined, r1.error);
    assert.equal(t.has(rel), true);

    const r2 = await run({ path: rel, mode: 'append', content: '\n---\n补充一段分隔线后的备注。\n' });
    assert.equal(r2.error, undefined, r2.error);
    assert.ok(t.read(rel).includes('补充一段分隔线后的备注'));
  });
});
