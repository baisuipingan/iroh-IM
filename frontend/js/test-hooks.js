/* ============================================================================
 * js/test-hooks.js · 自动化测试的统一入口
 *
 * ## 为什么单独成文件
 *
 * 这些钩子原来散在 `main.js`（19 个）和 `filetransfer.js`（16 个）的**模块顶层**，
 * 无条件地`window.__xxx = ...`。代价有三个：
 *
 *   1. **污染全局**：任何页面脚本/浏览器扩展都能看到并调用它们
 *   2. **分不清哪些是给测试用的**：打开控制台看到 `__iroh_sendText`、`__iroh_clearBitmaps`
 *      会以为是什么神秘功能
 *   3. **改一个名字要翻两个文件**：e2e 脚本按字符串查找，漏改就是"钩子不存在"
 *
 * 现在：全部集中到本文件，名字统一 `__iroh_` 前缀（避免与别的项目/库撞名），
 * 由 `main.js` 在启动时**显式调一次** `installTestHooks()`。
 * 要彻底不带上这些出口，把 main.js 里那行调用删掉即可（不影响任何真实功能）。
 *
 * ⚠️ **改名时记得同步改调用方** —— `scripts/e2e/*.py`、`scripts/e2e/*.mjs`、
 *    `scripts/transfer-test.py`、`scripts/transfer-bench.mjs` 里都是按字符串查找的。
 * ==========================================================================*/

import { composer } from './ui/composer.js';
import { fileTransfer, canTransferFiles, installTransferTestHooks } from './ui/filetransfer.js';
import { net } from './net.js';
import { notify } from './ui/notify.js';
import { sidebar } from './ui/sidebar.js';
import { store } from './store.js';
import { theme } from './ui/theme.js';
import { topology } from './ui/topology.js';

/** main.js 的 openRoom 转发（它是 main.js 的模块私有函数，这里拿不到，由调用方注入） */
let openRoomFn = null;
/** composer 的两个私有方法（`_autoGrow` / `_syncSendBtn`），同样由 main.js 注入 */
let composerInternals = null;
/** main.js 里 `__state` 要读的两个模块私有变量（`__state` 是唯一没加 `__iroh_` 前缀的钩子
 *  —— 它被 130+ 处引用，改名代价大于收益），由 main.js 注入读取器 */
let stateReaders = {};

/**
 * 装上全部测试钩子。由 main.js 在启动时调一次。
 * @param {object} deps
 * @param {Function} deps.openRoom          main.js 的 openRoom（供 __iroh_openRoom 转发）
 * @param {object}   deps.composerInternals { autoGrow, syncSendBtn }
 * @param {object}   deps.readers           { myId(), joinedRoom() } —— main.js 的模块私有变量
 */
