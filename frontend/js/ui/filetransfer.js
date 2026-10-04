/* ============================================================================
 * filetransfer.js · 浏览器侧 P2P 文件传输（Worker 版）
 *
 * ## 分工（关键）
 *
 * 文件传输的重活（算哈希、读块、写块、IndexedDB 位图）**全部在 Worker 里**，
 * 因为 iroh 的 QUIC 栈靠定时器驱动，而页面切后台时定时器会被节流 50 倍
 * （实测 20ms → 1000ms），Worker 不受影响。
 *
 * | 事 | 在哪 | 为什么 |
 * |---|---|---|
 * | `showSaveFilePicker` | **主线程** | 需要用户手势，Worker 里拿不到 |
 * | 选文件（input / 拖拽） | **主线程** | 同上 |
 * | 算哈希、读写块、位图、invite、传数据 | Worker | 紧贴 iroh，且不受节流 |
 * | 卡片、按钮、提示 | 主线程 | DOM 只能在主线程 |
 *
 * ## 数据路径（每块数据都不经过 postMessage）
 *
 * ```
 * 主线程  --一次性传 File / 句柄-->  Worker（iroh + 读写）
 *    ^                                |
 *    +------ 只回进度百分比（~150ms）--+
 * ```
 *
 * ## 你能看到的行为
 *
 * 1. 对方发文件 → 聊天框出现卡片：文件名 / 大小 / ✓ ✗
 * 2. 点 ✓ → **弹「保存位置」对话框**（默认落在下载目录），选完才开始收
 * 3. 不点、或点 ✗ → 什么都不发生（对方稍后超时）
 * 4. 收的时候有进度；中断后下次从断点继续
 * 5. **切走标签页也不会掉速**（传输在 Worker 里跑，不受后台节流）
 *
 * ## 浏览器兼容
 *
 * `showSaveFilePicker` 只有 Chromium 系支持。Firefox / Safari 直接禁用发送，
 * 并明确提示（宁可明确不可用，也不要"看起来能用但吃满内存"的降级方案）。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { dialog } from './dialog.js';
import * as U from '../util.js';

/** 只有 Chromium 支持文件系统访问 API */
export const canTransferFiles = () =>
  typeof window.showSaveFilePicker === 'function' && !!window.isSecureContext;

/** 邀约的有效期：对方超过这么久没点 ✓，就认为"未响应" */
const INVITE_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------
 * 「历史里的文件」—— 能不能收，看的是发送方**此刻**的状态
 *
 * 文件邀约是"发送那一刻广播一次"的瞬时消息，后进房间的人收不到。
 * 所以发送方另外发一条"这里有个文件"的**证明**（当普通消息存进历史），
 * 谁进来都能看到名字。
 *
 * 但"看到"≠"能收"：能不能收取决于两件事 ——
 *   1. 发送方还在这个房间里（心跳表里有他）
 *   2. **他的能力清单里还有这个 file_id**（他自己刷新过就没有了）
 * 所以这里只做**派生**：不去同步"过期"这个状态，而是每次都从上述两条算出来。
 * 好处是永远不会出现"状态与事实不符"——清单回来了，卡片自动恢复可接收。
 * ------------------------------------------------------------------ */

/** 点了历史文件后，等对方重新发邀约的时间；超时就本地判为过期 */
const ASK_TIMEOUT_MS = 5_000;
/**
 * 质询失败后的"本地隔离"时长：这段时间内直接显示过期，免得用户反复点反复等。
 * ⚠️ 它是**可逆**的：只要对方的清单里又出现这个文件，立刻解除（见 setPeers）。
 */
const QUARANTINE_MS = 60_000;

/** file_id -> ts（被隔离的时间）。见上面说明。 */
const quarantined = new Map();

/** 传输中的任务：file_id → 状态（只用于 UI 展示，真数据在 Worker 里） */
const transfers = new Map();

/**
 * 能力清单索引：`file_id -> Set(peerId)`，由各人的心跳清单（`PeerInfo.files`）汇总而来。
 * 用来回答"历史里这个文件此刻还能不能收"。
 */
const capability = new Map();

/** 是否正在传输（用于决定要不要提示） */
function anyActiveTransfer() {
  for (const t of transfers.values()) {
    if (t.state === 'active' || t.state === 'sent') return true;
  }
  return false;
}

/* ------------------------------------------------------------------
 * 回到前台时的提示
 *
 * 传输现在跑在 Worker 里，**不受页面可见性影响**，所以不再需要
 * "切后台自动暂停"那一套。这里只在中途切回来时提示一下当前状态。
 *
 * （历史：Worker 之前，切后台会让 iroh 的定时器被节流 50 倍，
 *   实测 800+ KB/s → 几十 KB/s；那时用的是"暂停 + 回前台续传"降级方案。）
 * ------------------------------------------------------------------ */
function setupVisibilityHint() {
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasHidden = true;
      return;
    }
    if (wasHidden && anyActiveTransfer()) {
      bus.emit(EV.TIP, '已回到前台，传输一直在后台全速进行');
    }
    wasHidden = false;
  });
}
setupVisibilityHint();

/* ------------------------------------------------------------------
 * 刷新 / 关闭页面时，主动告诉对方"我不收了"
 *
 * ## 为什么需要
 *
 * 接收方一刷新，它的 Worker 就被销毁、QUIC 连接随之断开 —— 但**发送方
 * 不会立刻知道**：数据是"发送方 → 中继 → 接收方"，接收方没了以后中继
 * 只是把包丢掉，发送方照样在写，实测**两分多钟都不报错**。
 * 期间发送端那张卡片一直停在"传输中"，用户完全不知道发生了什么。
 *
 * 所以走之前**主动广播一条 Reject**：发送方收到后立刻只把这一条通道
 * 标失败（`FileRejected.by` 指明是谁），其他人照传不受影响。
 *
 * ## 只能"尽力而为"
 *
 * 页面卸载时浏览器不保证异步操作跑完，`postMessage` 出去了、Worker 里
 * 的 gossip 广播也可能来不及 flush。所以这只是**快路径**，
 * 发送端 Worker 里的「无进度看门狗」才是保底（它不需要对方配合）。
 * 两者配合：正常情况下几乎瞬时就同步到位，极端情况下最迟几十秒。
 *
 * ## 为什么要排除 `interrupted`
 *
 * `interrupted` 是"刷新后恢复出来、等用户点继续"的卡片，本来就没在传，
 * 报一次取消反而会把发送端那边还留着的记录弄乱。
 * ------------------------------------------------------------------ */
