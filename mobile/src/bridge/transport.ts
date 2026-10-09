/* ============================================================================
 * Transport —— RN 与 Rust core 之间的**唯一契约**
 *
 * 设计原则：这一层必须能被两种实现替换，且上层 UI 察觉不到差别。
 *   - `MockTransport`  —— 纯 JS 假数据，**今天就能跑在手机上**（写 UI 用）
 *   - `NativeTransport` —— 调 Rust 编出的 .so/.aar（等 CI 产物就位后接）
 *
 * 为什么要有 mock：UI 有 ~7000 行的活，而 Rust 产物还没编出来。
 * 两边并行，谁也别等谁 —— 接口定死之后，接起来只是换一个实现。
 *
 * ⚠️ 契约来自 `client-wasm/src/wasm_api.rs` 的 `RoomNode`，别自己发明方法名。
 *    那边的方法：start / endpoint_id / online / join / send / events /
 *    set_nickname / leave_room / fetch_history / set_available_files /
 *    query_file / invite_file / accept_and_receive / reject_file / cancel_file
 * ==========================================================================*/

import type {
  ChatMessage,
  EventListener,
  FileMeta,
  FileSaved,
  PeerInfo,
  RelayStatus,
  Unsubscribe,
} from './types';

export interface RoomOptions {
  /** 房间名 = 访问凭据 */
  room: string;
  nickname: string;
  /** 中继地址（默认取内置配置） */
  relays?: string[];
}

export interface HistoryPage {
  messages: ChatMessage[];
  /** 复合游标 `"<ts>:<id>"`，用于继续往前翻；null = 没有更早的了 */
  before: string | null;
}

/**
 * 一个已启动的节点。生命周期：`create()` → `join()` → 收发 → `shutdown()`
 *
 * 方法名与 Rust 侧保持**接近但符合 JS 习惯**：Rust 是 snake_case
 * （`fetch_history`），TS 用 camelCase（`fetchHistory`）——
 * 这层转换就在 NativeTransport 里做，UI 只认 camelCase。
 */
export interface Transport {
  /** 本机身份（64 位 hex EndpointId）—— 持久化，重启不变 */
  readonly endpointId: string;

  /** 等中继连上（幂等；已连上立即返回） */
  online(): Promise<void>;

  /** 当前中继状态 */
  relayStatus(): RelayStatus;

  /** 进房（换房也用它；Rust 侧会自动清空文件货架） */
  join(opts: RoomOptions): Promise<void>;

  /** 发一条文本，返回消息 id */
  send(text: string): Promise<string>;

  /** 改昵称 */
  setNickname(name: string): Promise<void>;

  /** 退房（进程保持存活） */
  leaveRoom(): Promise<void>;

  /** 拉一页历史；`before` 为空表示取最新一页 */
  fetchHistory(limit: number, before?: string | null): Promise<HistoryPage>;

  /* ---- 事件 ---- */

  /** 订阅事件，返回取消函数 */
  subscribe(listener: EventListener): Unsubscribe;

  /* ---- 文件（v1 只做"能收"，发送后面补）---- */

  /** 发布一个文件，返回它的元信息 */
  publishFile(uri: string, name: string, size: number, mime: string): Promise<FileMeta>;

  /**
   * 接收某人发来的文件。
   *
   * ★ 传 **meta 整体**（不是 fileId）：原因见 client-wasm/src/jni_api.rs 顶部
   *   —— fileId 是公开广播的、不是授权凭据，真正的授权校验（`root_hash`
   *   与大小/块数自洽）必须拿整份 meta 才能做。只传 id 会迫使原生侧
   *   再去缓存一份 meta，多一处可能不同步的状态。
   *
   * 落盘位置**由实现决定**（Android：公共 Downloads/iroh，走 MediaStore），
   * 调用方不指定路径 —— 移动端没有让用户选路径的稳定方式。
   *
   * 返回落盘结果（供 UI 显示"存到哪了"）。
   */
  acceptFile(fileId: string, meta: FileMeta): Promise<FileSaved>;

  /** 拒绝接收 */
  rejectFile(fileId: string, reason: string): Promise<void>;

  /** 当前货架（本机可提供的文件） */
  availableFiles(): string[];

  /** 告诉网络"我还能提供这些文件"（心跳里带上） */
  setAvailableFiles(ids: string[]): Promise<void>;

  /** 关掉节点 */
  shutdown(): Promise<void>;
}

/** 节点工厂 —— 平台实现从这里进来 */
export interface TransportFactory {
  create(opts?: { relays?: string[]; relayToken?: string }): Promise<Transport>;
}

/** 成员列表辅助：当前房间的 peers（从 presence 事件维护） */
export type PeerMap = ReadonlyMap<string, PeerInfo>;
