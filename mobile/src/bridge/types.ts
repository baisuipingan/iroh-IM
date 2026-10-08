/* ============================================================================
 * 与 Rust 侧一一对应的类型定义
 *
 * ⚠️ **命名规则不对称，抄的时候别想当然**（踩过，见下方）：
 *   - `RoomEvent` 枚举：`#[serde(tag = "type", rename_all = "camelCase")]`
 *     → **事件名和字段都是 camelCase**（`fileInvite` / `fileId`）
 *   - `ChatMessage` / `FileMeta` / `PeerInfo`：**没有** rename_all
 *     → **字段是 snake_case**（`file_id` / `root_hash`）
 *
 *   也就是说 `{"type":"fileInvite","room":..,"meta":{...,"file_id":..}}`
 *   同一层 JSON 里两种命名混用。根源在 Rust 侧的 serde 注解不统一，
 *   改起来会动到线协议（要 bump 版本 + 清历史），所以这里**如实照抄**。
 *   真源：client-wasm/src/room.rs、client-wasm/src/filetransfer.rs
 * ==========================================================================*/

/** 协议版本（与 sigfmt.rs 的 PROTO_V4 对齐；房间标识进签名载荷） */
export const PROTOCOL = 'v4' as const;

/** 一条聊天消息 —— 对应 room.rs 的 `ChatMessage` */
export interface ChatMessage {
  id: string;
  /** 发送者的 EndpointId（64 位 hex） */
  from: string;
  nickname: string;
  text: string;
  /** 毫秒时间戳 */
  ts: number;
  /** ed25519 签名（hex） */
  sig: string;
  /** `Some` = 这是「文件证明」，UI 应渲染成文件卡片而不是文本气泡 */
  file?: FileRef | null;
}

/** 消息里附带的文件引用 —— 对应 room.rs 的 `FileRef` */
export interface FileRef {
  file_id: string;
  name: string;
  size: number;
  mime: string;
  root_hash: string;
}

/** 文件元信息 —— 对应 filetransfer.rs 的 `FileMeta` */
export interface FileMeta {
  /** 本次传输的随机 id（16 hex） */
  file_id: string;
  name: string;
  size: number;
  mime: string;
  chunk_size: number;
  /** 整个文件的 blake3（hex），接收方据此校验 */
  root_hash: string;
  /** 发送方 EndpointId */
  sender: string;
  /** 发送方的 home 中继地址（接收方要连它，必须知道） */
  sender_relay: string;
  ts: number;
}

/** 房间成员 —— 对应 room.rs 的 `PeerInfo` */
export interface PeerInfo {
  id: string;
  nickname: string;
  last_seen_ms: number;
  /** 他此刻还能提供的 file_id（来自心跳）。UI 据此判断历史卡片能否收 */
  files: string[];
  epoch: number;
}

/** 中继连接状态 */
export interface RelayStatus {
  url: string | null;
  connected: boolean;
  /** 延迟（毫秒），未测出时为 null */
  rtt_ms?: number | null;
}

/* ============================================================================
 * 事件 —— 对应 room.rs 的 `RoomEvent`（tag = "type", camelCase）
 * ==========================================================================*/

interface EvRoom {
  room: string;
}

export type RoomEvent =
  | ({ type: 'joined' } & EvRoom)
  | ({ type: 'message'; message: ChatMessage; mine: boolean } & EvRoom)
  | ({ type: 'presence'; peers: PeerInfo[] } & EvRoom)
  | { type: 'peerUp'; id: string }
  | { type: 'peerDown'; id: string }
  | ({ type: 'history'; messages: ChatMessage[] } & EvRoom)
  | ({ type: 'fileInvite'; meta: FileMeta } & EvRoom)
  | ({
      type: 'fileRejected';
      fileId: string;
      reason: string;
      /** 拒绝方的 EndpointId —— 多接收者时必须靠它区分是哪条通道 */
      by: string;
    } & EvRoom)
  | ({
      type: 'fileAccepted';
      fileId: string;
      /** 接收方已有多少字节（断点续传） */
      have: string;
      receiverRelay: string;
      by: string;
    } & EvRoom)
  | ({ type: 'fileDone'; fileId: string; ok: boolean; reason: string } & EvRoom)
  | ({
      type: 'fileQueryAsked';
      fileId: string;
      requester: string;
    } & EvRoom)
  | ({ type: 'relay'; status: RelayStatus } & EvRoom)
  | ({ type: 'error'; message: string } & EvRoom);

/** 事件监听器（返回取消订阅函数） */
export type EventListener = (ev: RoomEvent) => void;
export type Unsubscribe = () => void;