function setupLeaveCancel() {
  const leave = () => {
    for (const [file_id, t] of transfers) {
      if (t.direction !== 'recv') continue;
      if (t.state !== 'active' && t.state !== 'invited') continue;
      // 不等响应：页面正在卸载，能发出去就发。
      // ⚠️ 必须带房间：Reject 现在要过"房间没变"的校验（F7），
      //    漏了参数会把 room 传成 undefined，消息直接发不出去。
      net.client
        .call('reject', file_id, '对方刷新或关闭了页面', t.room)
        .catch(() => {});
    }
  };
  window.addEventListener('pagehide', leave);
}
setupLeaveCancel();

/* ------------------------------------------------------------------
 * Worker 推送 → UI 状态
 * ------------------------------------------------------------------ */

function bindWorkerPushes() {
  net.client.onMessage((m) => {
    const p = m.payload || {};
    // 测试钩子：Worker 每次写入回传块序号（只回序号，不回数据）。
    // 主线程收到后照旧塞进 `window.__writeLog`，测试断言无需改。
    if (m.type === 'transfer:chunk') {
      window.__writeLog = window.__writeLog || [];
      window.__writeLog.push(p.seq);
      return;
    }
    switch (m.type) {
      case 'transfer:hash':
        bus.emit(EV.TIP, `正在计算校验值… ${p.pct}%`);
        break;
      // 续传完成时 Worker 侧回读整份文件做的校验通过了（F5）。
      // 这条提示是有意义的：续传路径上的内容校验发生在 Worker 里，
      // 用户看不到过程，给一句明确的"校验通过"才不至于让人怀疑文件是否完整。
      case 'transfer:verified':
        bus.emit(EV.TIP, '续传完成，整文件校验通过');
        break;
      // 这两条原来**没有处理者**（复检 P3-13）：Worker 明明算了
      // "为什么这次从头收"（目标文件为空 / 大小与位图预期不符 / 属于另一个文件），
      // 却没人显示 —— 用户只看到进度从 0 重新开始，无从判断是不是出了问题。
      case 'transfer:note':
        if (p.note) bus.emit(EV.TIP, p.note);
        break;
      case 'transfer:send-failed':
        bus.emit(EV.TIP, `发送失败：${p.reason ?? '未知原因'}`);
        break;
      // 发送侧汇总进度：一份文件可能同时发给多人，Worker 会把所有人的
      // 进度汇总成一条推上来（`peers` / `done` / `failed` / `sending`）。
      case 'transfer:send': {
        const t = transfers.get(p.file_id);
        if (!t) return;
        // 有人接受了 → 邀约超时定时器可以撤了
        if (t.inviteTimer) {
          clearTimeout(t.inviteTimer);
          t.inviteTimer = null;
        }
        t.done = p.doneChunks;
        t.bytes = p.bytes;
        t.peers = p.peers;
        t.peersDone = p.done;
        t.peersFailed = p.failed;
        // 只要还有人没收完，就算"传输中"；全失败才算失败
        const state = p.sending > 0 || p.done > 0 ? 'active' : p.failed > 0 ? 'failed' : 'active';
        t.state = state;
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: p.file_id,
          state,
          done: p.doneChunks,
          total: p.totalChunks,
          bytes: p.bytes,
          peers: p.peers,
          peersDone: p.done,
          peersFailed: p.failed,
        });
        break;
      }
      // 多条出站里某一条出问题（文件丢了等），只提示该条，不影响其他人
      case 'transfer:peer-error': {
        bus.emit(EV.TIP, `有一位接收方传输失败：${p.error}`);
        break;
      }
      // 发送侧"全部有结果了"：都收完 → done；有人失败 → 让卡片可重发
      case 'transfer:outcome': {
        const t = transfers.get(p.file_id);
        if (!t) return;
        if (t.inviteTimer) {
          clearTimeout(t.inviteTimer);
          t.inviteTimer = null;
        }
        t.peers = p.peers;
        t.peersDone = p.done;
        t.peersFailed = p.failed;
        if (p.ok) {
          t.state = 'done';
          bus.emit(EV.FILE_CARD_UPDATE, { file_id: p.file_id, state: 'done', done: t.total, total: t.total });
        } else {
          // 有人没成功：卡片显示"部分失败"，并给重发入口
          t.state = 'failed';
          t.error = `${p.failed} 位接收方未完成`;
          bus.emit(EV.FILE_CARD_UPDATE, {
            file_id: p.file_id,
            state: 'failed',
            error: t.error,
            peers: p.peers,
            peersDone: p.done,
            peersFailed: p.failed,
          });
        }
        break;
      }
      case 'transfer:recv': {
        const t = transfers.get(p.file_id);
        if (!t) return;
        t.done = p.done;
        t.bytes = p.bytes;
        // 顺手刷新"最后活动时间"，免得长传输被 TTL 误判过期（见 touchInvite）
        touchInvite(p.file_id);
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: p.file_id,
          state: 'active',
          done: p.done,
          total: p.total,
          bytes: p.bytes,
        });
        break;
      }
      case 'transfer:done': {
        const t = transfers.get(p.file_id);
        if (t) {
          t.state = 'done';
          t.done = p.total;
        }
        forgetInvite(p.file_id); // 收完了，不必再恢复
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: p.file_id,
          state: 'done',
          done: p.total,
          total: p.total,
        });
        break;
      }
      case 'transfer:paused': {
        const t = transfers.get(p.file_id);
        if (t) {
          t.state = 'paused';
          t.done = p.done;
        }
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: p.file_id,
          state: 'paused',
          done: p.done,
          total: p.total,
          error: p.reason,
        });
        break;
      }
      case 'transfer:error': {
        const t = transfers.get(p.file_id);
        if (t) t.state = 'failed';
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: p.file_id,
          state: 'failed',
          error: p.error,
        });
        bus.emit(EV.TIP, `传输失败：${p.error}`);
        break;
      }
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------
 * 保存位置：必须由**用户手势**触发，所以留在主线程
 * ------------------------------------------------------------------ */

