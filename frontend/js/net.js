/* ============================================================================
 * net.js · 网络层（Worker 代理版）
 *
 * ## 为什么改成 Worker
 *
 * 实测：Chrome 把**隐藏标签页**的定时器从 20ms 压到 **1000ms**（慢 50 倍），
 * 而 iroh 的 QUIC 栈完全靠 `setTimeout` 驱动 —— 导致"切走就龟速"。
 * Worker 的定时器不受页面可见性影响（实测隐藏 45 秒后仍是 21~30ms），
 * 所以把 iroh（wasm）整个搬进 Worker。
 *
 * ## 本模块的角色
 *
 * **对外 API 完全不变** —— 上层（main.js / UI）感知不到 Worker 的存在。
 * 内部把原来的 wasm 直接调用换成 postMessage RPC。
 *
 * 数据面（文件读写）**不经过这里**：主线程把 `File`/句柄一次性交给 Worker，
 * 之后块的读写都在 Worker 内完成，只回进度百分比。
 *
 * ## 职责边界
 *
 * | 事 | 在哪 |
 * |---|---|
 * | `showSaveFilePicker`（要用户手势） | 主线程 |
 * | `File` / 句柄的持有与读写 | **Worker** |
 * | blake3 哈希、invite、传数据 | **Worker** |
 * | IndexedDB 断点位图 | **Worker** |
 * | DOM / 卡片 / 按钮 | 主线程 |
 * ==========================================================================*/

import { loadRelayConfig, probeAll } from './probe.js';
import { bus, EV } from './bus.js';
import { store } from './store.js';
import { withTimeout } from './util.js';

/**
 * wasm 构建号：**每次重新构建 wasm 都必须 +1**。
 * 浏览器按 `iroh_web_bg.wasm?b=<BUILD>` 缓存，不 bump 会加载到旧 wasm。
 */
const BUILD = 'v10';
const ONLINE_TIMEOUT = 15000;
/** 重连退避：1s → 2s → 4s … 封顶 30s */
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

/* ---------------------------------------------------------------------------
 * Worker RPC 客户端
 * ------------------------------------------------------------------------ */

class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    /** 事件订阅者（扇出，避免多个消费者互相抢） */
    this.subs = new Set();

    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'rpc:reply') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        return;
      }
      // 其它都是主动推送（wasm 事件 / 传输进度）
      for (const fn of this.subs) {
        try {
          fn(m);
        } catch (err) {
          console.warn('[net] 推送处理异常', err, m);
        }
      }
    };
    this.worker.onerror = (e) => {
      console.error('[net] Worker 错误', e.message, e.filename, e.lineno);
      bus.emit(EV.TIP, `后台线程出错：${e.message}`);
    };
  }

  /** 订阅 Worker 的主动推送 */
  onMessage(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  call(method, ...args) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'rpc', id, method, args });
    });
  }

  post(msg) {
    this.worker.postMessage(msg);
  }
}

/* ---------------------------------------------------------------------------
 * 公开 API（与改造前保持一致）
 * ------------------------------------------------------------------------ */

