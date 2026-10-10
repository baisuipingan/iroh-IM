/* ============================================================================
 * 由 Rust 生成 —— **不要手改这个文件**。
 *
 * 来源：client-wasm/src/{room.rs,filetransfer.rs}
 * 生成：bash scripts/gen-protocol-types.sh
 * 校验：scripts/verify.sh 会重新生成并比对（不一致直接红）
 *
 * ⚠️ 字段名是 snake_case 而**变体名**是 camelCase，这不是笔误：
 *    serde 的 `rename_all` 只改变体名与带名字段，匿名字段的键名保持原样。
 *    详见 client-wasm/src/ts_export.rs 顶部说明。
 * ==========================================================================*/

/// 聊天协议版本（Rust 侧 `sigfmt::PROTO_V5`）。三端必须一致；
/// v5 切换时**只改 Rust**，然后重跑 scripts/gen-protocol-types.sh。
export const CHAT_PROTOCOL = "v5";

/**
 * 「文件存在的证明」——**只记元信息，不含内容**。
 *
 * 用途：文件邀约本来是"发送那一刻 broadcast 一次"的瞬时事件，后进房间的人
 * 完全收不到。把这条证明写进历史后，谁进来都能看到"这里曾经有过一个文件"，
 * 名字/大小作为上下文；能不能真接收要另外看发送方还在不在（见 `Presence::files`）。
 */
export type FileRef = { file_id: string, name: string, size: number, mime: string, };

/**
 * 文件元信息（邀约里带的全部内容，不含文件本身）。
 */
export type FileMeta = { 
/**
 * 本次传输的随机 id（16 hex）
 */
file_id: string, name: string, size: number, mime: string, chunk_size: number, 
/**
 * 整个文件的 blake3（hex），接收方据此校验
 */
root_hash: string, 
/**
 * 发送方 EndpointId
 */
sender: string, 
/**
 * 发送方的 home 中继地址（接收方要连它，必须知道）
 */
sender_relay: string, ts: number, };

/**
 * 一条聊天消息。**签名字段 = 除 `sig` 外的每一个字段**（含 `id`）。
 *
 * ## 协议版本 v3
 *
 * 三处破坏性变更（合起来是 v3），按约定直接清旧历史，不做兼容：
 *
 * 1. **编码换成无歧义的长度前缀**（[`sigfmt`]）。原来 `|` 拼接让
 *    "昵称 `Alice` + 正文 `A|B`" 与 "昵称 `Alice|A` + 正文 `B`"
 *    规范化成同一串字节 —— 签名有效但语义被改掉了。
 * 2. **`id` 纳入签名**。原来 `id` 不在签名载荷里，任何人拿到一条
 *    有效签名消息后改 `id` 就能重放成多条（历史按 id 去重，等于凭空多发言）。
 * 3. **`id` 由签名载荷派生** —— 见 [`ChatMessage::compute_id`]。
 *
 * v1 = 纯文本；v2 = 加了文件证明的 4 个字段；v3 = 本版。
 */
export type ChatMessage = { id: string, from: string, nickname: string, text: string, ts: number, sig: string, 
/**
 * `Some` = 这是一条「文件证明」，客户端应渲染成文件卡片而不是文本气泡
 */
file: FileRef | null, };

export type PeerInfo = { id: string, nickname: string, lastSeenMs: number, 
/**
 * 他此刻还能提供的 file_id（来自他的心跳）。**只记 id，名字在历史里。**
 * 前端据此判断"历史里那个文件现在能不能收"。
 */
files: Array<string>, 
/**
 * 他最后上报的单调序号，用于丢弃乱序的旧心跳
 */
epoch: number, };

export type RelayInfo = { url: string, connected: boolean, lastError: string | null, authDenied: string | null, };

export type RoomEvent = { "type": "joined", room: string, } | { "type": "message", room: string, message: ChatMessage, mine: boolean, } | { "type": "presence", room: string, peers: Array<PeerInfo>, } | { "type": "peerUp", id: string, } | { "type": "peerDown", id: string, } | { "type": "history", room: string, messages: Array<ChatMessage>, } | { "type": "fileInvite", room: string, meta: FileMeta, } | { "type": "fileRejected", room: string, file_id: string, reason: string, by: string, } | { "type": "fileAccepted", room: string, file_id: string, have: string, receiver_relay: string, by: string, } | { "type": "fileDone", room: string, file_id: string, ok: boolean, reason: string, } | { "type": "fileQueryAsked", room: string, file_id: string, by: string, } | { "type": "fileProgress", file_id: string, direction: string, done_chunks: number, total_chunks: number, received_bytes: number, total_bytes: number, } | { "type": "isolated", room: string, isolated: boolean, } | { "type": "protocolMismatch", room: string, ours: string, theirs: string, } | { "type": "plugin", name: string, payload: unknown, } | { "type": "relayStatus", relays: Array<RelayInfo>, } | { "type": "error", message: string, };

