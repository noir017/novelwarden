/**
 * 配置与密钥放在哪：新装 `~/.novelwarden`；`NOVELWARDEN_HOME` 能把它挪走。
 *
 * 兼容：旧装的 `~/.novelforge/` 与 `NOVELFORGE_HOME` 继续 fallback——升级之后不能
 * 让作者忽然读不到自己的配置。测试一律把 HOME 指到临时目录，不碰真实主目录。
 */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../helpers/load');

const { homeDir, FileConfigStore } = loadModule('src/core/stores.ts');

const ENV_KEYS = ['HOME', 'USERPROFILE', 'NOVELWARDEN_HOME', 'NOVELFORGE_HOME'];
let home;
let saved;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'novelwarden-home-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NOVELWARDEN_HOME;
  delete process.env.NOVELFORGE_HOME;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('homeDir', () => {
  test('新装缺省是家目录下的 .novelwarden', () => {
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });

  test('NOVELWARDEN_HOME 给了就用它，配置文件跟着走', () => {
    const dir = path.join(os.tmpdir(), 'nf-home-override');
    process.env.NOVELWARDEN_HOME = dir;
    assert.equal(homeDir(), dir);
    assert.equal(new FileConfigStore().filePath, path.join(dir, 'config.json'));
  });

  test('空白的 NOVELWARDEN_HOME 当没给', () => {
    process.env.NOVELWARDEN_HOME = '  ';
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });

  test('旧变量 NOVELFORGE_HOME 仍能挪走配置（升级不断档）', () => {
    const dir = path.join(os.tmpdir(), 'nf-home-legacy-override');
    process.env.NOVELFORGE_HOME = dir;
    assert.equal(homeDir(), dir);
    assert.equal(new FileConfigStore().filePath, path.join(dir, 'config.json'));
  });

  test('两个变量都给时 NOVELWARDEN_HOME 优先', () => {
    process.env.NOVELWARDEN_HOME = path.join(os.tmpdir(), 'nf-home-new');
    process.env.NOVELFORGE_HOME = path.join(os.tmpdir(), 'nf-home-old');
    assert.equal(homeDir(), path.join(os.tmpdir(), 'nf-home-new'));
  });

  test('旧目录 ~/.novelforge 还在、新目录没建时继续用它', () => {
    fs.mkdirSync(path.join(home, '.novelforge'));
    assert.equal(homeDir(), path.join(home, '.novelforge'));
  });

  test('新旧目录都在时用新的 ~/.novelwarden', () => {
    fs.mkdirSync(path.join(home, '.novelforge'));
    fs.mkdirSync(path.join(home, '.novelwarden'));
    assert.equal(homeDir(), path.join(home, '.novelwarden'));
  });
});
