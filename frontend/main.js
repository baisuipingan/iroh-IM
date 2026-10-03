/* ============================================================================
 * main.js · 应用入口（组装层）
 *
 * 只做三件事：
 *   1. 初始化各视图模块
 *   2. 把"进房间"这条主流程串起来（网络 + 视觉）
 *   3. 把跨模块的事件接到一起
 *
 * 具体实现都在 js/ 下：
 *   bus / store / util      —— 内核（无 DOM 副作用）
 *   net                     —— 唯一接触 wasm 的地方
 *   ui/theme dialog sidebar timeline composer
 * ==========================================================================*/

import { bus, EV } from './js/bus.js';
import { net } from './js/net.js';
import { store } from './js/store.js';
import * as U from './js/util.js';
import { dialog } from './js/ui/dialog.js';
import { theme } from './js/ui/theme.js';
import { sidebar } from './js/ui/sidebar.js';
import { timeline } from './js/ui/timeline.js';
import { composer } from './js/ui/composer.js';
import { fileTransfer, canTransferFiles } from './js/ui/filetransfer.js';
// 注意：**不要在主线程 import wasm**。iroh 已经整体搬进 Worker
// （`js/iroh-worker.js`），主线程再 import 一次会白加载 3.4MB 的 wasm
// 而且那份实例和应用用的是两套状态（踩过：`set_stop_after_chunks` 报 undefined）。

const $ = (id) => document.getElementById(id);

let myId = '';
/** 已成功加入的房间（join 完成后才有值）。测试与状态自检用。 */
let joinedRoom = null;
/** 正在进房的 Promise：用来避免连点房间时并发 join 把状态搞乱 */
let opening = null;
/**
 * 断线时点了、但**没能真正 join** 的房间。
 *
 * ⚠️ 为什么需要它：上面的离线分支只切了界面、并没有把房间记到 `net._room`，
 * 而 `net` 的"重连后自动回到原房间"靠的就是 `_room` —— 于是：
 * 断开时点一下房间 → 界面停在那个房间 → 网络恢复 → **永远不会真的进房**。
 * 用户看到的是一个"正常"的聊天界面，但一条消息都收不到、发送必失败。
 * （原来那句"恢复后会自动回到这个房间"是句空话。）
 * 现在把它记下来，节点一恢复就补进一次。
 */
let pendingRoom = '';
/** 进房期间用户又点了的房间（等当前这次结束后接着开） */
let queuedRoom = '';

/* ------------------------------------------------------------------ 进房间 */