async function pickSaveHandle(meta) {
  // 自动化测试出口：无头环境没有系统对话框，可先注入
  //   window.__mockFilePicker = (name, size) => 假句柄
  if (window.__mockFilePicker) return await window.__mockFilePicker(meta.name, meta.size);
  const ext = meta.name.split('.').pop() || '';
  return await window.showSaveFilePicker({
    suggestedName: meta.name,
    startIn: 'downloads',
    types: meta.mime
      ? [{ description: ext, accept: { [meta.mime]: [`.${ext}`] } }]
      : undefined,
  });
}

/* ------------------------------------------------------------------
 * 邀约的持久化（刷新页面后能恢复）
 *
 * 场景：对方发来一个 380MB 的文件，你点了接收但还没传完就刷新了页面。
 * 如果什么都不做，刷新后那张卡片就消失了 —— 你不知道"刚才有个文件没收完"，
 * 对方也白等了（发送端几十秒后失败）。
 *
 * 所以收到邀约时把它记下来；刷新后重新显示卡片，让你可以继续接收
 * （会走断点续传，只补缺的块）。
 *
 * ## ⚠️ 必须按身份隔离
 *
 * `localStorage` 是**同一个 origin 共享的**。如果同一个人开两个标签页
 * （一个发、一个收），或者多个身份共用浏览器配置，**接收端写下的记录
 * 会被发送端读到**，于是发送端也去"恢复"一遍，凭空多出一张
 * `interrupted` 卡片（实测踩到：发送端界面上出现 `direction=recv` 的条目）。
 *
 * 所以每条记录都带上**本端的 endpoint id**，恢复时只认自己那条。
 *
 * 为什么用 localStorage 而不是 IndexedDB：这里存的只是**几 KB 的元信息**
 * （文件名 / 大小 / 根哈希），同步读写更简单；位图才需要 IndexedDB。
 * ------------------------------------------------------------------ */

const INVITE_KEY = 'iroh.pending-invites';
/**
 * 存储格式版本。
 * ⚠️ 必须带版本：早期版本写下的记录**没有 `owner` 字段**，
 * 而按 owner 过滤时"无 owner"会被当成"放行"，于是旧记录在升级后
 * 仍会被恢复出来（实测踩到：发送端冒出 recv 方向的幽灵卡片）。
 * 换版本号 = 直接丢弃旧格式记录。
 */
const INVITE_VER = 3;
/**
 * 超过这个时间**没有活动**的旧邀约就不再恢复。
 *
 * ⚠️ 判的是"距**上次活动**多久"（不是"距邀约到达多久"）——
 * 记录会在接收过程中被 `touchInvite()` 不断刷新，所以长传输（大文件、
 * 传一半去干别的）不会因为"邀请是很久以前发的"而被丢掉。
 *
 * 这里原本写的是 24 小时，结果是**自相矛盾的设计**：发送端 60 秒就把
 * 邀约标成"对方未响应"、页面一关连文件引用都没了，而接收端刷新后却会把
 * **一整天前**的旧邀约恢复成「继续接收」——用户一点必然失败。
 * 这正是"一上来就显示失败"的来源。
 *
 * 取 10 分钟：远宽松于发送端的 60 秒邀约有效期（容忍对方页面刚刷新、
 * 或自己离开一会儿），又不至于久到毫无意义。
 */
const INVITE_TTL_MS = 10 * 60 * 1000;

/** 本端身份，用于把记录限定为"我自己的"。start() 之后才有值。 */
let selfId = '';

/**
 * 最近一次知道的房间成员 id 集合（null = 还没收到 presence）。
 *
 * 用途：刷新后恢复"未完成的接收"时，**确认发送方是否还在房间里**。
 * 发送方已经走了，那张卡片就是死的 —— 恢复出来只会骗用户点一次、
 * 然后失败（这正是"上来就失败"的观感来源）。
 * 还没收到 presence 时（null）不据此过滤，宁可先恢复、等 presence 到了再降级。
 */
let knownPeers = null;

function loadStoredInvites() {
  try {
    const raw = JSON.parse(localStorage.getItem(INVITE_KEY) || '{}');
    // 兼容：旧格式是数组，直接当作过时数据丢弃
    if (Array.isArray(raw) || raw.ver !== INVITE_VER) return [];
    const now = Date.now();
    return (raw.items || []).filter(
      (x) =>
        x &&
        x.meta &&
        now - (x.ts || 0) < INVITE_TTL_MS &&
        // 只认本端记下的（见上面"必须按身份隔离"）
        x.owner &&
        x.owner === selfId,
    );
  } catch {
    return [];
  }
}

function saveStoredInvites(list) {
  try {
    localStorage.setItem(INVITE_KEY, JSON.stringify({ ver: INVITE_VER, items: list.slice(-20) }));
  } catch {
    /* 隐私模式 / 配额满：降级为不恢复，不影响主流程 */
  }
}

function rememberInvite(room, meta) {
  // 先按 (owner, file_id) 去重，避免不同身份的记录互相覆盖
  const list = loadStoredInvites().filter((x) => x.meta.file_id !== meta.file_id);
  // 记下**发送方 id**：刷新恢复时要确认他还在不在房间里
  list.push({ room, meta, ts: Date.now(), owner: selfId, senderId: meta.sender || '' });
  saveStoredInvites(list);
}

function forgetInvite(fileId) {
  const list = loadStoredInvites().filter((x) => x.meta.file_id !== fileId);
  saveStoredInvites(list);
  touchAt.delete(fileId);
}

/**
 * 刷新一条邀约记录的"最后活动时间"。
 *
 * ⚠️ 为什么必须做：TTL 判的是"**距上次活动**多久"，不是"距邀约到达多久"。
 * 一份 1GB 的文件传 20 分钟，若按"到达时间"算，用户中途一刷新记录就被
 * 当成过期丢掉了 —— 而这个场景（长传输中途刷新后继续）恰恰是最需要
 * 恢复功能的场景。
 *
 * 节流到 30 秒写一次：进度事件每 150ms 就有一次，不能每次都落盘。
 */
