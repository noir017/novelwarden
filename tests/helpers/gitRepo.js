/**
 * 在临时目录里造一个 git 仓库（「版本」时间线的 git 来源要真仓库才测得出改名、子目录、字面路径）。
 *
 * 与本机的 git 配置隔开：不读全局配置（`GIT_CONFIG_GLOBAL` 指向空、`GIT_CONFIG_NOSYSTEM`），不签名、不跑钩子；
 * 作者与时间写死，提交时间由调用方给（秒），排序断言才稳。机器上没有 git 时 `HAS_GIT` 为 false，用例整组跳过。
 */
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

function env(time) {
  const date = time === undefined ? undefined : `${time} +0800`;
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: '作者',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: '作者',
    GIT_COMMITTER_EMAIL: 'author@example.com',
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
}

/** 在 `dir` 里跑一条 git，返回 stdout（字符串）。 */
function git(dir, args, time) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + os.devNull, ...args], {
    cwd: dir,
    env: env(time),
    encoding: 'utf8',
  });
}

function gitInit(dir) {
  git(dir, ['init', '-q']);
}

/** 把工作区全部提交一次（`time`：秒）。返回提交号。 */
function gitCommitAll(dir, message, time) {
  git(dir, ['add', '-A'], time);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], time);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** 某个路径在某次提交里的 blob（相对仓库根）。 */
function blobOf(dir, commit, relFromTop) {
  return git(dir, ['rev-parse', `${commit}:${relFromTop.split(path.sep).join('/')}`]).trim();
}

module.exports = { HAS_GIT, git, gitInit, gitCommitAll, blobOf };
