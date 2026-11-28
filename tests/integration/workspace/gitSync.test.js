/**
 * Git 自动同步集成测试：使用真实临时 git 仓库与本地裸仓库（bare repo）验证：
 * - 工程级开关持久化与默认关闭
 * - 自动提交（含变更文件名）与节流合并
 * - 有远端时 pull --rebase + push（含远端先有非冲突新提交与忙碌延后）
 * - 没有远端（仅本地提交）
 * - 不是 git 仓库
 * - pull --rebase 冲突时安全 abort、不丢数据不留冲突标记
 * - 推送失败（坏远端）时保留本地提交并报错提示
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');

let NovelProject;
let GitSyncManager;
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trim();
}

function initGitRepo(dir, branch = 'main') {
  git(dir, ['init', '-b', branch]);
  git(dir, ['config', 'user.name', 'Test Author']);
  git(dir, ['config', 'user.email', 'author@example.com']);
}

async function initNovelDir(dir) {
  const project = NovelProject.open(dir);
  await project.scaffold();
  await project.createManifest({ title: '测试小说', author: '作者' });
  fs.writeFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), '风雪夜归人。\n', 'utf8');
  return project;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('waitFor timed out');
}

before(() => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    gitSync: './src/core/workspace/gitSync.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  NovelProject = bundle.project.NovelProject;
  GitSyncManager = bundle.gitSync.GitSyncManager;
});

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GitSyncManager 集成测试', () => {
  test('默认关闭；开启后持久化到 project.json 且 syncManifest 不冲掉', async () => {
    const dir = makeTempDir('nw-gitsync-cfg-');
    const project = await initNovelDir(dir);
    initGitRepo(dir);

    assert.equal(await project.readGitAutoSync(), false);
    const mgr = new GitSyncManager(project, { throttleMs: 50 });
    try {
      const s0 = await mgr.init();
      assert.equal(s0.enabled, false);
      assert.equal(s0.phase, 'off');

      const s1 = await mgr.setEnabled(true);
      assert.equal(s1.enabled, true);
      assert.equal(await project.readGitAutoSync(), true);

      // syncManifest 重写 project.json 后设置仍在
      await project.syncManifest();
      assert.equal(await project.readGitAutoSync(), true);

      const s2 = await mgr.setEnabled(false);
      assert.equal(s2.enabled, false);
      assert.equal(await project.readGitAutoSync(), false);
    } finally {
      mgr.dispose();
    }
  });

  test('自动提交（含变更文件名）+ 节流合并（无远端时显示仅本地提交）', async () => {
    const dir = makeTempDir('nw-gitsync-local-');
    const project = await initNovelDir(dir);
    initGitRepo(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'init']);

    const statuses = [];
    const mgr = new GitSyncManager(project, {
      throttleMs: 120,
      onStatus: (s) => statuses.push(s),
    });
    try {
      await mgr.setEnabled(true);
      assert.equal(mgr.getStatus().phase, 'localOnly');

      // 节流窗口内连续改 2 个文件并触发多次保存
      fs.writeFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), '风雪夜归人，灯火阑珊。\n', 'utf8');
      mgr.notifyChange('save', 'chapters/001-雪夜.txt');
      fs.writeFileSync(path.join(dir, 'chapters', '002-雨夜.txt'), '第二章正文。\n', 'utf8');
      mgr.notifyChange('save', 'chapters/002-雨夜.txt');

      assert.equal(mgr.getStatus().phase, 'pending');
      await waitFor(() => mgr.getStatus().phase === 'localOnly' && mgr.getStatus().lastCommit);

      // 两次改动合并成了 1 次提交
      const count = Number(git(dir, ['rev-list', '--count', 'HEAD']));
      assert.equal(count, 2);
      const msg = git(dir, ['log', '-1', '--pretty=%B']);
      assert.match(msg, /chapters\/001-雪夜\.txt/);
      assert.match(msg, /chapters\/002-雨夜\.txt/);
      assert.ok(!/Co-Authored-By/i.test(msg));
    } finally {
      mgr.dispose();
    }
  });

  test('有远端时先 pull --rebase 再 push（含远端非冲突新提交与忙碌延后）', async () => {
    const bare = makeTempDir('nw-gitsync-bare-');
    git(bare, ['init', '--bare', '-b', 'main']);

    const dir = makeTempDir('nw-gitsync-work-');
    const project = await initNovelDir(dir);
    initGitRepo(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'init']);
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-u', 'origin', 'main']);

    // 另一份克隆往远端推一个不冲突的新文件
    const peer = makeTempDir('nw-gitsync-peer-');
    git(peer, ['clone', bare, '.']);
    git(peer, ['config', 'user.name', 'Peer']);
    git(peer, ['config', 'user.email', 'peer@example.com']);
    fs.writeFileSync(path.join(peer, 'chapters', '009-番外.txt'), '远端新增番外。\n', 'utf8');
    git(peer, ['add', '-A']);
    git(peer, ['commit', '-m', 'peer add 009']);
    git(peer, ['push']);

    let busy = true;
    let externalChanges = 0;
    const mgr = new GitSyncManager(project, {
      throttleMs: 60,
      idleRetryMs: 80,
      isBusy: () => busy,
      onExternalChange: () => {
        externalChanges++;
      },
    });
    try {
      await mgr.setEnabled(true);
      fs.writeFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), '本地更新第一章。\n', 'utf8');
      mgr.notifyChange('finalize', 'chapters/001-雪夜.txt');

      // 忙碌时先完成本地提交并等待空闲推送
      await waitFor(() => mgr.getStatus().phase === 'pending' && mgr.getStatus().label === '等待空闲推送');
      assert.equal(git(dir, ['status', '--porcelain']), '');

      // 空闲后自动 pull --rebase + push
      busy = false;
      await waitFor(() => mgr.getStatus().phase === 'synced');

      // 远端的 009-番外.txt 已拉回，且触发了 onExternalChange
      assert.equal(fs.existsSync(path.join(dir, 'chapters', '009-番外.txt')), true);
      assert.ok(externalChanges >= 1);

      // 裸仓库已收到本地提交，且提交说明含「同步章节」与文件名
      const remoteMsg = git(bare, ['log', '-1', '--pretty=%B']);
      assert.match(remoteMsg, /同步章节/);
      assert.match(remoteMsg, /chapters\/001-雪夜\.txt/);
    } finally {
      mgr.dispose();
    }
  });

  test('不是 git 仓库时给出清楚提示且不抛错', async () => {
    const dir = makeTempDir('nw-gitsync-norepo-');
    const project = await initNovelDir(dir);
    const notices = [];
    const mgr = new GitSyncManager(project, {
      throttleMs: 50,
      onNotify: (msg, level) => notices.push({ msg, level }),
    });
    try {
      const s = await mgr.setEnabled(true);
      assert.equal(s.phase, 'notRepo');
      assert.equal(s.label, '非 Git 仓库');
      assert.ok(notices.some((n) => n.level === 'error' && /不是 Git 仓库/.test(n.msg)));
    } finally {
      mgr.dispose();
    }
  });

  test('pull --rebase 冲突时安全 abort，保留用户本地文件与提交，不留冲突标记', async () => {
    const bare = makeTempDir('nw-gitsync-conflict-bare-');
    git(bare, ['init', '--bare', '-b', 'main']);

    const dir = makeTempDir('nw-gitsync-conflict-work-');
    const project = await initNovelDir(dir);
    initGitRepo(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'init']);
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-u', 'origin', 'main']);

    // 远端修改同一行
    const peer = makeTempDir('nw-gitsync-conflict-peer-');
    git(peer, ['clone', bare, '.']);
    git(peer, ['config', 'user.name', 'Peer']);
    git(peer, ['config', 'user.email', 'peer@example.com']);
    fs.writeFileSync(path.join(peer, 'chapters', '001-雪夜.txt'), '远端改写的第一行。\n', 'utf8');
    git(peer, ['add', '-A']);
    git(peer, ['commit', '-m', 'peer edit']);
    git(peer, ['push']);

    const notices = [];
    const mgr = new GitSyncManager(project, {
      throttleMs: 50,
      onNotify: (msg, level) => notices.push({ msg, level }),
    });
    try {
      await mgr.setEnabled(true);
      const localContent = '作者本地辛苦写的第一行。\n';
      fs.writeFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), localContent, 'utf8');
      mgr.notifyChange('save', 'chapters/001-雪夜.txt');

      await waitFor(() => mgr.getStatus().phase === 'conflict');
      assert.equal(mgr.getStatus().label, '同步冲突');
      assert.ok(notices.some((n) => n.level === 'error' && /冲突/.test(n.msg)));

      // 文件完好无损，没有冲突标记，工作区干净，rebase 已中止
      const afterText = fs.readFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), 'utf8');
      assert.equal(afterText, localContent);
      assert.ok(!afterText.includes('<<<<<<<'));
      assert.equal(git(dir, ['status', '--porcelain']), '');
    } finally {
      mgr.dispose();
    }
  });

  test('远端不可达/推送失败时保留本地提交并给出错误提示', async () => {
    const dir = makeTempDir('nw-gitsync-fail-');
    const project = await initNovelDir(dir);
    initGitRepo(dir);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'init']);
    // 指向不存在的本地路径模拟远端不可达
    git(dir, ['remote', 'add', 'origin', path.join(dir, '__nonexistent_remote__.git')]);

    const notices = [];
    const mgr = new GitSyncManager(project, {
      throttleMs: 50,
      onNotify: (msg, level) => notices.push({ msg, level }),
    });
    try {
      await mgr.setEnabled(true);
      fs.writeFileSync(path.join(dir, 'chapters', '001-雪夜.txt'), '断网状态下写的新内容。\n', 'utf8');
      const status = await mgr.syncNow();
      assert.equal(status.phase, 'error');
      assert.ok(notices.some((n) => n.level === 'error'));

      // 本地提交已保留
      const count = Number(git(dir, ['rev-list', '--count', 'HEAD']));
      assert.equal(count, 2);
      assert.equal(git(dir, ['status', '--porcelain']), '');
    } finally {
      mgr.dispose();
    }
  });
});
