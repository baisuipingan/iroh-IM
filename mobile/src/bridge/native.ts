/* ============================================================================
 * NativeTransport —— `Transport` 接口的真实现（走 Rust 原生模块）
 *
 * UI 完全不知道自己在用哪个实现：`App.tsx` 里换一行就切过来了。
 *
 * ## ★★ 最关键的一件事：**先开事件循环，再 join**
 *
 * Rust 侧的 `RoomNode::join` 是 await 的，而 `joined` / `history` 在它
 * **返回之前**就已经产生。所以顺序必须是：
 *
 *     ① 启动事件循环（不认识房间，只把事件塞进缓冲区）
 *     ② 再 await join
 *     ③ 事件循环里按 roomRef 过滤、投递给订阅者
 *
 * 反过来（join 完再开循环）会丢掉 joined + history —— 表现为
 * 「进了房但看不到历史、一直显示未加入」。这个坑在 TS 侧真实发生过
 * （见 useRoom.ts 注释），在 Kotlin 侧也有同样注释。
 *
 * ## 事件循环的形式：自驱 async 循环 + poll
 *
 * `pollEvent(200)` 会阻塞最多 200ms。所以：
 *   - 循环本身是 async 的，靠 `await` 让出主线程，**不会卡 UI**
 *   - 不引入 setInterval：间隔处会丢事件（用户打字很快时也可能）
 *   - 停止靠 `stopped` 旗标 —— 循环在每次 poll 返回后检查一次
 *
 * ## 为什么不用「Rust 主动回调 JS」
 *
 * 那需要 Expo Modules 的 `sendEvent`，而 JS 侧一旦没监听（App 进后台、
 * 组件卸载间隙）事件就永久丢失。拉取模式下**背压天然成立**：
 * JS 处理不过来就不会调下一次 poll，Rust 侧队列自然积压。
 * ==========================================================================*/

import type { HistoryPage, RoomOptions, Transport } from './transport';
import type {
  ChatMessage,
  EventListener,
  FileMeta,
  RelayStatus,
  RoomEvent,
  Unsubscribe,
} from './types';
import { irohNative } from '../../modules/iroh-native/src';

export class NativeTransport implements Transport {
  private readonly ptr: number;
  private readonly listeners = new Set<EventListener>();
  private stopped = false;
  /** 事件循环的 promise（shutdown 时 await 它，确保线程退干净） */
  private loop: Promise<void> | null = null;
  private _endpointId = '';

  private constructor(ptr: number) {
    this.ptr = ptr;
  }

  /**
   * 建节点 + **立刻启动事件循环**（注意顺序，见文件头）。
   *
   * ⚠️ 这里就开循环、而不是等 join 才开：joined/history 在 join 期间产生。
   */
  static async create(opts: {
    relays: string[];
    relayToken?: string | null;
    anchorId?: string | null;
    anchorRelay?: string | null;
  }): Promise<NativeTransport> {
    const ptr = await irohNative.create(opts);
    const t = new NativeTransport(ptr);
    t._endpointId = await irohNative.endpointId();
    t.loop = t.runEventLoop();
    return t;
  }

  get endpointId(): string {
    return this._endpointId;
  }

  /**
   * 事件循环：把原生事件转成 `RoomEvent` 交给订阅者。
   *
   * 循环退出条件：`stopped` 为 true。`shutdown()` 会置位并 await 本 promise。
   */
  private async runEventLoop(): Promise<void> {
    while (!this.stopped) {
      let raw: unknown | null = null;
      try {
        raw = await irohNative.pollEvent(200);
      } catch (e) {
        // 节点被释放（nativeFree 之后再 poll 会抛异常）—— 正常退出，不当错误
        if (this.stopped) break;
        this.emitLocal({
          type: 'error',
          room: '',
          message: e instanceof Error ? e.message : String(e),
        });
        break;
      }
      if (raw == null) continue; // 超时，无事件

      const ev = raw as RoomEvent;
      if (!ev || typeof ev !== 'object' || !('type' in ev)) continue;
      this.emitLocal(ev);
    }
  }

