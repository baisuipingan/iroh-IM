/* ============================================================================
 * bus.js · 极简事件总线
 *
 * 视图之间不互相直接调用，一律通过事件解耦：
 *   - net.js  收到消息   → bus.emit('msg', ...)
 *   - sidebar 渲染列表   → bus.on('msg', ...)
 *   - timeline 追加气泡  → bus.on('msg', ...)
 *
 * 这样任何模块都可以独立替换，不需要改动别人。
 * ==========================================================================*/

const handlers = new Map();

export const bus = {
  /** 订阅 */
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => handlers.get(event)?.delete(fn);   // 返回取消函数
  },

  /** 发布（同步派发；单个监听器抛错不影响其它监听器） */
  emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] "${event}" 监听器异常`, e);
      }
    }
  },
};

/** 事件名集中定义，避免拼错 */
export const EV = {
  READY: 'ready',                 // 节点就绪
  REJOINED: 'rejoined',           // 断线重连后自动回到了某个房间
  NODE_STATE: 'node-state',       // { ok: boolean, text: string }
  RELAYS: 'relays',               // 中继状态数组
  MSG: 'message',                 // { room, message, mine, isHistory }
  HISTORY: 'history',             // { room, messages }
  PRESENCE: 'presence',           // 成员列表
  PEER_UP: 'peer-up',             // { id } 某个邻居上线（Rust 一直在发，之前被丢弃）
  PEER_DOWN: 'peer-down',         // { id } 某个邻居下线
  ROOM_OPEN: 'room-open',         // 进入某个房间（UI 意图）
  ROOM_LEFT: 'room-left',
  NOTE: 'note',                   // 时间线里的系统提示
  TIP: 'tip',                     // 底部的操作提示
  SEND_FAILED: 'send-failed',     // { text, reason } 发送失败 → 时间线上留一个可重发的气泡
  RETRY_SEND: 'retry-send',       // { text } 点气泡上的"重新发送"
  UNREAD: 'unread',               // 未读变化
  PEERS: 'peers',
  // 文件传输
  FILE_INVITE: 'file-invite',       // { room, meta }
  FILE_ACCEPTED: 'file-accepted',   // { file_id, have, receiver_relay, by }
  FILE_REJECTED: 'file-rejected',   // { file_id, reason }
  FILE_DONE: 'file-done',           // { file_id, ok, reason }
  FILE_CARD: 'file-card',           // 新卡片（UI 渲染）
  FILE_CARD_UPDATE: 'file-card-update', // 卡片状态更新
  FILE_CARD_REMOVE: 'file-card-remove', // 把卡片摘掉（如"移除已失效的接收记录"）
  FILE_ACCEPT: 'file-accept',       // 用户点了 ✓（UI → 逻辑）
  FILE_REJECT: 'file-reject',       // 用户点了 ✗
  FILE_RESEND: 'file-resend',       // 发送方点「重新发送」（失败/超时后）
  FILE_DISMISS: 'file-dismiss',     // 接收方把这个已失效的卡片清掉（只删本端，不通知对端）
  FILE_CANCEL: 'file-cancel',       // 接收中主动停下（保留已收内容，可续传）
  // 历史里的「文件证明」（一条 text 为空、带 file 字段的消息）→ 交给传输模块渲染卡片。
  // 为什么不让时间线直接画：只有它才知道"发送方现在还在不在、还愿不愿意提供"
  FILE_PROOF: 'file-proof',         // { room, m }
  FILE_OPEN: 'file-open',           // 点了历史里的文件卡片 → 请发送方重发邀约
};