const touchAt = new Map(); // file_id -> 上次落盘时间
function touchInvite(fileId) {
  const now = Date.now();
  if (now - (touchAt.get(fileId) || 0) < 30_000) return;
  touchAt.set(fileId, now);
  try {
    const raw = JSON.parse(localStorage.getItem(INVITE_KEY) || '{}');
    if (raw.ver !== INVITE_VER || !Array.isArray(raw.items)) return;
    let hit = false;
    for (const it of raw.items) {
      if (it?.meta?.file_id === fileId && it.owner === selfId) {
        it.ts = now;
        hit = true;
      }
    }
    if (hit) saveStoredInvites(raw.items);
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}

/* ------------------------------------------------------------------
 * 公开 API
 * ------------------------------------------------------------------ */

export const fileTransfer = {
  /** file_id → { meta, direction, state, done, total, bytes, error } */
  transfers,
  /** 本次会话里选过的保存位置（重试时复用，不再弹框） */
  _handles: new Map(),

  init() {
    // 记下本端身份：持久化的邀约要按身份隔离（见文件上方说明）
    selfId = net.endpoint_id() || '';
    bindWorkerPushes();
  },

  /** 处理来自 Rust 的文件事件（由 main.js 从总线转来） */
  handle(event) {
    switch (event.type) {
      case 'fileInvite':
        this._onInvite(event.room, event.meta);
        break;
      case 'fileRejected':
        this._onRejected(event);
        break;
      case 'fileDone':
        this._onDone(event);
        break;
      default:
        break;
    }
  },

  /* ------------------------------------------------------------------ 发送 */

  /**
   * 选一个文件并发起邀约。
   *
   * **整个发送都在 Worker 里**：主线程只把 `File` 对象交过去
   * （结构化克隆会保留对本地文件的引用），之后算哈希、读块、传输
   * 都不再经过消息通道，只回进度。
   */
  async pickAndSend(file, room, memoryBacked = false) {
    if (!canTransferFiles()) {
      return dialog.info(
        '当前浏览器不支持',
        '发文件需要 <b>Chrome / Edge</b>（依赖「保存位置」相关的文件系统 API）。<br />' +
          'Firefox 与 Safari 暂不支持 —— 宁可明确不可用，也不想用"看起来能传但会把内存吃满"的降级方案。',
      );
    }
    if (!file || !room) return;

    bus.emit(EV.TIP, '正在计算校验值… 0%');
    // ⚠️ 传的是 `File` 本身（不是内容）—— Worker 那边直接 slice() 读，
    //    数据不进消息通道。
    // `memoryBacked`：这个文件的数据在不在内存里（粘贴的截图 = 是）。
    // 传给 Worker 用于"内存类文件"的单独上限 —— 必须显式传，
    // File 的自定义属性过不了结构化克隆。
    const raw = await net.client.call('pickAndSend', file, room, !!memoryBacked);
    const { meta, total } = JSON.parse(raw);
    bus.emit(EV.TIP, '');

    transfers.set(meta.file_id, {
      meta,
      file,
      room,
      state: 'pending',
      done: 0,
      total,
      bytes: 0,
      direction: 'send',
      // 多接收方汇总：peers=接受的人数，peersDone=已收完的人数
      peers: 0,
      peersDone: 0,
      peersFailed: 0,
    });
    bus.emit(EV.FILE_CARD, { room, meta, direction: 'send', state: 'pending' });

    // 邀约超时：**没人接受**时才降级为"未响应"。
    //
    // ⚠️ 判定要严格：只要已经有接收方在传（`peers > 0`）或已经收完，
    //    就绝不能标 expired —— 否则传输中卡片会突然显示"对方未响应"，
    //    但数据其实还在传（实测踩到：两个接收方都在传，发送端却显示 expired）。
    const rec = transfers.get(meta.file_id);
    rec.inviteTimer = setTimeout(() => {
      const cur = transfers.get(meta.file_id);
      if (!cur) return;
      if (cur.state !== 'pending') return;      // 已有人接受 / 已结束
      if (cur.peers > 0) return;                // 兜底：有接收方就不算过期
      cur.state = 'expired';
      bus.emit(EV.FILE_CARD_UPDATE, { file_id: meta.file_id, state: 'expired' });
    }, INVITE_TIMEOUT_MS);

    return meta;
  },

  /**
   * 有人拒绝收这份文件。
   *
   * ⚠️ **只有发送方该理会这条**：`Reject` 是群广播，同一房间的所有人都会
   * 收到。如果我是个**接收方**（正要收同一份文件），别人拒绝跟我毫无关系 ——
   * 不管方向就会把自己的卡片也标成"已拒绝"（多接收方场景下的误伤）。
   *
   * 发送方这边也**不再整张卡片判死**：一份文件可能同时发给多个人，
   * 该标记哪一条通道由 Worker 按 `by` 精确处理（它会推 `transfer:outcome`），
   * 主线程这里只处理**还没开始传**（`pending`）时对方直接拒绝的情况。
   */
  _onRejected({ room, file_id, reason }) {
    const t = transfers.get(file_id);
    if (!t) return;
    // ⚠️ 房间必须对得上：控制消息是广播的，来自别的房间的同名 file_id
    //    （或用户切房间后才到达的旧消息）不该动这张卡片（F7）。
    if (room && t.room && room !== t.room) return;
    if (t.direction !== 'send') return; // 接收方：别人的拒绝与我无关
    if (t.inviteTimer) clearTimeout(t.inviteTimer);
    // 已经在传/已传完的，交给 Worker 的按人汇总去更新（别整张卡判死）
    if (t.state !== 'pending') return;
    t.state = 'rejected';
    bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'rejected', error: reason });
  },

  /**
   * 有人收完了这份文件。
   *
   * ⚠️ 同样是**群广播**：只对发送方有意义（接收方收到别人的"我收完了"
   * 与自己无关）。而且多接收方时，**不能一个人收完就把整张卡标成完成** ——
   * 那由 Worker 的按人汇总决定（`transfer:outcome` 会在全部有结果时才推）。
   */
  _onDone({ room, file_id, ok, reason }) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'send') return;
    if (room && t.room && room !== t.room) return; // 同上：房间对不上就忽略
    // 还在传其他人：不在这里下结论，等 Worker 汇总
    if (t.peers > 1) return;
    if (t.state === 'active' || t.state === 'sent') {
      t.state = ok ? 'done' : 'failed';
      bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: t.state, error: reason });
    }
  },

  /* ------------------------------------------------------------------ 接收 */

  /** 收到邀约：在聊天框放一张卡片，等用户点 ✓ */
  _onInvite(room, meta) {
    const cur = transfers.get(meta.file_id);
    // ⚠️ 重复邀约不要把我们已有的进度打回去。
    //
    // 什么时候会出现重复邀约：发送方点「↻ 重发」、或者**有人点了历史里的
    // 文件卡片**触发对方重发一次（见 `openArchived`）—— 后者会把 Invite
    // 广播给整个房间，已经收完/正在收/明确拒绝过的人不该被重新弹一次。
    if (cur && (cur.state === 'done' || cur.state === 'active' || cur.state === 'rejected')) {
      return;
    }
    // ⚠️⚠️ **历史文件卡片（`archived`）绝不能被重发的邀约接管**。
    //
    // 踩过的坑：X 点了历史卡片 → 发送方重发邀约（广播给**全房间**）→
    // 于是连**从没点过**的 Y 也被塞了一张 `invited` 卡片。
    // 后果不只是"凭空多一张卡"：`archived` 卡片是靠 `availabilityOf()`
    // 派生出 live/expired 的，而 `_refreshArchived()` 只处理 `archived`
    // 和 `asking`。一旦被改成 `invited`，这张卡片就**再也不参与可用性计算**
    // —— 发送方刷新后它永远不会变"已过期"（实测 D 旁观者就卡死在这）。
    //
    // 那 X 自己点的那张怎么办？它在 `openArchived()` 里已经被置成 `asking`，
    // 由下面这条分支正常接管成 `invited`（它有 chunk_size/root_hash 能收）。
    // 这里只需要**放过 `asking`**，其余状态一律不动。
    if (cur && cur.state === 'archived') {
      // 顺便刷新一下可用性：发送方重发意味着他此刻确实还持有这个文件。
      this._refreshArchived();
      return;
    }
    // 用户点了历史卡片后会进入 asking。重发的 Invite 必须更新这张已有卡片，
    // 不能再次发 FILE_CARD 后被时间线的 file_id 去重静默丢掉。
    if (cur && cur.state === 'asking') {
      cur.meta = meta;
      cur.room = room;
      cur.state = 'invited';
      cur.done = 0;
      cur.bytes = 0;
      cur.total = Math.ceil(meta.size / meta.chunk_size);
      cur.error = '';
      cur.avail = 'live';
      cur.fromProof = false;
      quarantined.delete(meta.file_id);
      rememberInvite(room, meta);
      bus.emit(EV.FILE_CARD_UPDATE, {
        room,
        file_id: meta.file_id,
        state: 'invited',
        done: 0,
        total: cur.total,
        bytes: 0,
        error: '',
        avail: '',
      });
      return;
    }
    transfers.set(meta.file_id, {
      meta,
      room,
      state: 'invited',
      done: 0,
      total: Math.ceil(meta.size / meta.chunk_size),
      bytes: 0,
      direction: 'recv',
    });
    rememberInvite(room, meta); // 刷新后能恢复（见文件上方说明）
    bus.emit(EV.FILE_CARD, { room, meta, direction: 'recv', state: 'invited' });
  },

  /**
   * 页面启动时恢复"上次没收完的邀约"。
   *
   * 注意：这里**只是把卡片放回聊天框**，不代表对方还在等 ——
   * 对方可能早就超时了。所以状态标成 `interrupted`（可重试），
   * 用户点了「继续接收」会重新走 accept（带上断点位图），
   * 对方如果还在，就能接着传；对方已走，就会失败并提示。
   *
   * ## ⚠️ 但不能无脑恢复 —— "上来就失败"就是这么来的
   *
   * 恢复一个**发送方早已离开**的邀约，等于给用户一张必然失败的卡片。
   * 之前 TTL 是 24 小时，恢复出来几乎是必失败。
   * 现在三重过滤：
   *   1. `loadStoredInvites()` 里 TTL 收紧到 10 分钟（与发送端 60s 有效期对齐）
   *   2. 已经收完的（位图已被删）不恢复
   *   3. **发送方不在当前房间成员里**的不恢复（`knownPeers` 已知时）
   */
  /**
   * 切回一个房间后，**按现存传输状态重建卡片视图**（报告 P2-9）。
   *
   * ## 为什么需要这一步
   *
   * `transfers` 这个 Map 是**跨房间保留**的（离开房间不该丢掉传输状态），
   * 但时间线的 DOM 在 `timeline.open()` 时被清空了。于是切回原房间后：
   *
   *  - `_onFileProof` 发现 `transfers.has(file_id)` → 直接 return，不渲染
   *  - `restoreInvites` 同理（`transfers.has` → continue）
   *  - 重复的 `Invite` 被 `_onInvite` 的守卫挡掉
   *
   * **三个入口全部 early-return**，结果是卡片彻底消失，用户没法继续处理。
   *
   * 这与"状态去重"是两件事：去重是为了不重复处理同一份传输，
   * 而重建只是**把已有状态重新画出来**。这里做后者，不碰状态。
   */
  rebuildCardsForRoom(room) {
    let n = 0;
    for (const [, t] of transfers) {
      if (t.room !== room) continue;
      if (t.direction !== 'recv' && t.direction !== 'send') continue;
      // 已被移出传输集合的（用户点过 ✗）不重建
      if (t.state === 'expired' && t.dismissed) continue;
      bus.emit(EV.FILE_CARD, {
        room,
        meta: t.meta,
        ts: t.ts || t.meta.ts,
        direction: t.direction,
        // ⚠️ 进度与失败原因也要带上（复检 P3-6）：
        //    不带的话，切走再切回时 90% 的卡片会显示空进度条，
        //    失败的卡片会丢掉"失败：<原因>"那行字。
        done: t.done || 0,
        total: t.total || 0,
        error: t.error || '',
        state: t.state,
        avail: t.avail,
      });
      n++;
    }
    return n;
  },

  /**
   * 恢复"上次没收完"的持久化邀约。
   *
   * ⚠️ `room`：**必须按房间过滤**（缺陷 F13）。原来它遍历**所有**房间的记录，
   * 却拿"当前房间的成员表"判断发送方在不在 —— 后果有三条：
   *   1. A 房间的邀约会在 B 房间被渲染成卡片（显示在错误的会话里）；
   *   2. 因为 A 的发送方不在 B 的成员表里，会执行 `forgetInvite`，
   *      把 A 房间的**续传记录永久删掉**；
   *   3. 用户点了那张卡再"继续接收"，Accept 会发进 B 房间（见 accept 的说明）。
   * 所以：只处理 `item.room === room` 的记录，别的一律不碰。
   */
  restoreInvites(room) {
    const stored = loadStoredInvites();
    let shown = 0;
    for (const item of stored) {
      const meta = item.meta;
      if (transfers.has(meta.file_id)) continue;

      // 别的房间的记录：不显示、**更不能删**（留着等用户回到那个房间再用）
      if (room && item.room && item.room !== room) continue;

      // 发送方还在这间房里吗？不在 → 这张卡片点了也白点，直接丢掉记录
      if (knownPeers && item.senderId && !knownPeers.has(item.senderId)) {
        forgetInvite(meta.file_id);
        continue;
      }

      transfers.set(meta.file_id, {
        meta,
        room: item.room,
        state: 'interrupted',
        done: 0,
        total: Math.ceil(meta.size / meta.chunk_size),
        bytes: 0,
        direction: 'recv',
      });
      bus.emit(EV.FILE_CARD, {
        room: item.room,
        meta,
        direction: 'recv',
        state: 'interrupted',
      });
      shown++;
    }
    if (shown) {
      bus.emit(EV.TIP, `有 ${shown} 个未完成的接收（可继续）`);
    }
  },

  /**
   * 记住当前房间的成员，供 `restoreInvites` 判断"发送方还在不在"。
   *
   * 来晚了也没关系：`restoreInvites` 时还不知道成员就先恢复（宁可先显示），
   * 等 presence 到了这里会**把发送方已离开的卡片标成失效**。
   */
  setPeers(peers, room) {
    knownPeers = new Set((peers || []).map((p) => p.id).filter(Boolean));

    // 重建"能力清单"索引：file_id -> 谁声称还能提供它
    capability.clear();
    for (const p of peers || []) {
      for (const fid of p.files || []) {
        if (!capability.has(fid)) capability.set(fid, new Set());
        capability.get(fid).add(p.id);
      }
    }
    // 清单里又出现的文件 → 解除隔离（这就是"过期可逆"的落点）
    for (const fid of [...quarantined.keys()]) {
      const want = transfers.get(fid)?.meta?.sender;
      if (want && capability.get(fid)?.has(want)) quarantined.delete(fid);
    }

    // 已经恢复出来的邀约卡片：发送方走了就标失效
    for (const [id, t] of transfers) {
      if (t.room !== room) continue;
      if (t.direction !== 'recv' || t.state !== 'interrupted') continue;
      const senderId = t.meta?.sender;
      if (senderId && !knownPeers.has(senderId)) {
        t.state = 'expired';
        t.error = '发送方已离开房间';
        forgetInvite(id);
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: id,
          state: 'expired',
          error: t.error,
        });
      }
    }
    // 历史文件卡片：重算可用性（发送方上线/下线/清单变化都会走到这里）
    this._refreshArchived();
  },

  /* ------------------------------------------------- 历史里的「文件证明」 */

  /**
   * 收到历史里的一条文件证明 → 渲染成一张"历史文件卡片"。
   *
   * `m` 是一条普通消息，只是 `m.file` 有值、`text` 为空（发送方签名，
   * 常驻节点只是存储，无法伪造）。
   */
  _onFileProof(room, m) {
    const ref = m?.file;
    if (!ref?.file_id) return;
    // 自己发的文件不再画一张"历史文件"卡片：发的时候已经有实时卡片了，
    // 而刷新之后它确实再也传不出去，画一张只能看不能用的卡片反而误导。
    if (m.from && m.from === net.endpoint_id()) return;
    const exist = transfers.get(ref.file_id);
    // 已经有"更活"的卡片（实时邀约/正在传/已收完）就别覆盖它
    if (exist && exist.state !== 'archived') return;

    transfers.set(ref.file_id, {
      meta: {
        file_id: ref.file_id,
        name: ref.name,
        size: ref.size,
        mime: ref.mime || '',
        // 发送方 id 取自消息的签名者 —— 我们靠它去查"他还在不在"
        sender: m.from || '',
      },
      room,
      ts: m.ts || Date.now(),
      state: 'archived',
      done: 0,
      total: 0,
      bytes: 0,
      direction: 'recv',
      fromProof: true,
    });
    bus.emit(EV.FILE_CARD, {
      room,
      meta: transfers.get(ref.file_id).meta,
      ts: m.ts,
      direction: 'recv',
      state: 'archived',
    });
    this._refreshArchived();
  },

  /**
   * 一张历史文件卡片此刻的可用性。**派生，不缓存为"事实"**：
   *  - `live`    发送方在房间里 且 他的清单里还有它 → 可接收
   *  - `expired` 发送方不在 / 清单里没有（刷新过、被淘汰）/ 刚被隔离
   *  - `unknown` 还没收到过任何心跳（进房瞬间）→ **不猜**，显示"检查中"
   */
  availabilityOf(t) {
    const fid = t.meta?.file_id;
    const sender = t.meta?.sender;
    if (!fid || !sender) return 'expired';
    const q = quarantined.get(fid);
    if (q && Date.now() - q < QUARANTINE_MS) return 'expired';
    if (!knownPeers) return 'unknown';
    if (!knownPeers.has(sender)) return 'expired';
    return capability.get(fid)?.has(sender) ? 'live' : 'expired';
  },

  /**
   * 重算接收侧卡片的可用性并推送（只在结果真的变化时才推）。
   *
   * 覆盖三种"还没开始收"的状态：
   *  - `archived` 只有文件名（来自历史证明）
   *  - `asking`   正在质询等对方重发（别打断它）
   *  - `invited`  已经拿到完整 meta、等着我点 ✓
   *
   * `invited` 也要算：那种卡片是**别人**点历史卡片时被广播进来的，
   * 发送方随后刷新，我这边同样该把它标成"发送方已离开"，而不是
   * 让它无限期停在一个点不动就永远点不动的假"待确认"。
   */
  _refreshArchived() {
    for (const [id, t] of transfers) {
      if (t.direction !== 'recv') continue;
      if (t.state === 'asking') continue; // 正在质询，别打断
      if (t.state !== 'archived' && t.state !== 'invited') continue;
      const a = this.availabilityOf(t);
      if (t.avail === a) continue;
      t.avail = a;
      if (a === 'expired' && t.state === 'invited') {
        // 从"待确认"变成"发送方已不在" —— 这是**状态变化**，不只是可用性。
        // 同时要停掉恢复逻辑留下的持久化记录，否则下次刷新还会被恢复出来。
        t.state = 'expired';
        t.error = '发送方已离开房间';
        forgetInvite(id);
        bus.emit(EV.FILE_CARD_UPDATE, {
          file_id: id,
          state: 'expired',
          avail: 'expired',
          error: t.error,
        });
        continue;
      }
      bus.emit(EV.FILE_CARD_UPDATE, { file_id: id, state: t.state, avail: a });
    }
  },

  /**
   * 点了历史文件卡片上的「接收」。
   *
   * 我们不能直接开始收：接收需要完整的 `FileMeta`（chunk_size / root_hash 用来校验），
   * 而历史里只有名字。所以这里的语义是**请发送方重发一次邀约** ——
   * 他收到质询后如果确实还持有这个文件，会重新广播 `Invite`，
   * 卡片随之变成正常的"待确认"卡片，走已经验证过的接收流程。
   *
   * 对方没响应（5 秒）→ 本地隔离成"已过期"。⚠️ 只做本地判定、**不广播"它过期了"**：
   * 我连不上他可能只是我这边网络的问题，单方面宣布会误伤别人。
   */
  async openArchived(file_id) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'recv') return;
    const a = this.availabilityOf(t);
    if (a === 'unknown') {
      bus.emit(EV.TIP, '正在确认发送方是否在线，稍等一下');
      return;
    }
    if (a !== 'live') {
      bus.emit(EV.TIP, '发送方已离开或不再提供这个文件');
      return;
    }
    t.state = 'asking';
    t.error = '';
    bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'asking' });
    try {
      await net.queryFile(file_id, t.meta.sender, t.room);
    } catch (e) {
      bus.emit(EV.TIP, `联系发送方失败：${e?.message ?? e}`);
    }
    setTimeout(() => {
      const cur = transfers.get(file_id);
      // 已经被真实的邀约接管（状态不是 asking）就不动它
      if (!cur || cur.state !== 'asking') return;
      quarantined.set(file_id, Date.now());
      cur.state = 'archived';
      cur.avail = 'expired';
      bus.emit(EV.FILE_CARD_UPDATE, {
        file_id,
        state: 'archived',
        avail: 'expired',
        error: '发送方没有响应（可能已离开）',
      });
    }, ASK_TIMEOUT_MS);
  },

  /**
   * 用户点了 ✓：**必须由点击触发**（浏览器要求用户手势），
   * 弹保存位置对话框，然后把句柄交给 Worker 去收。
   *
   * @param opts.reuseHandle 复用上次选的位置（重试时不再弹框）
   */
  async accept(file_id, opts = {}) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'recv') return;
    const { meta } = t;

    let handle;
    if (opts.useOpfs) {
      // 测试路径：Worker 自己用 OPFS 造句柄（真实类型、可克隆），
      // 主线程不参与 —— 因为自己造的"带方法对象"不可 postMessage。
      handle = null;
    } else if (opts.reuseHandle && this._handles.has(file_id)) {
      handle = this._handles.get(file_id);
    } else {
      try {
        handle = await pickSaveHandle(meta);
      } catch (e) {
        if (e?.name === 'AbortError') return this.reject(file_id, '已取消保存');
        throw e;
      }
      this._handles.set(file_id, handle);
    }

    t.state = 'active';
    bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'active' });
    // 记一次"刚刚活动过"：刷新后要能恢复（TTL 按最后活动时间算）
    rememberInvite(t.room, meta);
    try {
      // 句柄传进 Worker；之后的写入（含断点续传的位图判断）都在那边做。
      // wantResume=true：让 Worker 查 IndexedDB 决定补哪些块。
      // ⚠️ 最后一个参数是**这张卡片所属的房间**：Accept 是广播消息，
      //    Rust 侧会核对"期望房间 == 当前房间"，不一致就拒绝发送（F7）——
      //    否则用户切了房间再点接收，Accept 会飞进错误的房间（F13）。
      await net.client.call('accept', file_id, meta, handle, true, !!opts.useOpfs, t.room);
    } catch (e) {
      // ⚠️ 用户主动取消（`cancel()`）会让这个 RPC 以失败告终，但那时状态
      //    已经被置成 `paused` 了 —— 不能在这里覆盖成 `failed`，
      //    否则"保留已收内容、可以续传"这条路就没了（F16）。
      if (t.state === 'paused') return;
      t.state = 'failed';
      t.error = String(e?.message ?? e);
      bus.emit(EV.TIP, `接收失败：${t.error}`);
      bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'failed', error: t.error });
    }
  },

  /**
   * 用户主动**停下**一个正在接收的传输（卡片上的「停止」）。
   *
   * 与 `reject` 的区别：不发 Reject 给对方 —— 我们只是这一侧停下来，
   * 已收到的内容留在磁盘上、位图也保留，之后点「继续接收」即可续传。
   * 对应 Rust 的 `cancel_file`（它会让读流循环主动退出）。
   */
  async cancel(file_id) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'recv') return;
    t.state = 'paused';
    t.error = '';
    bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'paused', done: t.done, total: t.total });
    try {
      await net.client.call('cancel', file_id);
    } catch {
      /* 可能已经结束了 */
    }
  },

  async reject(file_id, reason = '用户拒绝') {
    const t = transfers.get(file_id);
    if (t) t.state = 'rejected';
    forgetInvite(file_id);
    bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'rejected' });
    try {
      // 带上房间：Reject 含自由文本理由，发错房间会泄露给无关的人（F7）
      await net.client.call('reject', file_id, reason, t?.room ?? '');
    } catch {
      /* 对方可能已经放弃 */
    }
  },

  /**
   * 重新发送（发送方在失败/超时后点「↻」）。
   *
   * 为什么能重发：`File` 对象还留在 Worker 的 `outFiles` 里，不用重选文件。
   * 为什么复用同一个 `file_id`：接收端靠它找回断点位图，这样对方接受后
   * 是**从断点续传**，而不是从头再来。
   */
  async resend(file_id) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'send') return;
    try {
      bus.emit(EV.TIP, `正在重新发送 ${t.meta.name}…`);
      await net.client.call('resend', file_id);
      t.state = 'pending';
      t.error = '';
      bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'pending', error: '' });
      bus.emit(EV.TIP, '已重新发起，等待对方确认');

      // 重新起算邀约有效期
      if (t.inviteTimer) clearTimeout(t.inviteTimer);
      t.inviteTimer = setTimeout(() => {
        const cur = transfers.get(file_id);
        if (cur && cur.state === 'pending') {
          cur.state = 'expired';
          bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'expired' });
        }
      }, INVITE_TIMEOUT_MS);
    } catch (e) {
      const msg = String(e?.message ?? e);
      bus.emit(EV.TIP, `重新发送失败：${msg}`);
      bus.emit(EV.FILE_CARD_UPDATE, { file_id, state: 'failed', error: msg });
    }
  },

  /**
   * 把一条已经失效的**接收**记录清掉（用户点了卡片上的 ✗）。
   *
   * 只删本端：不通知对端（对端早就不在了），也不动已收到的文件。
   * 存在的意义：发送方离开后，那张"已失效"的卡片会一直留在聊天框里，
   * 用户没有任何手段处理它。给它一个出口。
   */
  dismiss(file_id) {
    const t = transfers.get(file_id);
    if (!t || t.direction !== 'recv') return;
    transfers.delete(file_id);
    forgetInvite(file_id);
    this._handles.delete(file_id);
    bus.emit(EV.FILE_CARD_REMOVE, { file_id });
  },

  /** 已有多少块（UI 显示用） */
  progress(file_id) {
    return transfers.get(file_id);
  },
};

