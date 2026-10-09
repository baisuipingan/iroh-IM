/* ============================================================================
 * 与 Rust 侧一一对应的类型定义
 *
 * ⚠️⚠️ **别想当然：整个文件里字段全是 snake_case。**
 *
 *   - `RoomEvent` 枚举：`#[serde(tag = "type", rename_all = "camelCase")]`
 *     → `rename_all` 只改**变体名**（`FileAccepted` → `"fileAccepted"`）
 *       和**带名字段**；本项目的变体全是**匿名字段**，键名保持不变 →
 *       **字段仍是 snake_case**（`file_id` / `receiver_relay`）
 *   - `ChatMessage` / `FileMeta` / `PeerInfo`：**没有** rename_all
 *     → 字段同样是 snake_case（`file_id` / `root_hash`）
 *
 *   所以真实的 JSON 长这样（已用序列化实验核对过，不是查文档推的）：
 *
 *       {"type":"fileAccepted","room":"x","file_id":"f1","have":"0",
 *        "receiver_relay":"https://r","by":"peer"}
 *       {"type":"fileInvite","room":"x","meta":{"file_id":"f1","chunk_size":262144,…}}
 *
 *   即**只有 `"type"` 的值（变体名）是 camelCase**，其余全部 snake_case。
 *
 *   根源是 Rust 侧 serde 注解的既有风格，改它要动线协议
 *   （bump 版本 + 清历史），所以这里**如实照抄**。
 *   真源：client-wasm/src/room.rs、client-wasm/src/filetransfer.rs
 *
 *   教训：写成 camelCase 不会报任何错 —— 只是运行时读到 `undefined`，
 *   属于"类型看着对、悄悄错"。所以这里用实测输出而不是推测。
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
 *
 * ⚠️⚠️ **只有「变体名」是 camelCase，字段名是 snake_case。**
 *
 *   `#[serde(tag = "type", rename_all = "camelCase")]` 里的 `rename_all`
 *   只作用于**变体名**（`FileAccepted` → `"fileAccepted"`）与**带名字段**，
 *   而这里全是**匿名字段**（`{ file_id: String }`）—— serde 不会去改它们的键名，
 *   所以字段保持 Rust 里的 snake_case。
 *
 *   已用真实序列化实验确认（不是从文档推的）：
 *     {"type":"fileAccepted","room":"x","file_id":"f1","have":"0",
 *      "receiver_relay":"https://r","by":"peer"}
 *     {"type":"fileDone","room":"x","file_id":"f1","ok":true,"reason":""}
 *
 *   写成 `fileId` 的后果：TS 侧读不到值（`undefined`），
 *   而**不会报任何错** —— 属于"类型看着对、运行时悄悄错"。
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
      file_id: string;
      reason: string;
      /** 拒绝方的 EndpointId —— 多接收者时必须靠它区分是哪条通道 */
      by: string;
    } & EvRoom)
  | ({
      type: 'fileAccepted';
      file_id: string;
      /** 接收方已有多少字节（断点续传） */
      have: string;
      receiver_relay: string;
      by: string;
    } & EvRoom)
  | ({ type: 'fileDone'; file_id: string; ok: boolean; reason: string } & EvRoom)
  | ({
      type: 'fileQueryAsked';
      file_id: string;
      requester: string;
    } & EvRoom)
  | ({ type: 'relay'; status: RelayStatus } & EvRoom)
  | ({ type: 'error'; message: string } & EvRoom);

/** 事件监听器（返回取消订阅函数） */
export type EventListener = (ev: RoomEvent) => void;
export type Unsubscribe = () => void;