async function openRoom(room) {
  if (!room) return;
  // 已经在进一个房间了：记下这次请求，等当前这次结束后再进（见下面 finally）
  if (opening) {
    queuedRoom = room;
    return opening;
  }
  const label = store.room(room)?.alias || room;
  $('room-title').textContent = label;

  opening = (async () => {
    sidebar.setRoom(room);
    store.upsertRoom(room, { last: Date.now() });
    store.setLastRoom(room);
    timeline.open(room, myId);
    composer.setRoom(room);

    if (!net.canSend) {
      // 没连上也要把界面切过去，但**明确告诉用户现在发不出去**，
      // 而不是给一个能打字、点了没反应/必失败的输入框。
      composer.setEnabled(false, net.phase === 'reconnecting' ? '网络未连接，正在重连…' : '正在连接中继…');
      timeline.note(
        net.phase === 'reconnecting'
          ? '中继已断开，正在重连。恢复后会自动回到这个房间。'
          : '还没连上中继，正在重试…',
        { sticky: true, kind: 'warn' },
      );
      joinedRoom = null;
      pendingRoom = room;   // 节点恢复后由 NODE_STATE 处理器补进一次
      // ⚠️ 也让网络层记下"用户想去哪间"。断线重连时它要拿这个决定回哪 ——
      //    光靠 `_room`（上次**成功**进过的）会把用户离线时点的房间丢掉，
      //    醒来发现自己被拽回了旧房间（offline-room 回归实测）。
      net.noteDesiredRoom(room);
      sidebar.render();
      return;
    }

    composer.setEnabled(false, '正在进入房间…');
    timeline.note(`正在进入「${label}」…`, { sticky: true });

    try {
      net.noteDesiredRoom(room);
      await net.joinRoom(room, store.nick());
      joinedRoom = room;
      pendingRoom = '';
      // 成功提示不该常驻：它是"进行中"的说明，几秒后自动消失即可，
      // 留着会让人以为时间线上多了一条系统消息。
      timeline.note(`已进入「${label}」`, { replace: true });
      composer.setEnabled(true);
      composer.focus();
      await timeline.loadLatest();
      // ⚠️ 顺序有讲究：
      //   1) rebuildCardsForRoom 先把**本房间已有**的传输状态重新画出来
      //      （切走再切回时 DOM 被清空了，但 transfers 还留着 —— 报告 P2-9）
      //   2) restoreInvites 再恢复"上次没收完"的持久化邀约
      // 顺序反了会让 restoreInvites 建的卡片被 rebuild 覆盖判断。
      fileTransfer.rebuildCardsForRoom(room);
      // 进房完成后再恢复未完成的接收卡片（要挂在已打开的时间线上）。
      // ⚠️ 传 room：只恢复**本房间**的记录，其它房间的记录既不显示也不删（F13）。
      fileTransfer.restoreInvites(room);
    } catch (e) {
      // ⚠️ 进房被**更新的操作**取代（报告 P1-8）：这不是失败，
      //    用户已经点/切到别的房间了。这里不要报错、也不要把界面拉回来 ——
      //    后台已经追回了最终房间，界面跟着那边走即可。
      //    排队的 `queuedRoom` 会在 finally 里接手。
      if (e?.superseded) {
        joinedRoom = null;
        composer.setEnabled(false, '正在切换房间…');
        return;
      }
      joinedRoom = null;
      timeline.note(`进房间失败：${e?.message ?? e}`, { sticky: true, kind: 'warn' });
      composer.setEnabled(false, '进入失败');
    } finally {
      sidebar.render();
    }
  })();

  try {
    await opening;
  } finally {
    opening = null;
    // ⚠️ 进房期间用户又点了别的房间：**不能把那次点击吞掉**。
    //
    // 原来的守卫是 `if (opening) return opening;` —— 直接返回、什么也不做。
    // 而 `opening` 覆盖的不只是 join 本身，还包括后面的拉历史（可能一秒以上）。
    // 于是"刚进房、马上点另一个房间"这一下会被静默丢弃：界面纹丝不动，
    // 用户以为点坏了。（实测：joined 之后 4 秒内点击都没有任何反应。）
    // 现在改成排队：当前这次一结束，立刻去开最后一次点的那间。
    const next = queuedRoom;
    queuedRoom = '';
    if (next && next !== joinedRoom) openRoom(next);
  }
}

/* ------------------------------------------------------------------ 头像 */

function paintMyAvatar() {
  // 只改文字节点，不能碰容器（容器里还有未读红点 #rail-badge）
  $('rail-initial').textContent = U.initial(store.nick());
  const el = $('rail-me');
  el.style.background = localStorage.getItem(store.keys.avatarColor) || U.colorOf(store.nick());
  el.title = store.nick();
}

/* ------------------------------------------------------------------ 事件接线 */