/* ------------------------------------------------------------------ 测试出口
 *
 * 自动化测试（scripts/transfer-test.py）通过这些钩子驱动真实传输。
 * 无头浏览器没有系统"保存位置"对话框，所以用 __mockFilePicker 注入
 * 内存假句柄，其余路径与真实用户完全一致。
 * ------------------------------------------------------------------------ */

window.__transfers = () => {
  const out = [];
  for (const [id, t] of transfers) {
    out.push({
      file_id: id,
      name: t.meta?.name,
      size: t.meta?.size,
      direction: t.direction,
      state: t.state,
      done: t.done,
      total: t.total,
      chunk_size: t.meta?.chunk_size,
      root_hash: t.meta?.root_hash,
      error: t.error,
      // 多接收方汇总（发送侧才有意义）
      peers: t.peers,
      peersDone: t.peersDone,
      peersFailed: t.peersFailed,
      bytes: t.bytes,
      // 历史文件卡片当前算出来的可用性（live / expired / unknown）。
      // 测试要断言"发送方走了卡片就变过期"，所以把它显式导出来；
      // UI 上的文案是从同一个值渲染的，不会出现"测的值和看到的不一致"。
      avail: t.avail,
      fromProof: !!t.fromProof,
    });
  }
  return out;
};

window.__acceptFile = (file_id) =>
  fileTransfer.accept(file_id, { useOpfs: !!window.__useOpfs });

