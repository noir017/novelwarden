/**
 * 架构不变式：`skills/novelwarden-cli/` 与 `src/core/tools/novel/` 及 `MCP_INSTRUCTIONS` 保持同步。
 *
 * 改动工具定义、参数 schema 或 MCP 使用说明后，运行 `npm run skill:cli` 重新生成。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCliSkill } = require('../../scripts/gen-cli-skill');

describe('novelwarden-cli 技能与源码同步', () => {
  test('skills/novelwarden-cli/ 与当前工具定义一致（过期请跑 npm run skill:cli）', () => {
    const stale = checkCliSkill();
    assert.deepEqual(stale, [], '请运行 npm run skill:cli 更新 skills/novelwarden-cli/');
  });
});