function wire() {
  bus.on(EV.ROOM_OPEN, (room) => openRoom(room));

  bus.on(EV.NODE_STATE, ({ ok, text, waiting }) => {
    const pill = $('node-pill');
    // 三态：连接中 / 在线 / 失败。之前只有 ok/bad 两种，"启动中"和"已断开"
    // 长得一模一样，用户分不清是在加载还是挂了。
    pill.className = `pill ${waiting ? 'is-wait' : ok ? 'is-ok' : 'is-bad'}`;
    pill.querySelector('.pill__text').textContent = text;
    pill.classList.toggle('is-clickable', !ok && !waiting);
    pill.title = waiting ? '正在连接中继' : ok ? '已连接' : '点击立即重试';

    // 状态变化要同步到输入区：不然"能打字但发不出去"会一直存在。
    // ⚠️ waiting（正在重试）也必须同步 —— 否则胶囊显示"连接中继…"，
    //    而输入框里还挂着上一次失败时的旧文案，两边自相矛盾。
    if (!ok && sidebar.currentRoom) {
      composer.setEnabled(false, waiting ? '正在重新连接…' : text);
      timeline.note(
        waiting
          ? '连接中断，正在自动重连。恢复后会自动回到这个房间。'
          : '连接中断，恢复后会自动重新进入这个房间。',
        { sticky: true, kind: 'warn' },
      );
    }
    // 节点恢复：把"断线时点了但没进成"的房间补进一次。
    // 不走这里的话，用户会停在一个收不到任何消息的假房间里（见 pendingRoom 注释）。
    //
    // ⚠️ 但**网络层可能已经在恢复了**（`_goOnline` 会用意图房间自己 join）。
    //    两边都去 join 同一间房 → 两个并发请求 → 代次互相淘汰 →
    //    `joinedRoom` 永远停在 null（offline-room 回归实测）。
    //
    // 判据要**同时**看两边：
    //   - 网络层的意图房间 == 这一间（说明它在恢复它）
    //   - 且网络层**真的记得**某个房间（`_room` 或 `_desiredRoom` 非空）
    // 刷新是个新页面：`_room` 与 `_desiredRoom` 都是空的，这时网络层
    // **不会**自己恢复任何房间，必须由这里来 openRoom（踩过：漏了后半句，
    // 两边都撒手，刷新后永远进不去）。
    if (ok && pendingRoom && !joinedRoom && !opening) {
      const r = pendingRoom;
      pendingRoom = '';
      const netWillHandle = net.desiredRoom() === r && net.hasRoomContext();
      if (!netWillHandle) openRoom(r);
      // 否则等网络层的 REJOINED 事件把 joinedRoom 设上
    }
    if (sidebar.tab === 'status') sidebar.render();
  });
  $('node-pill').onclick = () => {
    if (net.phase === 'online') return;
    net.reconnect();
    bus.emit(EV.TIP, '正在重新连接中继…');
  };

  // 断线重连成功 → 自动回到原来的房间，并把状态提示换成"已恢复"
  bus.on(EV.REJOINED, (room) => {
    // ⚠️ 不盲信这个事件（缺陷 F12）：它是"我回到 X 了"的广播式通知，
    //    但用户可能在此期间已经点了别的房间。若事件里的房间不是当前显示的那间，
    //    既不要覆盖 `joinedRoom`，也不要把提示写进错误的时间线 ——
    //    否则会出现"界面显示 C、joinedRoom 是 B"，而 C 里发的消息被广播到 B。
    if (timeline.room && room && timeline.room !== room) return;
    joinedRoom = room;
    const label = store.room(room)?.alias || room;
    timeline.note(`已重新连接并回到「${label}」`);
    if (timeline.room === room) composer.setEnabled(true);
    sidebar.render();
  });

  // 提示默认 5 秒后自动消失；文案里带"失败/出错/超时"这类词的按错误样式显示。
  // 不去逐个调用点标 `bad` —— 十几个 emit 容易漏，漏一处就少一次视觉提示。
  bus.on(EV.TIP, (text, opts) =>
    composer.tip(text, { bad: /失败|出错|错误|超时|不可达/.test(String(text)), ...opts }),
  );

  // 发送失败 → 在时间线上留下可重发的气泡（而不是只弹一句 tip）
  // `failed` 是可变对象：timeline.pushFailed 会把生成的 DOM 挂到 `.el`，
  // 这样"重发成功"时能拿到引用并把那条红色气泡撤掉。
  bus.on(EV.SEND_FAILED, ({ text, reason, failed }) => {
    timeline.pushFailed(text, reason, failed);
  });
  bus.on(EV.RETRY_SEND, async ({ text, el }) => {
    const ok = await composer.pushText(text);
    // 重发成功后要把那条标红的失败气泡撤掉，否则同一条消息会同时出现两次
    // （一次红色"发送失败"、一次正常气泡）。
    if (ok) el?.remove();
    else $('input').focus();
  });

  // ---------------- 文件传输接线 ----------------
  // net 已把 Rust 的 fileInvite / fileAccepted / ... 转发到总线
  bus.on(EV.FILE_INVITE, ({ room, meta }) => fileTransfer.handle({ type: 'fileInvite', room, meta }));
  // 历史里的「文件证明」（text 为空、带 file 字段的消息）→ 一张历史文件卡片。
  // 能不能收由发送方此刻的状态决定，所以交给传输模块处理而不是时间线自己画。
  bus.on(EV.FILE_PROOF, ({ room, m }) => fileTransfer._onFileProof(room, m));

  // 房间成员变化 → 告诉传输模块。
  // 用于：判断"恢复出来的未完成接收"的发送方是否还在房间里（不在就别显示死卡片）。
  bus.on(EV.PRESENCE, ({ peers }) => fileTransfer.setPeers(peers));
  // 注意：`FILE_ACCEPTED` **不在主线程处理** —— 对方点 ✓ 后要立刻开始传数据，
  // 而数据读写都在 Worker 里（避免切后台被节流）。Worker 收到这条事件后
  // 自己就把传输跑起来了，主线程只等 `transfer:*` 进度推送。
  bus.on(EV.FILE_REJECTED, (d) => fileTransfer.handle({ type: 'fileRejected', ...d }));
  bus.on(EV.FILE_DONE, (d) => fileTransfer.handle({ type: 'fileDone', ...d }));

  // 卡片渲染 / 更新 -> 交给时间线
  bus.on(EV.FILE_CARD, (d) => timeline.pushFileCard(d));
  bus.on(EV.FILE_CARD_UPDATE, (d) => timeline.updateFileCard(d));
  bus.on(EV.FILE_CARD_REMOVE, ({ file_id }) => timeline.removeFileCard(file_id));

  // 用户点 ✓ / ✗ -> 交给传输逻辑
  // `reuseHandle`：从「已暂停/中断」继续时复用上次选的保存位置，不再弹一次对话框
  bus.on(EV.FILE_ACCEPT, ({ file_id, reuseHandle }) => {
    fileTransfer
      .accept(file_id, { reuseHandle: !!reuseHandle })
      .catch((e) => bus.emit(EV.TIP, `接收失败：${e?.message ?? e}`));
  });
  // 接收中主动停下：保留已收内容与位图，之后可以继续（F16 的取消入口）
  bus.on(EV.FILE_CANCEL, ({ file_id }) =>
    fileTransfer.cancel(file_id).catch((e) => bus.emit(EV.TIP, String(e?.message ?? e))),
  );
  bus.on(EV.FILE_REJECT, ({ file_id }) => fileTransfer.reject(file_id));
  // 点了历史文件卡片上的 ✓：请发送方重发一次邀约（我们手上没有完整元信息，开不了传输）
  bus.on(EV.FILE_OPEN, ({ file_id }) =>
    fileTransfer.openArchived(file_id).catch((e) => bus.emit(EV.TIP, String(e?.message ?? e))),
  );
  // 接收方把一条已失效的接收记录清掉（只删本端）
  bus.on(EV.FILE_DISMISS, ({ file_id }) => fileTransfer.dismiss(file_id));
  // 发送方在失败/超时后点「↻」重新发送（复用同一个 file_id ⇒ 对方可断点续传）
  bus.on(EV.FILE_RESEND, ({ file_id }) =>
    fileTransfer.resend(file_id).catch((e) => bus.emit(EV.TIP, String(e?.message ?? e))),
  );

  document.addEventListener('nickchange', paintMyAvatar);

  document.addEventListener('roomrenamed', (e) => {
    if (e.detail === sidebar.currentRoom) {
      $('room-title').textContent = store.room(e.detail)?.alias || e.detail;
      sidebar.render();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sidebar.currentRoom) {
      sidebar.setRoom(sidebar.currentRoom);
      sidebar.render();
    }
  });

  // 侧栏状态页已经提供了"重新探测"入口，这里保留图标栏的快捷按钮
  $('btn-probe').onclick = async () => {
    composer.tip('正在探测中继…');
    await net.probe();
    composer.tip(
      net.probes
        .filter((p) => p.ok)
        .map((p) => `${p.id} ${p.rtt ? `${Math.round(p.rtt)}ms` : '?'}`)
        .join(' · ') || '全部不可达',
    );
    if (sidebar.tab === 'status') sidebar.render();
  };

  // 点自己的头像 → 个人资料（改昵称/换身份），不是房间设置。
  // 之前挂在房间菜单上属于串错了入口：改昵称要点进房间菜单里，路径不成立。
  $('rail-me').onclick = () => sidebar.show('settings');

  // 点房间标题 → 房间设置（改备注/置顶），这个是对的
  $('room-title').onclick = () => {
    if (sidebar.currentRoom) sidebar.roomMenu(sidebar.currentRoom);
  };
}

