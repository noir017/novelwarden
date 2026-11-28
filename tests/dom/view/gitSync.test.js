/**
 * Git 自动同步界面测试：设置页开关、状态条、立即同步按钮，以及独立版标题栏状态徽标。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

function initProjectState(ui, initialized = true) {
  ui.post({
    type: 'workspaces',
    currentId: 'ws1',
    items: [{ id: 'ws1', root: '/tmp/book', name: 'book' }],
    recents: [],
  });
  ui.post({
    type: 'init',
    state: {
      initialized,
      plots: [],
      nextNo: 1,
      staleCount: 0,
      model: '',
      modelLabel: '',
      models: [],
      contextDetail: 3,
      contextWindow: 0,
      maxOutputTokens: 0,
      paragraphStyle: 'blank',
    },
  });
}

describe('Git 自动同步前端界面', { skip: JSDOM_SKIP }, () => {
  test('默认关闭；勾选发送 setGitAutoSync；点击立即同步发送 gitSyncNow', () => {
    const ui = mount({ body: 'standalone' });
    initProjectState(ui, true);

    const checkbox = ui.doc.getElementById('setGitAutoSync');
    const badge = ui.doc.getElementById('gitSyncBadge');
    const detail = ui.doc.getElementById('gitSyncDetail');
    const nowBtn = ui.doc.getElementById('gitSyncNowBtn');
    const pill = ui.doc.getElementById('wbGitSync');

    assert.equal(checkbox.disabled, false);
    assert.equal(checkbox.checked, false);
    assert.equal(badge.textContent, '已关闭');
    assert.equal(pill.classList.contains('hidden'), true);
    assert.equal(nowBtn.classList.contains('hidden'), true);

    checkbox.checked = true;
    checkbox.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    const toggleMsg = ui.sent.find((m) => m.type === 'setGitAutoSync');
    assert.ok(toggleMsg);
    assert.equal(toggleMsg.enabled, true);

    // 后端推送已同步状态
    ui.post({
      type: 'gitSync',
      status: {
        enabled: true,
        phase: 'synced',
        label: '已同步',
        detail: '已同步到远端 origin（abc1234）',
        lastSyncAt: Date.now(),
        hasRemote: true,
      },
    });
    assert.equal(badge.textContent, '已同步');
    assert.ok(badge.classList.contains('is-ok'));
    assert.match(detail.textContent, /已同步到远端 origin/);
    assert.equal(nowBtn.classList.contains('hidden'), false);
    assert.equal(pill.classList.contains('hidden'), false);
    assert.match(pill.textContent, /已同步/);

    nowBtn.click();
    assert.ok(ui.sent.some((m) => m.type === 'gitSyncNow'));
  });

  test('冲突、非 Git 仓库、仅本地提交状态清晰展示，点击标题栏徽标跳转通用设置', () => {
    const ui = mount({ body: 'standalone' });
    initProjectState(ui, true);

    const badge = ui.doc.getElementById('gitSyncBadge');
    const nowBtn = ui.doc.getElementById('gitSyncNowBtn');
    const pill = ui.doc.getElementById('wbGitSync');

    ui.post({
      type: 'gitSync',
      status: { enabled: true, phase: 'notRepo', label: '非 Git 仓库', detail: '当前工程目录不是 Git 仓库' },
    });
    assert.equal(badge.textContent, '非 Git 仓库');
    assert.ok(badge.classList.contains('is-warn'));
    assert.equal(nowBtn.classList.contains('hidden'), true);
    assert.ok(pill.classList.contains('is-warn'));

    ui.post({
      type: 'gitSync',
      status: { enabled: true, phase: 'conflict', label: '同步冲突', detail: '已自动中止变基以保护本地文件' },
    });
    assert.equal(badge.textContent, '同步冲突');
    assert.ok(badge.classList.contains('is-error'));
    assert.ok(pill.classList.contains('is-error'));

    // 点击标题栏徽标跳到设置 → 通用
    pill.click();
    assert.ok(ui.doc.getElementById('pane-settings').classList.contains('active'));
    assert.ok(ui.doc.getElementById('settingsPanelGeneral').classList.contains('active'));
  });
});
