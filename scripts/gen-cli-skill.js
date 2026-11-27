/**
 * 从源码单点抽取生成 / 更新 `skills/novelwarden-cli/` 技能目录：
 * - `SKILL.md`：连接方式、命令速查、核心原则（取自 `MCP_INSTRUCTIONS`）与全部工具一览表
 * - `references/tools.md`：全部工具的完整说明与参数表（取自 `NOVEL_TOOLS`）
 *
 * 用法：
 *   node scripts/gen-cli-skill.js                 # 生成或更新 skills/novelwarden-cli/
 *   node scripts/gen-cli-skill.js --check         # 校验仓库内技能是否与源码同步（不同步返回 1）
 *   node scripts/gen-cli-skill.js --out <目录>    # 直接同步到指定目录（如 agent 的 skills 目录）
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');
const { embedSkills } = require('./embed-skills');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'skills', 'novelwarden-cli');

function loadSources() {
  embedSkills({ quiet: true });
  const stdin = {
    contents: [
      `export { NOVEL_TOOLS } from './src/core/tools/novel/index.ts';`,
      `export { specOf } from './src/core/tools/registry.ts';`,
      `export { MCP_INSTRUCTIONS } from './src/core/mcp/instructions.ts';`,
      `export { DEFAULT_PORT } from './src/shells/standalone/cli.ts';`,
      `export { URL_ENV, PROJECT_ENV } from './src/shells/standalone/mcpCli.ts';`,
      `export { TOKEN_ENV } from './src/shells/standalone/auth.ts';`,
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  };
  const result = esbuild.buildSync({
    stdin,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('gen-cli-skill-bundle.cjs', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'gen-cli-skill-bundle.cjs'));
  return m.exports;
}

function firstSentence(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  const idx = line.indexOf('。');
  return idx === -1 ? line : line.slice(0, idx + 1);
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function kindLabel(spec) {
  if (!spec.mutating && !spec.costly) {
    return '只读';
  }
  if (spec.mutating && spec.costly) {
    return '写盘·调模型';
  }
  return spec.mutating ? '写盘' : '调模型';
}

function formatType(prop) {
  if (!prop || typeof prop !== 'object') {
    return 'any';
  }
  if (Array.isArray(prop.enum)) {
    return prop.enum.map((v) => `\`${v}\``).join(' \\| ');
  }
  if (prop.type === 'array' && prop.items && prop.items.type) {
    return `${prop.items.type}[]`;
  }
  return String(prop.type ?? 'any');
}

function exampleFor(spec) {
  const props = (spec.parameters && spec.parameters.properties) || {};
  const required = Array.isArray(spec.parameters && spec.parameters.required) ? spec.parameters.required : [];
  const parts = [`novelwarden mcp ${spec.name}`];
  for (const key of required) {
    const p = props[key] || {};
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      parts.push(`--${key} ${p.enum[0]}`);
    } else if (p.type === 'number' || p.type === 'integer') {
      parts.push(`--${key} 1`);
    } else if (p.type === 'boolean') {
      parts.push(`--${key} true`);
    } else if (key === 'path' || key === 'target') {
      parts.push(`--${key} .novelwarden/premise.md`);
    } else {
      parts.push(`--${key} "<值>"`);
    }
  }
  return parts.join(' ');
}

function renderSkillFiles() {
  const { NOVEL_TOOLS, specOf, MCP_INSTRUCTIONS, DEFAULT_PORT, URL_ENV, PROJECT_ENV, TOKEN_ENV } = loadSources();
  const specs = NOVEL_TOOLS.map(specOf);

  const summaryRows = specs.map((spec) => {
    const required = Array.isArray(spec.parameters && spec.parameters.required) ? spec.parameters.required : [];
    const reqText = required.length > 0 ? required.map((k) => `\`${k}\``).join(', ') : '—';
    return `| \`${spec.name}\` | ${kindLabel(spec)} | ${reqText} | ${escapeCell(firstSentence(spec.description))} |`;
  });

  const skillMd = [
    '---',
    'name: novelwarden-cli',
    'description: 通过 Novelwarden CLI（novelwarden mcp）或同端口 HTTP API 操作运行中的 Novelwarden 独立版服务：查工程状态与进度、读写检索工程文件、调用分阶段生成、批量流水线、同步、角色卡、设定、叙事线、拆书与写作技能。适用于无原生 MCP 连接或需要命令行操控 Novelwarden 的场景。',
    '---',
    '',
    '<!-- 由 scripts/gen-cli-skill.js 从源码自动生成，修改工具后运行 npm run skill:cli 更新，勿手改。 -->',
    '',
    '# Novelwarden CLI 操控技能',
    '',
    '通过 `novelwarden mcp` 命令（底层调用同端口 `/api/*` HTTP REST 接口）操作正在运行的 Novelwarden 独立版服务。',
    '',
    '## 1. 连接与环境变量',
    '',
    '| 环境变量 | 说明 | 缺省值 |',
    '|---|---|---|',
    `| \`${URL_ENV}\` | Novelwarden 独立版服务地址 | \`http://127.0.0.1:${DEFAULT_PORT}\` |`,
    `| \`${PROJECT_ENV}\` | 目标小说工程目录（已初始化目录可按需自动加载） | 服务端当前默认工程 |`,
    `| \`${TOKEN_ENV}\` | 访问令牌（开启鉴权时必填，禁止经命令行参数传入） | 无 |`,
    '',
    '若服务跑在本地未安装全局命令，可用仓库内的 `node bin/novelwarden.js mcp ...` 或 `bun run src/shells/standalone/main.ts mcp ...`。',
    '',
    '## 2. 命令速查',
    '',
    '```sh',
    '# 查看已打开工程与状态机给出的下一步',
    'novelwarden mcp status [--url URL] [--project DIR] [--json]',
    '',
    '# 列出全部工具 / 查看单个工具的参数定义',
    'novelwarden mcp tools [工具名] [--json]',
    '',
    '# 调用工具（支持 call <工具名> 或直接省略 call）',
    'novelwarden mcp call <工具名> [--<参数> <值> ...] [--arg k=v ...] [--data \'<json>\'|@file|-]',
    'novelwarden mcp <工具名> [--<参数> <值> ...] [--project DIR] [--json] [--no-stream]',
    '```',
    '',
    '- 长任务（如 `generate`、`pipeline`、`summary`）默认走 SSE 心跳保活，不会因空闲超时断开；按 `Ctrl+C` 断开连接即中断服务端任务。',
    '- 参数传递：`--<参数> <值>` 自动还原布尔、无前导零数字与 JSON 数组/对象（`001` 这类前导零保留为字符串）；复杂长文本优先用 `--data @payload.json` 或 `--data -`（stdin）。',
    '- 纯 HTTP 直调（如 `curl`）：`GET /api/status`、`GET /api/tools`、`POST /api/tools/<工具名>[?project=DIR]`，鉴权头为 `Authorization: Bearer $NOVELWARDEN_TOKEN`。',
    '',
    '## 3. 工作原则',
    '',
    MCP_INSTRUCTIONS,
    '',
    '## 4. 工具一览（共 ' + specs.length + ' 个）',
    '',
    '完整参数与枚举说明见 [references/tools.md](references/tools.md)，或随时运行 `novelwarden mcp tools <工具名>` 查看实时定义。',
    '',
    '| 工具 | 性质 | 必填参数 | 用途 |',
    '|---|---|---|---|',
    ...summaryRows,
    '',
  ].join('\n');

  const detailBlocks = specs.map((spec) => {
    const props = (spec.parameters && spec.parameters.properties) || {};
    const required = new Set(Array.isArray(spec.parameters && spec.parameters.required) ? spec.parameters.required : []);
    const keys = Object.keys(props);
    const lines = [
      `## \`${spec.name}\`（${kindLabel(spec)}）`,
      '',
      spec.description,
      '',
    ];
    if (keys.length > 0) {
      lines.push('| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
      for (const key of keys) {
        const p = props[key];
        lines.push(`| \`${key}\` | ${formatType(p)} | ${required.has(key) ? '是' : '否'} | ${escapeCell(p.description || '')} |`);
      }
      lines.push('');
    } else {
      lines.push('无参数。', '');
    }
    lines.push('```sh', exampleFor(spec), '```', '');
    return lines.join('\n');
  });

  const toolsMd = [
    '<!-- 由 scripts/gen-cli-skill.js 从 src/core/tools/novel/ 自动生成，勿手改。 -->',
    '',
    '# Novelwarden CLI 工具参数参考',
    '',
    ...detailBlocks,
  ].join('\n');

  return {
    'SKILL.md': skillMd,
    'references/tools.md': toolsMd,
  };
}

function readNormalized(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function checkCliSkill(outDir = DEFAULT_OUT) {
  const files = renderSkillFiles();
  const stale = [];
  for (const [rel, expected] of Object.entries(files)) {
    const abs = path.join(outDir, rel);
    if (readNormalized(abs) !== expected) {
      stale.push(rel);
    }
  }
  return stale;
}

function generateCliSkill({ outDir = DEFAULT_OUT, quiet = false } = {}) {
  const files = renderSkillFiles();
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(outDir, rel);
    if (readNormalized(abs) === content) {
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    written.push(rel);
  }
  if (!quiet) {
    const label = path.relative(ROOT, outDir) || outDir;
    if (written.length > 0) {
      console.log(`✓ 已更新 ${label}：${written.join(', ')}`);
    } else {
      console.log(`✓ ${label} 已是最新，无需改动`);
    }
  }
  return written;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let check = false;
  let outDir = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') {
      check = true;
    } else if (argv[i] === '--out') {
      const next = argv[++i];
      if (!next) {
        console.error('错误：--out 缺少目录路径。');
        process.exit(2);
      }
      outDir = path.resolve(next);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法：node scripts/gen-cli-skill.js [--check] [--out <目录>]');
      process.exit(0);
    }
  }
  if (check) {
    const stale = checkCliSkill(outDir);
    if (stale.length > 0) {
      console.error(`skills/novelwarden-cli 已过期（${stale.join(', ')}），请运行 npm run skill:cli 更新。`);
      process.exit(1);
    }
    console.log('✓ skills/novelwarden-cli 与源码同步');
    process.exit(0);
  }
  generateCliSkill({ outDir });
}

module.exports = { DEFAULT_OUT, renderSkillFiles, checkCliSkill, generateCliSkill };
