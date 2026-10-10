/* ============================================================================
 * types.ts · 移动端消费的类型
 *
 * ⚠️⚠️ **协议类型不在这里定义。**
 *
 *   唯一的定义在 Rust：`client-wasm/src/{room.rs,filetransfer.rs}`，
 *   由 `bash scripts/gen-protocol-types.sh` 生成到 `./protocol.gen.ts`
 *   （`scripts/verify.sh` 会重新生成并比对，不一致直接红）。
 *
 *   本文件只放两类东西：
 *     1. **只有 UI 才关心**的类型（RelayStatus / FileSaved / 监听器签名…）
 *     2. 给生成类型起的别名（保持调用方 import 路径不变）
 *
 * ## 为什么改成生成（这是改造前的真实缺陷，不是洁癖）
 *
 *   改造前这里手抄了一整套协议类型，结果漂了两次，而且**都编译通过**：
 *     · `PeerInfo.last_seen_ms` —— Rust 实际发的是 `lastSeenMs`（带名字段吃 rename_all），
 *       所以这个字段在运行期**永远是 undefined**；
 *     · `{ type: 'relay'; status }` —— Rust 实际发的是 `relayStatus{relays}`，
 *       于是"中继状态事件"从来没被处理过（UI 只能靠 2 秒轮询兜着，看着像正常工作）。
 *   TS 的结构化类型拦不住这类错误：字段名写错只是"多了一个没人读的属性"。
 * ==========================================================================*/

export type {
  ChatMessage,
  FileMeta,
  FileRef,
  PeerInfo,
  RelayInfo,
  RoomEvent,
} from './protocol.gen';
/** 协议版本（生成自 Rust 的 `sigfmt::PROTO_V5`）—— 下次 bump 时只改 Rust */
export { CHAT_PROTOCOL as PROTOCOL } from './protocol.gen';

import type { RelayInfo, RoomEvent } from './protocol.gen';

/** 一台中继的完整状态 —— 直接用生成类型（曾经是手抄的 `RelayInfoLike`） */
export type RelayInfoLike = RelayInfo;

/**
 * "当前在用的那台中继"的摘要 —— **UI 类型，不是协议类型**。
 *
 * `rtt_ms` 来自 HTTP 探测（不是数据面 RTT），Rust 侧的中继状态里没有这个字段，
 * 所以它必须留在这一层，不能指望生成。
 */
export interface RelayStatus {
  url: string | null;
  connected: boolean;
  rtt_ms?: number | null;
}

/**
 * 文件接收成功后的落盘信息 —— **本地实现产生的**，不属于线协议。
 *
 * `location` 是给人看的（Android 上是 `Download/iroh`），
 * 不是可用的文件路径 —— scoped storage 下不该拿它去 open。
 */
export interface FileSaved {
  /** 实际收到的字节数 */
  bytes: number;
  /** 落盘后的文件名（已 sanitize） */
  name: string;
  /** 人类可读的位置描述 */
  location: string;
}

/** 事件监听器（返回取消订阅函数） */
export type EventListener = (ev: RoomEvent) => void;
export type Unsubscribe = () => void;
