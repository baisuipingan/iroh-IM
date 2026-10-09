/* ============================================================================
 * MockTransport —— 纯 JS 的假实现，用来**先把 UI 写完并跑在真机上**
 *
 * 它不连中继、不发网络，只做三件事：
 *   1. 立刻返回一个假身份 + 假中继状态
 *   2. 进房后吐几条历史消息（覆盖各种气泡形态，方便调样式）
 *   3. 你发的消息立刻回显；**自带一个"假队友"**会回应，好验收到事件后的渲染
 *
 * ⚠️ 它**刻意包含了几种边界数据**，别以为是随便填的：
 *   - 超长无空格文本（测折行）
 *   - emoji + 中文混排（测字宽/对齐）
 *   - 时间跨天的消息（测日期分隔）
 *   - 一条带 file 的「文件证明」消息（测文件卡片，不是文本气泡）
 * ==========================================================================*/

import { PROTOCOL } from './types';
import type {
  ChatMessage,
  EventListener,
  FileMeta,
  RelayStatus,
  Unsubscribe,
} from './types';
import type { HistoryPage, RoomOptions, Transport } from './transport';

const FAKE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** 造一个看起来真实的 ChatMessage */
function msg(
  nickname: string,
  text: string,
  tsOffsetMs: number,
  file?: ChatMessage['file'],
): ChatMessage {
  const ts = Date.now() + tsOffsetMs;
  // id 在真实现里由签名载荷派生；mock 里只要唯一即可
  const id = `m${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    from: `${nickname}00`.padEnd(64, '0').slice(0, 64),
    nickname,
    text,
    ts,
    sig: '0'.repeat(128),
    file: file ?? null,
  };
}

/** 预置的历史消息 —— 覆盖要调的几种样式 */
function seedHistory(room: string, me: string): ChatMessage[] {
  const H = 3600_000;
  return [
    msg('派大星', '海之霸那边又说要涨价了', -22 * H),
    msg('蟹老板', '钱！钱！钱！', -21 * H),
    msg('章鱼哥', '我只想要个安静的一天。', -20 * H),
    msg(
      '珊迪',
      '来，这是我刚整理好的实验数据（表格有点大，直接发文件了）',
      -6 * H,
      {
        file_id: 'f1a2b3c4d5e6f708',
        name: '实验数据-2026Q4.xlsx',
        size: 2_458_112,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        root_hash: 'b3'.repeat(32),
      },
    ),
    msg(me, '收到，我看一下', -5 * H),
    // 测长文本折行：故意没有空格
    msg(
      '派大星',
      '这个是个特别特别长的没有空格的中文句子用来测试自动换行会不会把容器撑破掉如果会那就说明样式有问题需要去修一下',
      -3 * H,
    ),
    // 测 emoji 与中文混排
    msg('蟹老板', '💰💰 今天的营业额 🎉 破纪录了！🐚✨', -2 * H),
    msg('章鱼哥', '哼。', -40 * 60_000),
  ];
}

export class MockTransport implements Transport {
  readonly endpointId = FAKE_ID;

  private listeners = new Set<EventListener>();
  private opts: RoomOptions | null = null;
  private connected = false;
  private files: string[] = [];
  private peerTimer: ReturnType<typeof setInterval> | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;

  /** mock 里"房间里还有别人"，好验证成员列表渲染 */
  private peers = new Map<string, { id: string; nickname: string }>();

  private emit(ev: Parameters<EventListener>[0]): void {
    for (const l of this.listeners) l(ev);
  }

  async online(): Promise<void> {
    // 模拟连接耗时，好让 UI 的"连接中"状态真的被走到
    await new Promise((r) => setTimeout(r, 400));
    this.connected = true;
  }

  relayStatus(): RelayStatus {
    return {
      url: 'https://iroh1.editor.vip:15443',
      connected: this.connected,
      rtt_ms: this.connected ? 58 : null,
    };
  }

  async join(opts: RoomOptions): Promise<void> {
    // ⚠️⚠️ **这里刻意在 await 期间就发事件**（先 sleep 再 emit），
    //      因为真实的 Rust 实现就是这样：`RoomNode::join` 是 await 的，
    //      `joined` / `history` 在它返回之前就通过事件流吐出来了。
    //
    //      第一版 mock 是"join 返回后才 setTimeout 1200ms 发事件"，
    //      把 `useRoom` 里的一个真实竞态 bug 掩盖掉了 —— 真机上表现为
    //      「卡在正在进入房间…」，但成员数已经显示 3。
    //      **mock 必须复刻真实现的时序，否则它是在帮你制造假信心。**
    this.opts = opts;
    this.peers.clear();

    await new Promise((r) => setTimeout(r, 120));
    this.emit({ type: 'joined', room: opts.room });

    await new Promise((r) => setTimeout(r, 180));
    this.emit({
      type: 'history',
      room: opts.room,
      messages: seedHistory(opts.room, opts.nickname),
    });

    // 造几个"房间里的人"，并让成员列表真的有东西可显示
    const others = [
      { id: 'b1'.padEnd(64, '0'), nickname: '派大星' },
      { id: 'c2'.padEnd(64, '0'), nickname: '蟹老板' },
      { id: 'd3'.padEnd(64, '0'), nickname: '章鱼哥' },
      { id: 'e4'.padEnd(64, '0'), nickname: '珊迪' },
    ];
    for (const p of others) this.peers.set(p.id, p);
    this.emitPeerPresence();

    // 20 秒后"有人离开"，用来验证 presence 更新
    this.peerTimer = setTimeout(() => {
      this.peers.delete('d3'.padEnd(64, '0'));
      this.emitPeerPresence();
    }, 20_000);
  }

  private emitPeerPresence(): void {
    if (!this.opts) return;
    const now = Date.now();
    this.emit({
      type: 'presence',
      room: this.opts.room,
      peers: [...this.peers.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        last_seen_ms: now,
        files: [],
        epoch: 1,
      })),
    });
  }

  async send(text: string): Promise<string> {
    if (!this.opts) throw new Error('还没进房');
    const m = msg(this.opts.nickname, text, 0);
    // 真实实现里消息会经由 gossip 回到自己，这里直接回显
    this.emit({ type: 'message', room: this.opts.room, message: m, mine: true });

    // 让"派大星"回一句，验证**收到别人消息**的渲染路径
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = setTimeout(
      () => {
        if (!this.opts) return;
        const replies = ['好嘞', '这个我知道！', '让我想想……', '收到 👌'];
        const pick = replies[Math.floor(Math.random() * replies.length)] ?? '嗯';
        this.emit({
          type: 'message',
          room: this.opts.room,
          message: msg('派大星', pick, 0),
          mine: false,
        });
      },
      1200 + Math.random() * 800,
    );

    return m.id;
  }

  async setNickname(name: string): Promise<void> {
    if (this.opts) this.opts = { ...this.opts, nickname: name };
  }

  async leaveRoom(): Promise<void> {
    if (this.peerTimer) clearTimeout(this.peerTimer);
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.peers.clear();
    this.opts = null;
  }

  async fetchHistory(_limit: number, before?: string | null): Promise<HistoryPage> {
    // 第一页有内容，往前翻就没有了 —— 好验证"到底了"的空态
    if (before) return { messages: [], before: null };
    return { messages: [], before: null };
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publishFile(
    _uri: string,
    name: string,
    size: number,
    mime: string,
  ): Promise<FileMeta> {
    const meta: FileMeta = {
      file_id: Math.random().toString(16).slice(2, 18),
      name,
      size,
      mime,
      chunk_size: 262_144,
      root_hash: 'aa'.repeat(32),
      sender: this.endpointId,
      sender_relay: 'https://iroh1.editor.vip:15443',
      ts: Date.now(),
    };
    this.files.push(meta.file_id);
    return meta;
  }

  async acceptFile(_fileId: string, _savePath: string): Promise<void> {
    // mock：装装样子就宣布完成
    await new Promise((r) => setTimeout(r, 600));
  }

  async rejectFile(fileId: string, reason: string): Promise<void> {
    if (this.opts) {
      this.emit({
        type: 'fileRejected',
        room: this.opts.room,
        // ⚠️ 是 `file_id`（snake_case）—— 与真实 JSON 一致，见 types.ts 顶部说明
        file_id: fileId,
        reason,
        by: this.endpointId,
      });
    }
  }

  availableFiles(): string[] {
    return [...this.files];
  }

  async setAvailableFiles(ids: string[]): Promise<void> {
    this.files = [...ids];
  }

  async shutdown(): Promise<void> {
    await this.leaveRoom();
    this.listeners.clear();
  }
}

/** 协议常量透出（UI 上显示"协议 v4"用） */
export { PROTOCOL };