window.__clearBitmaps = async () => {
  await net.client.call('clearBitmaps');
  // ⚠️ 顺手把 OPFS 里的目标文件也删掉 —— 只在开测前调一次。
  //    不能在每次 accept 时删（那等于每次从头开始，断点续传永远测不出来）。
  await net.client.call('resetOpfs', 'resume.bin');
  // ⚠️ **必须连邀约持久化一起清**。
  //    测试用固定身份（?key=）时，上一轮写下的邀约会在下一轮被
  //    `restoreInvites()` 恢复出来 —— 接收方于是对着**上一个 file_id**
  //    点接受，发送端根本不认（它只认自己内存里的那个），
  //    表现为「两个接收方看到的 file_id 不同」「发送端只看到 1 条通道」。
  //    （踩过：排查了很久"多接收方 bug"，其实是测试自己污染了自己。）
  localStorage.removeItem(INVITE_KEY);
  transfers.clear();
  fileTransfer._handles.clear();
  window.__writeLog = [];
};

/** 诊断：Worker 内部每条出站通道（file_id:peer）的原始状态 */
window.__outgoingDetail = (fileId) =>
  net.client.call('outgoingDetail', fileId ?? '').then((s) => JSON.parse(s));

/** 诊断：Worker 内存里还留着的文件引用（该释放没释放 = 泄漏） */
window.__outFileRefs = () => net.client.call('outFiles').then((s) => JSON.parse(s));

/** 诊断：发送端收到的 Accept 流水（多接收方排查用） */
window.__accLog = () => net.client.call('accLog').then((s) => JSON.parse(s));

/** 当前 IndexedDB 里的断点位图 key（测试用） */
window.__pendingBitmaps = async () => JSON.parse(await net.client.call('pendingBitmaps'));

/** 测试用：开/关"写入日志回传"（只回块序号，不回数据） */
window.__setTestMode = (on) => net.client.call('setTestMode', !!on);

/** 测试用：从 OPFS 读回收到的文件做逐字节校验（只回结论） */
window.__verifyOpfs = async (name, size, chunkSize) =>
  JSON.parse(await net.client.call('readOpfsFile', name, size, chunkSize));