export const net = {
  /** 供少数需要直接调用的场景（设置页读中继状态等） */
  client: null,
  config: null,
  probes: [],
  /** 探测中（区别于"探测完了但全挂"） */
  probing: false,
  ready: false,
  endpointId: '',
  /** 'starting' | 'online' | 'offline' | 'reconnecting' —— 供 UI 显示真实状态 */
  phase: 'starting',
  /** 正在重连的定时器句柄 */
  _retryTimer: null,
  _retryIdx: 0,
  /** 上一次 join 成功的房间，重连成功后要自动回去 */
  _room: '',
  _nick: '',
  /**
   * 进房**代次**（报告 P1-8）。
   *
   * 每次进房 ++，操作完成时检查自己是否还是最新代次。
   * 旧的慢操作会被识别出来并**主动追回**最终房间，
   * 避免"界面显示 B、底层实际在 A"这种错位。
   */
  _joinGen: 0,
  /**
   * **用户意图**要进的房间。
   *
   * 与 `_room`（上次成功 join 的房间）的区别很关键：离线时用户点房间，
   * `openRoom` 会因为 `net.canSend` 为 false 而提前 return，
   * **不会**走到 `joinRoom`，于是 `_room` 不更新 —— 但用户明明想进那间。
   * 断线恢复时以本字段为准，才能"进到用户想要的那间"。
   */
  _desiredRoom: '',

  /**
   * 在飞的 `join`（单飞用）：`{ room, promise }` 或 null。
   *
   * 同一个房间的 join 只能有一条在飞 —— 两条并发 join 会在 Rust 侧
   * 互相 `g.joined = None` 拆掉对方的 gossip 订阅，双双报
   * "连接常驻节点超时"（见 `joinRoom` 的说明）。
   */
  _inflightJoin: null,

  /** 供 UI 查询：能不能发消息 */
  get canSend() {
    return this.ready && this.phase === 'online';
  },

  async start() {
    this.config = await loadRelayConfig('../relay-config.json');
    if (!this.config) throw new Error('中继名单加载失败');

    const url = new URL('./iroh-worker.js', import.meta.url).href;
    this.client = new WorkerClient(url);

    // 事件扇出：把 Worker 推来的东西分发给不同消费者
    this.client.onMessage((m) => {
      if (m.type === 'event') {
        this._dispatch(m.payload);
      } else if (m.type === 'transfer:error') {
        bus.emit(EV.TIP, `传输出错：${m.payload.error}`);
      }
      // 其余 `transfer:*` 由 filetransfer 模块自行订阅
    });

    // 身份来源（仅影响开发/测试，生产走持久化的 store.identity()）：
    //   `?testid=1`   → 每次加载都用**随机**身份（让同一浏览器的多个标签页被当成"不同的人"）
    //   `?key=<hex>`  → 用**指定**身份（自动化测试要在刷新后保持同一身份时必需；
    //                   `testid=1` 做不到，因为它每次都会重新随机，
    //                   刷新后 owner 对不上，持久化恢复就失效了）
    const qs = new URLSearchParams(location.search);
    const fixedKey = qs.get('key');
    const secretKeyHex = /^[0-9a-f]{64}$/i.test(fixedKey || '')
      ? fixedKey
      : qs.has('testid')
        ? Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : store.identity();

    // ⚠️ 必须在这里过滤 `enabled: false`。
    //    原来直接把全部 url 丢给 Rust，而 **Rust 侧根本没有 enabled 这个概念** ——
    //    于是配置里把某台标成 `false` 只影响「延迟探测」的显示，
    //    实际连接时它照样是候选、照样可能被选成 home relay。
    //    一个看起来像开关、实际不生效的字段比没有更糟。
    //    （`probe.js` 的 probeAll 一直是按 `enabled !== false` 过滤的，这里对齐它。）
    const usableRelays = this.config.relays.filter((r) => r.enabled !== false);
    if (!usableRelays.length) {
      throw new Error('relay-config.json 里所有中继都被禁用了（enabled: false），至少留一台');
    }

    this.client.post({
      type: 'boot',
      cfg: {
        baseUrl: new URL('../', import.meta.url).href,
        build: BUILD,
        relays: usableRelays.map((r) => r.url),
        relayToken: this.config.relay_token ?? null,
        secretKeyHex,
        anchorId: this.config.anchor?.id ?? null,
        anchorRelay: this.config.anchor?.relay ?? null,
      },
    });

    // 等启动结果（成功或失败都从这条消息来）
    this.endpointId = await new Promise((resolve, reject) => {
      const off = this.client.onMessage((m) => {
        if (m.type === 'booted') {
          off();
          resolve(m.payload.endpointId);
        } else if (m.type === 'boot:error') {
          off();
          reject(new Error(m.payload.error));
        }
      });
    });

    // 监听浏览器网络恢复：网络回来立刻重试一次，不用等退避计时器
    addEventListener('online', () => {
      if (this.phase !== 'online') this._retryNow();
    });

    await this._goOnline();
    bus.emit(EV.READY, this.ready);
    this.probe().catch(() => {});
    return this.ready;
  },

  /** 尝试连上中继；成功则进入 online，失败则安排重连 */
  async _goOnline() {
    try {
      this.phase = 'starting';
      bus.emit(EV.NODE_STATE, { ok: false, text: '连接中继…', waiting: true });
      await withTimeout(this.client.call('online'), ONLINE_TIMEOUT, '连接中继');
      this.ready = true;
      this.phase = 'online';
      this._retryIdx = 0;
      bus.emit(EV.NODE_STATE, { ok: true, text: '在线' });
      // 掉线重连后要自己回到刚才那个房间，否则用户发现"消息全没了"。
      //
      // ⚠️ 两个都必须照顾到（报告 P1-8 + offline-room 回归）：
      //
      //  1. **不能**先 emit(NODE_STATE) 再 join —— 主线程收到"在线"后
      //     会立刻为 pendingRoom 发起自己的 join，两者交错就可能让
      //     底层停在旧房间而界面显示新房间。
      //  2. 但**也必须**让用户离线期间点的房间赢。那个点击走的是
      //     `openRoom`，因为 `net.canSend` 为 false 而提前 return，
      //     **根本没进 `joinRoom`**，所以 `this._room` 还停在旧房间。
      //     这里如果只认 `this._room`，用户醒来就会发现自己被拽回了旧房间。
      //
      // 所以：`_desiredRoom` 记录**用户意图**（离线时点房间也会写），
      // 恢复时以它为准；它没被设过才退回 `_room`（上次成功进过的）。
      const wantRoom = this._desiredRoom || this._room;
      if (wantRoom) {
        // ⚠️ 重进**必须走 `joinRoom`**（唯一入口）。它自带：
        //    · 单飞：与主线程的 openRoom 撞上时只发一条 join（否则两边互相拆订阅）
        //    · 代次与 superseded 语义：被更新的操作取代时不写 `_room`、不发 REJOINED
        //    （缺陷 F12：原来这里自己发 join，补偿分支还是不可能执行到的死代码。）
        const wantNick = this._nick;
        try {
          await this.joinRoom(wantRoom, wantNick);
          // 事件带**这次操作的 room 快照**，不是可变的 this._room
          bus.emit(EV.REJOINED, wantRoom);
        } catch (e) {
          // 被更新的操作取代：不是失败，别报错、也别重试（那会跟新操作抢）
          if (e?.superseded) {
            console.debug('[net] 重连恢复被更新的进房操作取代，放弃本次结果', wantRoom);
            return;
          }
          // ⚠️ 重进失败不能只弹一句提示就完事：`main.js` 在断线时把
          //    `pendingRoom` 交给了网络层（判定 netWillHandle），这里若不再重试，
          //    就再也没有人去进那个房间，界面会永久停在"有房间名但不是成员"的状态。
          bus.emit(EV.TIP, `重连后重新进入房间失败：${e?.message ?? e}`);
          this._scheduleRetry();
        }
      }
    } catch (e) {
      this.ready = false;
      this.phase = 'reconnecting';
      bus.emit(EV.NODE_STATE, { ok: false, text: '连接中继失败，重试中' });
      bus.emit(EV.TIP, e.message);
      this._scheduleRetry();
    }
  },

  _scheduleRetry() {
    if (this._retryTimer) return;
    const delay = BACKOFF[Math.min(this._retryIdx, BACKOFF.length - 1)];
    this._retryIdx++;
    bus.emit(EV.NODE_STATE, {
      ok: false,
      text: `连接中继失败，${Math.round(delay / 1000)}s 后重试`,
    });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._goOnline();
    }, delay);
  },

  /** 立刻重试一次（浏览器报告网络恢复 / 用户手动点重连） */
  _retryNow() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryIdx = 0;
    this._goOnline();
  },

  /** 供 UI 调用的手动重连 */
  reconnect() {
    this._retryIdx = 0;
    this._retryNow();
  },

  /** wasm 事件 → 总线事件（翻译逻辑与原版一致，放在主线程便于调试） */
  _dispatch(ev) {
    switch (ev.type) {
      case 'relayStatus': {
        // 顺手存一份快照：`relayStatus()` 是**同步**接口（UI 渲染时直接读），
        // 而状态是异步推来的。不缓存的话设置页永远显示"未连接"。
        this._relayJson = JSON.stringify(ev.relays || []);
        bus.emit(EV.RELAYS, ev.relays);
        if (!this.ready) break;   // 还没上线成功，交给 _goOnline 管
        const n = ev.relays.filter((r) => r.connected).length;
        if (n > 0) {
          // 恢复了：清掉重连计划，把 phase 拉回在线
          if (this.phase !== 'online') {
            this.phase = 'online';
            this.ready = true;
            this._retryIdx = 0;
            if (this._retryTimer) {
              clearTimeout(this._retryTimer);
              this._retryTimer = null;
            }
          }
          bus.emit(EV.NODE_STATE, { ok: true, text: '在线' });
        } else {
          // ⚠️ 之前这里只改了个"离线"文案，`ready` 仍为 true：
          //    于是 UI 一切正常、输入框可打、点发送才失败，且永远不会自愈。
          //    现在进入真实的重连状态。
          this.ready = false;
          this.phase = 'reconnecting';
          bus.emit(EV.NODE_STATE, { ok: false, text: '中继已断开，正在重连' });
          this._scheduleRetry();
        }
        break;
      }
      case 'message':
        bus.emit(EV.MSG, { room: ev.room, message: ev.message, mine: ev.mine, isHistory: false });
        break;
      case 'presence':
        bus.emit(EV.PRESENCE, { room: ev.room, peers: ev.peers });
        break;
      // ⚠️ 这两个 Rust 侧**真的在发**（room.rs 里 NeighborUp/NeighborDown → PeerUp/PeerDown），
      //    但之前这里没有 case，全部掉进 `default: break` 被静默丢弃 ——
      //    于是"谁上线了/掉线了"这个信息在 UI 上完全不存在，
      //    联系人状态只能靠 presence 快照（而 presence 只在变化时才推）。
      //    修好后联系人列表的在线状态才是活的。
      case 'peerUp':
        bus.emit(EV.PEER_UP, { id: ev.id });
        break;
      case 'peerDown':
        bus.emit(EV.PEER_DOWN, { id: ev.id });
        break;
      // ⚠️ Worker 的 wasm 事件流断了（复检 P3-10）：**入站通道整体失效** ——
      //    再也收不到消息/心跳/邀约，但发送仍然可用、状态还显示"在线"。
      //    这种"静默半死"必须让用户看见，并主动重连（重连会重建节点与事件流）。
      case 'node:degraded': {
        this.ready = false;
        this.phase = 'reconnecting';
        bus.emit(EV.NODE_STATE, { ok: false, text: '连接已中断，正在重连' });
        bus.emit(EV.TIP, `与中继的连接已中断（${ev.reason || '事件流结束'}），正在重连`);
        this._scheduleRetry();
        break;
      }
      case 'fileInvite':
        bus.emit(EV.FILE_INVITE, { room: ev.room, meta: ev.meta });
        break;
      // 注意：Rust 的 `#[serde(rename_all = "camelCase")]` 对**枚举变体字段**不生效，
      // 实际是 snake_case（`file_id` / `receiver_relay`）。两种拼法都读。
      // ⚠️ 三种控制事件都必须带上 `room`：它们是**广播**消息，
      //    可能来自用户当前没在看的房间。UI 侧会丢弃 room 对不上的事件，
      //    否则 B 房间的控制流会去改 A 房间的卡片状态（F7）。
      case 'fileAccepted':
        bus.emit(EV.FILE_ACCEPTED, {
          room: ev.room,
          file_id: ev.file_id ?? ev.fileId,
          have: ev.have,
          receiver_relay: ev.receiver_relay ?? ev.receiverRelay,
          by: ev.by,
        });
        break;
      case 'fileRejected':
        bus.emit(EV.FILE_REJECTED, {
          room: ev.room,
          file_id: ev.file_id ?? ev.fileId,
          reason: ev.reason,
          // 谁拒的。多接收方时发送端靠它只标那一条通道，不牵连其他人。
          by: ev.by,
        });
        break;
      case 'fileDone':
        bus.emit(EV.FILE_DONE, {
          room: ev.room,
          file_id: ev.file_id ?? ev.fileId,
          ok: ev.ok,
          reason: ev.reason,
        });
        break;
      case 'error':
        bus.emit(EV.TIP, ev.message);
        break;
      default:
        break;
    }
  },

  /* ---------- 节点 id ---------- */

  endpoint_id() {
    return this.endpointId;
  },

  /* ---------- 房间 ---------- */

  /**
   * 进入房间。**所有**进房请求（含断线重连）都必须走这里。
   *
   * ## 代次机制（报告 P1-8）
   *
   * 以前有两个各自独立的进房发起方：用户点房间（`joinRoom`）和
   * `_goOnline` 里的断线重连。它们没有共享锁，于是能交错：
   *
   * ```text
   * 断线 → 用户点 B（发起 B）→ _goOnline 自动重进旧房间 A（发起 A）
   *      → B 先完成、A 后完成 → 底层实际在 A，界面显示 B，发送也标成 B
   * ```
   *
   * 结果是**界面与实际房间不一致**：看起来在 B，消息却广播去了 A。
   *
   * 现在每次进房领一个**递增代次**：
   *  - 发起时 `++gen`，把代次记在这次操作上
   *  - 完成后检查"我的代次是不是最新的"，不是就**放弃这次结果**
   *    （但底层已经切过去了，所以要再 corrective 一次，见下）
   *  - `_goOnline` 发出自动重进**之后**才 emit 事件，让上层也能参与竞争
   *
   * 关键点：**事件里带的 room 是这次操作不可变的快照**，
   * 不是可变的 `this._room`（原来读的是后者，操作结束时的值）。
   */
  async joinRoom(room, nickname) {
    if (!this.ready) throw new Error('还没连上中继');

    // ═══════════════════════════════════════════════════════════════
    // ⚠️ **单飞**：同一个房间已经有 join 在飞，就直接复用那一条。
    //
    // 为什么必须有：主线程的 `openRoom`（autostart / 点会话）与网络层的
    // 自动重进（`_goOnline`）会各自发一次 `join`。而 Rust 侧的 `join` 开头是
    // `g.joined = None`（丢掉上一个 Joined 会 abort 掉它的 gossip 任务）——
    // 两次并发 join 于是**互相拆掉对方的订阅**，两边都连不上常驻节点，
    // 报 "连接常驻节点超时"（实测：浏览器里带着 localStorage 的旧房间启动时复现，
    // 清掉存储就正常；`refresh-test` 的 R2 就是这样卡住的）。
    //
    // 单飞之后，同房间的第二次调用只是**等**第一次的结果，不会再发一条 join。
    // ═══════════════════════════════════════════════════════════════
    if (this._inflightJoin && this._inflightJoin.room === room) {
      return this._inflightJoin.promise;
    }

    const myGen = ++this._joinGen;
    const run = this._joinRoomOnce(room, nickname, myGen);
    this._inflightJoin = { room, promise: run };
    try {
      return await run;
    } finally {
      if (this._inflightJoin && this._inflightJoin.promise === run) {
        this._inflightJoin = null;
      }
    }
  },

  /** `joinRoom` 的真正实现（由单飞包装调用，不要直接调它）。 */
  async _joinRoomOnce(room, nickname, myGen) {
    // ⚠️ 换房间时：**先广播"我离开了"，再进新房间**。
    //
    // 这是整套设计里唯一一个"离开声明"能**可靠**发出去的时机 ——
    // 页面还活着、连接还在、有充足时间完成"序列化 → 签名 → QUIC 写 → 中继转发"。
    // 收到的人会立刻把我们摘出成员表（我们的文件也随之变过期），
    // 不用等 25~45 秒的心跳超时。
    //
    // 刷新/关页/崩溃走不到这里（页面直接被销毁），那些场景靠心跳超时兜底 ——
    // 这也正是"不把离开声明当事实来源"的原因。
    //
    // 失败不影响流程（尽力而为）：真发不出去，对方也会在超时后自己发现。
    if (this._room && this._room !== room) {
      try {
        await this.client.call('leaveRoom');
      } catch {
        /* 尽力而为 */
      }
    }
    this._room = room; // 记下来，断线重连后要自动回到这个房间
    this._nick = nickname;
    await this.client.call('join', room, nickname);

    // ⚠️ 慢的 join 会被别人抢先：底层已经切到别的房间了，
    //    这里必须**追回**最终状态（否则界面停在错的房间）。
    if (myGen !== this._joinGen) {
      const winner = this._room;
      if (winner && winner !== room) {
        await this.client.call('join', winner, this._nick).catch(() => {});
      }
      const e = new Error(`进房被更新的操作取代（当前房间：${winner || '（无）'}）`);
      e.superseded = true;
      e.room = winner;
      throw e;
    }
    return room;
  },

  /**
   * 记下**用户想去哪间房**（断线恢复时以它为准）。
   *
   * 必须在"离线点房间"那条路径上也调用 —— 那时候不会走到 `joinRoom`，
   * `_room` 不更新，但用户意图是明确的。
   */
  noteDesiredRoom(room) {
    if (room) this._desiredRoom = room;
  },

  /** 用户当前想去的房间（可能还没进去）。主线程用它判断"是否已有人负责恢复"。 */
  desiredRoom() {
    return this._desiredRoom || '';
  },

  /**
   * 本端是否**记得**任何房间（意图房间或上次进过的）。
   *
   * 刷新是全新页面 —— 两个都空，`_goOnline` 不会自己恢复任何房间，
   * 主线程必须自己 `openRoom`。缺了这个判据，两边都会撒手（踩过）。
   */
  hasRoomContext() {
    return !!(this._desiredRoom || this._room);
  },

  setNickname(name) {
    this._nick = name;
    this.client.call('setNickname', name).catch(() => {});
  },

  async send(text) {
    // ⚠️ 离线时不要把请求丢进黑洞：直接抛一个可读的错误，
    //    让 UI 走"发送失败 + 保留输入"的分支，而不是卡住不动。
    if (!this.canSend) throw new Error(this.phase === 'online' ? '还没进入房间' : '网络未连接');
    return JSON.parse(await this.client.call('send', text));
  },

  /**
   * 拉历史。返回**消息数组**（文件证明也在里面，形如 `m.file = {...}`）。
   *
   * ⚠️ Rust 侧现在返回的是 `{room, messages, snapshot}`：
   * `snapshot` 是房间快照（成员表 + 各自能提供的文件），
   * **已经在 wasm 里并进成员表了**，这里只取消息。
   *
   * `before` 是**复合游标** `"<ts>:<id>"`（上一页最后一条消息拼出来的），
   * 空串表示取最新 `limit` 条。
   *
   * ⚠️ 不要退回"只传毫秒时间戳"：时间戳只到毫秒，同一毫秒的多条消息
   * 会正好落在游标边界上被整体跳过 —— 那些消息**永远取不到**。
   * 游标字符串见 util.js 的 `cursorOf()`。
   */
  async history(room, limit, before = '') {
    if (!this.client) return [];
    const raw = await this.client.call('history', room, limit, before);
    const resp = JSON.parse(raw);
    const msgs = Array.isArray(resp) ? resp : resp.messages || [];
    // 排序也用 (ts, id)：同一毫秒的消息要有确定次序，否则前端算游标会不稳。
    return msgs.sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  },

  /** 同步"我此刻还能发出的文件"清单（去重、上限都在 Worker 里做） */
  setAvailableFiles(ids) {
    if (!this.client) return;
    this.client.call('setAvailableFiles', ids).catch(() => {});
  },

  /**
   * 广播一条**可用性质询**：我点了某张卡但联系不上发送方，公开问一句。
   * 他若还持有该文件会重播心跳认领；**沉默即视为过期**。
   */
  /**
   * 广播"你还能提供这个文件吗"。
   *
   * ⚠️ `room` 必填：质询只能发进**卡片所属的那个房间**（F7）。
   *    这里原来只有两个参数，`args[2]` 会是 undefined，
   *    Rust 侧的房间校验必然失败（而且错误信息里会出现 "undefined"）。
   */
  async queryFile(fileId, want, room) {
    if (!this.client) return;
    await this.client.call('queryFile', fileId, want, room);
  },


  relayStatus() {
    try {
      return JSON.parse(this._relayJson || '[]');
    } catch {
      return [];
    }
  },

  /** 中继状态是异步推来的，这里保留最近一次快照 */
  async refreshRelayStatus() {
    try {
      this._relayJson = await this.client.call('relayStatus');
    } catch {
      this._relayJson = '[]';
    }
    return this.relayStatus();
  },

  async probe() {
    // probing 单独一个标志：之前只有 `probes` 数组，探测失败时它一直是空数组，
    // UI 就会永远显示"正在探测…"，分不清"还在探"和"探完挂了"。
    this.probing = true;
    try {
      this.probes = await probeAll(this.config.relays, { samples: 3, timeoutMs: 2500 });
      return this.probes;
    } finally {
      this.probing = false;
    }
  },
};
