/* ============================================================================
 * protocol.ts · iroh-agent serve 行协议的类型与常量
 *
 * 与 docs/agent-daemon-protocol.md 对齐（v1）。**改字段前先改文档**，两边同步。
 *
 * ⚠️ 本目录用 Node 原生类型剥离直接跑 TS（无需构建）。两个硬约束：
 *   1. 类型导入必须 `import type`（否则运行时去 import 一个只有类型的模块会炸）
 *   2. 相对导入必须带 `.ts` 扩展名
 * ==========================================================================*/

export const IPC_VERSION = 1;

/** 聊天协议版本：必须与 roomd / 前端一致（v4）。不匹配宁可拒绝也不静默丢消息。 */
export const CHAT_PROTOCOL = 'v4';

export interface RelayInfo {
  url: string;
  connected: boolean;
  lastError?: string | null;
  authDenied?: string | null;
}

/** daemon 启动后的第一行（握手） */
export interface HelloFrame {
  v: number;
  type: 'hello';
  agent: string;
  endpointId: string;
  chatProtocol: string;
  nickname: string;
  relay: RelayInfo | null;
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

export interface FileRef {
  file_id: string;
  name: string;
  size: number;
  mime?: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  nickname: string;
  text: string;
  ts: number;
  sig?: string;
  file?: FileRef | null;
}

export interface FileMeta {
  file_id: string;
  name: string;
  size: number;
  mime: string;
  chunk_size: number;
  root_hash: string;
  sender: string;
  sender_relay: string;
  ts: number;
}

export interface PeerInfo {
  id: string;
  nickname: string;
  lastSeenMs: number;
  files: string[];
  epoch: number;
}

/**
 * 房间事件。前半段是 RoomEvent 直通（字段名以 Rust serde 输出为准，注意
 * snake_case/camelCase 混用是**故意的**，不要"顺手统一"）；后半段是 daemon 自产。
 * 末尾的 `{ type: string }` 兜底是为了**向前兼容**：未来加的新事件不会让适配器崩。
 */
export type RoomEvent =
  | { type: 'joined'; room: string; clearedFiles?: string[] }
  | { type: 'message'; room: string; mine: boolean; message: ChatMessage }
  | { type: 'presence'; room: string; peers: PeerInfo[] }
  | { type: 'peerUp'; id: string }
  | { type: 'peerDown'; id: string }
  | { type: 'fileInvite'; room: string; meta: FileMeta }
  | {
      type: 'fileAccepted';
      room: string;
      file_id: string;
      have: string;
      receiver_relay: string;
      by: string;
    }
  | { type: 'fileRejected'; room: string; file_id: string; reason: string; by: string }
  | { type: 'fileDone'; room: string; file_id: string; ok: boolean; reason: string }
  | { type: 'fileQueryAsked'; room: string; file_id: string; by: string }
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
  | { type: 'relayStatus'; relays: RelayInfo[] }
  | { type: 'error'; message: string }
  | { type: 'fatal'; reason: string }
  | { type: 'bye'; reason: string }
  | { type: string };

/** 协议错误：`code` 给程序判断（未知 code 一律按 internal 处理），`message` 给人看。 */
export class AgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AgentError';
    this.code = code;
  }
}