export function installTestHooks({ openRoom, composerInternals: ci, readers } = {}) {
  openRoomFn = openRoom || null;
  composerInternals = ci || null;
  stateReaders = readers || {};

  /* ---------- 应用状态（e2e 断言的主要入口） ---------- */

  window.__state = () => {
    const tl = document.getElementById('timeline');
    const cp = document.getElementById('composer');
    const r = cp.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      node: document.querySelector('#node-pill .pill__text')?.textContent,
      phase: net.phase,
      canSend: net.canSend,
      myId: stateReaders.myId?.() ?? '',
      nick: store.nick(),
      room: sidebar.currentRoom,
      /** 房间确实 join 完成（不是只有 UI 切过去了）——测试必须等它 */
      joined: stateReaders.joinedRoom?.() ?? null,
      composerEnabled: composer.enabled,
      peers: sidebar.peers.map((x) => x.nickname).join(' / '),
      rooms: store.rooms().map((x) => x.name),
      unread: sidebar.totalUnread(),
      messages: [...document.querySelectorAll('.msg:not(.msg--me):not(.msg--failed) .bubble')].map((e) => e.textContent),
      mine: [...document.querySelectorAll('.msg--me:not(.msg--failed) .bubble')].map((e) => e.textContent),
      failed: [...document.querySelectorAll('.msg--failed .bubble')].map((e) => e.textContent),
      imgs: document.querySelectorAll('.bubble img').length,
      dividers: [...document.querySelectorAll('.tl-day')].map((e) => e.textContent),
      notes: [...document.querySelectorAll('.tl-note')].map((e) => e.textContent).slice(-5),
      emptyState: !!document.querySelector('.tl-empty'),
      // 界面状态（供回归用例断言，都是真实值的镜像）
      ui: {
        channel: document.getElementById('channel-text')?.textContent ?? '',
        panelFoot: document.getElementById('panel-foot-text')?.textContent ?? '',
        connFoot: document.getElementById('conn-foot-text')?.textContent ?? '',
        members: document.getElementById('room-members')?.hidden ? '' : (document.getElementById('room-members-text')?.textContent ?? ''),
        filter: sidebar.roomFilter,
        bubbles: document.querySelectorAll('.ambient__b').length,
        roomTags: [...document.querySelectorAll('#panel-body .row__tag')].map((e) => e.textContent),
        // 视图切换 + 中继拓扑
        view: topology.view,
        topoVisible: !!document.querySelector('.topology.is-on'),
        topoText: (document.getElementById('topology')?.innerText || '').replace(/\s+/g, ' ').trim(),
        topoMetrics: [...document.querySelectorAll('.topo-card__num')].map((e) => e.textContent.trim()),
        // 桌面通知
        notifyOn: store.prefs().notify === true,
        notifyPerm: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
      },
      // 布局自检：这些值直接反映"滚不动 / 输入框出屏"
      layout: {
        winH: window.innerHeight,
        timelineH: tl.clientHeight,
        timelineScrollable: tl.scrollHeight > tl.clientHeight,
        composerInViewport: r.bottom <= window.innerHeight + 1 && r.top >= 0,
        bodyOverflow: getComputedStyle(document.body).overflow,
      },
    };
  };

  /* ---------- 导航 / 操作 ---------- */

  window.__iroh_openRoom = (r) => openRoomFn?.(r);
  window.__iroh_openNewRoom = () => sidebar.newRoom();
  window.__iroh_openSettings = () => sidebar.show('settings');
  window.__iroh_openTheme = () => theme.toggle();
  /** 直接操作网络层（模拟掉线、强制重连等） */
  window.__iroh_net = net;

  /**
   * 主题的调试/测试接口：设偏好，不带参数则返回当前状态。
   * 测试必须能**确定性地设置偏好**，否则跑出来的主题取决于跑测试那台机器的系统设置。
   */
  window.__iroh_theme = (pref) => {
    if (pref) theme.apply(pref);
    return { pref: theme.pref, current: theme.current, dataset: document.documentElement.dataset.theme };
  };
  window.__iroh_openEmoji = () => document.getElementById('tb-emoji').click();

  /** 切换会话列表筛选（all / pinned / unread），返回当前值 */
  window.__iroh_setRoomFilter = (f) => {
    const chip = document.querySelector(`#panel-tabs .tab-chip[data-filter="${f}"]`);
    if (chip) chip.click();
    return sidebar.roomFilter;
  };

  /** 切视图（chat / topology），返回当前值 */
  window.__iroh_view = (v) => {
    if (v) topology.show(v);
    return topology.view;
  };

  /**
   * 桌面通知的标题/正文（**不真的弹**）。
   * 用来钉死"关掉内容开关后正文里不能出现消息文本"这条隐私断言。
   */
  window.__iroh_notifyBody = (room, message, prefs) => notify.bodyFor(room, message, prefs);

  /* ---------- 发消息 / 附件 ---------- */

  window.__iroh_sendText = (t) => {
    const input = document.getElementById('input');
    input.value = t;
    composerInternals?.autoGrow();
    composerInternals?.syncSendBtn();
    return composer.send();
  };
  /** 把文件塞进待发送区（等价于粘贴或拖拽） */
  window.__iroh_addFiles = (files) => composer.addFiles(files);
  /** 点发送（会先发文字再逐个发起附件） */
  window.__iroh_send = () => composer.send();

  /* ---------- 文件传输专用（需要 filetransfer 的闭包私有名） ---------- */

  installTransferTestHooks(net);
  /** 直接发起一次文件发送（绕过 <input type=file>） */
  window.__iroh_sendFile = (file, room) => fileTransfer.pickAndSend(file, room);
  /** 点历史文件卡片上的「接收」 */
  window.__iroh_openArchived = (fileId) => fileTransfer.openArchived(fileId);
  /** isSecureContext 在 http://127.0.0.1 下为 true，可用；这里给测试一个明确开关 */
  window.__iroh_canTransferFiles = () => canTransferFiles();
  /** 构造一个内存文件（测试用） */
  window.__iroh_makeFile = (name, bytes) =>
    new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
  /** 让发送方只发前 n 块就主动断连（0 = 恢复正常） */
  window.__iroh_setStopAfterChunks = (n) => net.client.post({ type: 'stopAfterChunks', n });
}