/* ------------------------------------------------------------------ 启动 */

async function main() {
  theme.init();
  dialog.bind();
  sidebar.init();
  timeline.init();
  composer.init();

  if (!store.nick()) store.setNick(`用户${Math.floor(Math.random() * 9000 + 1000)}`);
  paintMyAvatar();
  sidebar.render();
  wire();

  try {
    await net.start();
    myId = net.endpoint_id();
    fileTransfer.init();
    // 恢复"上次没收完的接收"（刷新/关页面后仍能看到卡片并继续）
    // 放在进房之后调，因为卡片要挂到时间线上
    if (!canTransferFiles()) {
      console.info('[filetransfer] 当前浏览器不支持发文件（需要 Chrome / Edge）');
    }
    $('rail-me').title = `${store.nick()}\n${myId}`;
    sidebar.show('chats');
    sidebar.paintBadge();
    autostart();
  } catch (e) {
    // 启动失败 = wasm 没起来 / 中继全挂。给一个能看懂、也能自救的界面，
    // 而不是往列表里塞一行 innerHTML 了事。
    net.phase = 'offline';
    bus.emit(EV.NODE_STATE, { ok: false, text: '节点启动失败' });
    $('panel-body').innerHTML =
      `<div class="empty empty--fatal">
         <div class="empty__title">节点启动失败</div>
         <div class="empty__sub">${U.esc(e?.message ?? e)}</div>
         <div class="empty__hint">这通常是网络无法访问中继，或浏览器拦住了 Worker/wasm。<br />检查网络后点下面重试。</div>
         <button class="btn-primary" id="btn-boot-retry">重新启动节点</button>
       </div>`;
    $('btn-boot-retry').onclick = () => location.reload();
  }
}

