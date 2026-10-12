/* ============================================================================
 * protocol.ts · iroh-agent serve 行协议
 *
 * 这一层有两种东西，来源不同：
 *
 *   1. **房间/文件协议**（ChatMessage / FileMeta / RoomEvent …）——
 *      **定义在 Rust 里**，由 `bash scripts/gen-protocol-types.sh` 生成到
 *      `./protocol.gen.ts`。本文件只做转出，不再手抄（改造前手抄过，且已经漂移）。
 *
 *   2. **行协议信封**（hello / reply / event / fatal / bye …）——
 *      目前仍是手写：它在 `client-wasm/src/bin/agent.rs` 里是用 `json!` 拼的，
 *      Rust 侧没有对应的强类型可导出。⚠️ 改字段前先改 `docs/agent-daemon-protocol.md`，
 *      两边同步。（把它也变成生成物是后续工作，见架构方案文档。）
 *
 * ⚠️ 本目录用 Node 原生类型剥离直接跑 TS（不做编译）：
 *   1. 类型导入必须 `import type`
 *   2. 相对导入必须带 `.ts` 扩展名
 * ==========================================================================*/

/* ---- 房间/文件协议：Rust 生成，不手抄 ---- */
export type {
  ChatMessage,
  FileMeta,
  FileRef,
  PeerInfo,
  RelayInfo,
} from './protocol.gen.ts';
/** 聊天协议版本（生成自 Rust 的 `sigfmt::PROTO_V5`）—— 下次 bump 时只改 Rust */
export { CHAT_PROTOCOL } from './protocol.gen.ts';

import type { RoomEvent as WireRoomEvent } from './protocol.gen.ts';

/**
 * 行协议版本（hello 里的 `v`）。
 *
 * ⚠️ 手写的：真源是 `client-wasm/src/bin/agent.rs` 的 `IPC_VERSION`。
 *    AgentClient 启动时会比对，不一致直接抛 protocolMismatch（不做兼容猜测）。
 */
export const IPC_VERSION = 1;

/* ---------------------------------------------------------------- 行协议信封 */

/** daemon 启动后的第一行（握手） */
export interface HelloFrame {
  v: number;
  type: 'hello';
  agent: string;
  endpointId: string;
  chatProtocol: string;
  nickname: string;
  relay: RelayInfoWire | null;
}

export interface ErrorBody {
  code: string;
  message: string;
}

/** 命令回复（与命令的 `id` 关联；schema 见协议 §7） */
export interface ReplyFrame {
  v: number;
  type: 'reply';
  id: string | null;
  ok: boolean;
  value?: unknown;
  error?: ErrorBody;
}

/** 事件信封：`event` 里是 RoomEvent 的 serde JSON 原样（不要做字段重命名） */
export interface EventFrame {
  v: number;
  type: 'event';
  seq: number;
  event: RoomEvent;
}

export type Frame = HelloFrame | ReplyFrame | EventFrame;

/* ------------------------------------------------------------------ 事件 */

import type { RelayInfo as RelayInfoWire } from './protocol.gen.ts';

/**
 * **daemon 自产**的事件（不属于房间协议，wire 上不存在）。
 *
 * ⚠️ 这一组字段是 **camelCase**，与 wire 事件（snake_case）**故意不同** ——
 *    因为它们由 `agent.rs` 手写 `json!` 产生，不是 serde 序列化出来的。
 *    别"顺手统一"，那会让真实数据对不上。
 *
 * ⚠️ 名字撞车：wire 也有 `fileProgress`，但那个是 snake_case
 *    （`{file_id, direction, done_chunks, total_chunks, received_bytes, total_bytes}`），
 *    与这里 daemon 自产的 `{fileId, peer, direction, doneChunks, …}` **不是同一个东西**。
 */
export type DaemonRoomEvent =
  | { type: 'joined'; room: string; clearedFiles?: string[] }
  | { type: 'fileSendStarted'; fileId: string; peer: string; needChunks: number }
  | {
      type: 'fileProgress';
      fileId: string;
      peer: string;
      direction: string;
      doneChunks: number;
      totalChunks: number;
      bytes: number;
    }
  | { type: 'fileSendFinished'; fileId: string; peer: string }
  | { type: 'fileSendFailed'; fileId: string; peer: string; reason: string }
  | {
      type: 'fileRecvStarted';
      fileId: string;
      peer: string;
      room: string;
      path: string;
      size: number;
    }
  | { type: 'fileRecvFinished'; fileId: string; peer: string; path: string; bytes: number }
  | { type: 'fileRecvFailed'; fileId: string; peer: string; reason: string }
  | { type: 'fatal'; reason: string }
  | { type: 'bye'; reason: string };

/**
 * 适配器看到的事件 = **房间协议事件**（生成）+ **daemon 自产事件**（手写）。
 *
 * ⚠️ 这里**刻意不加** `{ type: string }` 兜底。加了的后果实测很明确：
 *    联合类型里一旦有"任何 type 都匹配"的成员，`switch (ev.type)` 就**收窄失效**，
 *    于是 `ev.mine` / `ev.meta` / `ev.reason` 全部变成编译错误（因为可能命中兜底成员）。
 *
 *    向前兼容由**运行时**保证：JSON 里出现没见过的事件类型时，
 *    它自然落进 switch 的 `default` 分支被安静忽略。
 *    "没见过的事件"本来也不该有类型——它还没被定义。
 */
export type RoomEvent = WireRoomEvent | DaemonRoomEvent;

/** 协议错误：`code` 给程序判断（未知 code 一律按 internal 处理），`message` 给人看。 */
export class AgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AgentError';
    this.code = code;
  }
}