  private emitLocal(ev: RoomEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // 一个订阅者抛异常不能拖垮整个循环（否则后面所有事件都收不到）
      }
    }
  }

  /* ------------------------------------------------------------------ */

  async online(): Promise<void> {
    await irohNative.online();
  }

  relayStatus(): RelayStatus {
    // 注意：原生侧返回的是**数组**（多中继），移动端 v1 只取第一个
    // （配置里就一台）。要支持多中继时这里改成聚合。
    return {
      url: this.relays[0] ?? null,
      connected: this.lastRelayConnected,
      rtt_ms: null,
    };
  }

  /** 由 join 时传入的配置记下来，供 relayStatus 用 */
  private relays: string[] = [];
  private lastRelayConnected = false;

  async join(opts: RoomOptions): Promise<void> {
    this.relays = opts.relays ?? [];
    await irohNative.join(opts.room, opts.nickname);
    // 记下来供 fetchHistory / relayStatus 用（Rust 侧其实也有 current_room，
    // 但多问一次没必要 —— 这里顺手存一份）
    this.currentRoom = opts.room;
    this.lastRelayConnected = true; // 能 join 成功基本意味着中继通了
  }

  async send(text: string): Promise<string> {
    return irohNative.send(text);
  }

  async setNickname(name: string): Promise<void> {
    await irohNative.setNickname(name);
  }

  async leaveRoom(): Promise<void> {
    await irohNative.leaveRoom();
  }

  async fetchHistory(limit: number, before?: string | null): Promise<HistoryPage> {
    const room = this.currentRoom;
    if (!room) return { messages: [], before: null };

    // 游标格式 `"<ts>:<id>"`（与 Rust 侧 fetch_history_before 的语义对齐）。
    // 没有游标就传 -1 表示取最新一页。
    let beforeTs = -1;
    let beforeId = '';
    if (before) {
      const idx = before.indexOf(':');
      if (idx > 0) {
        const ts = Number(before.slice(0, idx));
        if (Number.isFinite(ts)) {
          beforeTs = ts;
          beforeId = before.slice(idx + 1);
        }
      }
    }

    const resp = await irohNative.fetchHistory(room, limit, beforeTs, beforeId);
    const messages = (resp.messages ?? []) as ChatMessage[];
    // 下一页的游标：取本页**最早**那条（继续往前翻）
    const earliest = messages.reduce<ChatMessage | null>(
      (acc, m) => (acc == null || m.ts < acc.ts ? m : acc),
      null,
    );
    return {
      messages,
      before: earliest ? `${earliest.ts}:${earliest.id}` : null,
    };
  }

  private currentRoom: string | null = null;

  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---- 文件（v1 未接，保持接口完整）---- */

  async publishFile(_uri: string, _name: string, _size: number, _mime: string): Promise<FileMeta> {
    throw new Error('文件发送将在后续版本开放');
  }

  async acceptFile(_fileId: string, _savePath: string): Promise<void> {
    throw new Error('文件接收将在后续版本开放');
  }

  async rejectFile(fileId: string, reason: string): Promise<void> {
    // 没有文件功能时这是无害的（Rust 侧会忽略未知 fileId）
    void fileId;
    void reason;
  }

  availableFiles(): string[] {
    return [];
  }

  async setAvailableFiles(ids: string[]): Promise<void> {
    void ids;
  }

  async shutdown(): Promise<void> {
    // ① 先停循环：否则 pollEvent 会在 release 之后抛异常
    this.stopped = true;
    if (this.loop) {
      await this.loop.catch(() => undefined);
      this.loop = null;
    }
    // ② 再释放原生句柄
    await irohNative.release();
    this.listeners.clear();
  }
}