/* ------------------------------------------------------------------ 自动化钩子 */

async function autostart() {
  const p = new URLSearchParams(location.search);
  if (!p.has('autostart')) return;
  const room = p.get('room') || store.lastRoom() || 'lobby';
  await openRoom(room);
  const say = p.get('say');
  if (say) {
    await U.sleep(1200);
    $('input').value = say;
    await composer.sendText();
  }
}

window.__state = () => {
  const tl = $('timeline');
  const cp = $('composer');
  const r = cp.getBoundingClientRect();
  return {
    theme: document.documentElement.dataset.theme,
    node: $('node-pill')?.querySelector('.pill__text')?.textContent,
    phase: net.phase,
    canSend: net.canSend,
    myId,
    nick: store.nick(),
    room: sidebar.currentRoom,
    /** 房间确实 join 完成（不是只有 UI 切过去了）——测试必须等它 */
    joined: joinedRoom,
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
    // 布局自检：这些值直接反映"滚不动 / 输入框出屏"
    layout: {
      winH: innerHeight,
      timelineH: tl.clientHeight,
      timelineScrollable: tl.scrollHeight > tl.clientHeight,
      composerInViewport: r.bottom <= innerHeight + 1 && r.top >= 0,
      bodyOverflow: getComputedStyle(document.body).overflow,
    },
  };
};
window.__openRoom = (r) => openRoom(r);
/** 测试/自动化：直接操作网络层（模拟掉线、强制重连等） */
window.__net = net;
window.__openNewRoom = () => sidebar.newRoom();
window.__openSettings = () => sidebar.show('settings');
window.__openTheme = () => theme.toggle();
window.__openEmoji = () => $('tb-emoji').click();
window.__sendText = (t) => {
  $('input').value = t;
  composer._autoGrow();
  composer._syncSendBtn();
  return composer.send();
};
/** 测试/自动化：把文件塞进待发送区（等价于粘贴或拖拽） */
window.__addFiles = (files) => composer.addFiles(files);
/** 测试/自动化：点发送（会先发文字再逐个发起附件） */
window.__send = () => composer.send();

// ---- 文件传输测试钩子（scripts/transfer-test.mjs 用）----
/** 让发送方只发前 n 块就主动断连（0 = 恢复正常） */
window.__setStopAfterChunks = (n) => net.client.post({ type: 'stopAfterChunks', n });
/** 直接发起一次文件发送（绕过 <input type=file>） */
window.__sendFile = (file, room) => fileTransfer.pickAndSend(file, room);
/** 测试/自动化：点历史文件卡片上的「接收」 */
window.__openArchived = (fileId) => fileTransfer.openArchived(fileId);
/** isSecureContext 在 http://127.0.0.1 下为 true，可用；这里给测试一个明确开关 */
window.__canTransferFiles = () => canTransferFiles();
/** 构造一个内存文件（测试用） */
window.__makeFile = (name, bytes) => new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });

main();
