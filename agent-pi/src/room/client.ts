/* ============================================================================
 * client.ts · iroh-agent serve 进程客户端（行协议 + 进程生命周期）
 *
 * 职责边界（别越界）：
 *   - 只管一件事：把 `iroh-agent serve` 子进程的 stdout/stdin 变成
 *     「request/reply + 事件流」的 JS API
 *   - 不解析业务语义：message 怎么触发回复、历史怎么进模型，都在 adapter/brain
 *   - 崩溃恢复：非主动退出 → 指数退避重启（serve 的 `--room` 会自动重新进房）；
 *     重启期间所有请求快速失败（`processExited`）
 *
 * ⚠️ stdout 是协议流：这里解析失败的行走日志丢弃，**绝不**把它当数据用。
 *    真正的日志在 stderr（原样转到 log 回调）。
 * ==========================================================================*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { AgentError, CHAT_PROTOCOL, IPC_VERSION } from './protocol.ts';
import type { Frame, HelloFrame, ReplyFrame, RoomEvent } from './protocol.ts';

export interface AgentClientOptions {
  /** iroh-agent 二进制（PATH 里的名字或绝对路径） */
  bin: string;
  /** 附加在 `serve` 之后的参数（如 ['--room','X','--nick','Y']） */
  args?: string[];
  /** 传给子进程的环境变量（覆盖继承值） */
  env?: Record<string, string | undefined>;
  /** 命令默认超时（慢命令在调用处单独覆盖） */
  requestTimeoutMs?: number;
  /** ping 看门狗间隔；连续两次失败就 SIGKILL 走重启流程。0 = 关（默认 45000） */
  pingIntervalMs?: number;
  /**
   * **连接看门狗**：进房后若超过这么久收不到任何房间事件（presence 心跳约 15s 一次），
   * 判定"进程活着、连接已死"（典型：笔记本睡一晚，gossip/中继连接没恢复 —— 实测踩到），
   * SIGKILL 子进程走重启流程（重启会重新进房、重连）。0 = 关（默认 120000）。
   * ⚠️ ping 看门狗只看**本地进程**活不活，这条才看**连接**活不活 —— 两者互补。
   */
  staleRestartMs?: number;
  /** 重启退避（默认 1s→2s→4s…封顶 30s） */
  restartBackoffMs?: number[];
  log?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelloWaiter {
  child: ChildProcessWithoutNullStreams;
  resolve: (hello: HelloFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentClient extends EventEmitter {
  #opts: AgentClientOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<string, Pending>();
  #helloWaiters: HelloWaiter[] = [];
  #seq = 0;
  #helloFrame: HelloFrame | null = null;
  /** 子进程是否已经退出（`#onClose` 置位）——退出流程靠它跳过"白等 close" */
  #childExited = true;
  /** 最近一次收到任何房间事件的时间（连接看门狗的"心跳"） */
  #lastRoomEventAt = 0;
  /** 是否见过 joined 事件（没进房之前不做连接看门狗判定） */
  #joinedSeen = false;
  /** 最近一次 relayStatus 里"至少一台中继连着"；null = 还没收到过 */
  #relaysConnected: boolean | null = null;
  #staleTimer: ReturnType<typeof setInterval> | null = null;
  #stopping = false;
  #restarts = 0;
  /** 同一时刻只能有一个自动重启循环，避免多个 serve 同时持有同一身份。 */
  #restartLoopRunning = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pingFailures = 0;
  #log: (line: string) => void;

  constructor(opts: AgentClientOptions) {
    super();
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  get hello(): HelloFrame | null {
    return this.#helloFrame;
  }

  get running(): boolean {
    return this.#child !== null && this.#helloFrame !== null;
  }

  /** 启动并等到 hello（含连中继，最多 60s）。协议不匹配会直接抛错。 */
  async start(): Promise<HelloFrame> {
    this.#stopping = false;
    const child = this.#spawn();
    let hello: HelloFrame;
    try {
      hello = await this.#waitHello(child, 60_000);
    } catch (error) {
      if (this.#child === child && !this.#childExited) {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'close'), sleep(2_000)]);
      }
      throw error;
    }
    // ⚠️ 聊天协议版本不匹配必须拒绝：跨版本互认的结果是验签失败、消息静默丢失。
    if (hello.chatProtocol !== CHAT_PROTOCOL) {
      throw new AgentError(
        'protocolMismatch',
        `agent 报告 chatProtocol=${hello.chatProtocol}，适配器只支持 ${CHAT_PROTOCOL}；请同步升级（见 docs/deploy.md）`,
      );
    }
    if (hello.v !== IPC_VERSION) {
      throw new AgentError('protocolMismatch', `线协议 v${hello.v} != v${IPC_VERSION}`);
    }
    this.#startWatchdog();
    this.#startStaleWatchdog();
    return hello;
  }

  /** 发一条命令并等它的 reply（每个命令恰好一个 reply；慢命令自己传 timeoutMs）。 */
  request(cmd: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const child = this.#child;
    if (!child || !this.#helloFrame) {
      return Promise.reject(new AgentError('notRunning', 'agent 进程未就绪'));
    }
    const id = String(++this.#seq);
    const line = JSON.stringify({ v: IPC_VERSION, id, cmd, ...params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(
            new AgentError(
              'timeout',
              `${cmd} 超过 ${timeoutMs ?? this.#opts.requestTimeoutMs ?? 120_000}ms 未回复`,
            ),
          );
        },
        timeoutMs ?? this.#opts.requestTimeoutMs ?? 120_000,
      );
      this.#pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${line}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /**
   * 发言（自动签名）。
   *
   * `mentions`：这条消息 @ 的**端点 id 列表**（V6 起结构化寻址就靠它；
   * 文本里的 `@<id8>` 只是渲染锚点）。不传 = 没有 @ 任何人。
   */
  say(text: string, mentions?: string[]): Promise<{ id: string; ts: number }> {
    const body = mentions?.length ? { text, mentions } : { text };
    return this.request('say', body, 60_000) as Promise<{ id: string; ts: number }>;
  }

  /**
   * 接收一个文件（`fileId` 从 `fileInvite` 事件拿）。
   * `savePath` 省略时落在 `<IROH_AGENT_HOME>/received/`；是目录则拼文件名。
   * 超时给到 10 分钟：传输本身可能很久，别把它当命令超时杀掉。
   */
  acceptFile(
    fileId: string,
    savePath?: string,
  ): Promise<{ fileId: string; path: string; bytes: number }> {
    return this.request(
      'accept_file',
      savePath ? { fileId, savePath } : { fileId },
      10 * 60_000,
    ) as Promise<{
      fileId: string;
      path: string;
      bytes: number;
    }>;
  }

  /** 拒绝一个文件（会广播带理由的 Reject；对方能看到"是谁拒绝的"）。 */
  rejectFile(fileId: string, reason?: string): Promise<unknown> {
    return this.request('reject_file', reason ? { fileId, reason } : { fileId }, 30_000);
  }

  history(limit = 200, before?: string): Promise<unknown> {
    return this.request('history', before ? { limit, before } : { limit }, 60_000);
  }

  status(): Promise<unknown> {
    return this.request('status', {}, 30_000);
  }

  ping(): Promise<unknown> {
    return this.request('ping', {}, 10_000);
  }

  /** 优雅停止：shutdown → 等退出 → 兜底 SIGKILL。幂等。 */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopWatchdog();
    const child = this.#child;
    if (!child) return;
    // ⚠️ 子进程可能**早就退出了**：Ctrl-C 会发给整个进程组，`iroh-agent serve`
    //    常常比我们先退。此时 `once(child,'close')` 永远不会再触发 —— 旧代码会
    //    白等满 5s、再 SIGKILL、再等 2s，退出要 ~7 秒（用户实测："后台怎么退出这么慢"）。
    if (!this.#childExited) {
      try {
        await this.request('shutdown', { reason: 'adapter stopping' }, 5_000);
      } catch {
        // 已经死了/超时：继续走退出确认
      }
      // ⚠️ 这里必须**同步**检查 + 注册监听（JS 单线程：中间不会有事件插进来），
      //    否则 request 等待期间子进程退出后，又会掉进"等一个不会再来的 close"。
      if (!this.#childExited) {
        const closed = await Promise.race([
          once(child, 'close').then(() => true),
          sleep(5_000).then(() => false),
        ]);
        if (!closed) {
          this.#log('[client] agent 进程 5s 未退出，SIGKILL');
          child.kill('SIGKILL');
          await Promise.race([once(child, 'close'), sleep(2_000)]);
        }
      }
    }
    this.#failPending(new AgentError('stopped', '客户端已停止'));
  }

  // ------------------------------------------------------------------ 内部

  #spawn(): ChildProcessWithoutNullStreams {
    if (this.#child && !this.#childExited) {
      throw new AgentError('alreadyRunning', '已有 agent 子进程在运行，拒绝重复启动');
    }
    const args = ['serve', ...(this.#opts.args ?? [])];
    this.#log(`[client] 启动：${this.#opts.bin} ${args.join(' ')}`);
    const child = spawn(this.#opts.bin, args, {
      env: { ...process.env, ...this.#opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#helloFrame = null;
    this.#childExited = false;
    this.#joinedSeen = false;
    this.#lastRoomEventAt = Date.now();

    createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(child, line));
    createInterface({ input: child.stderr }).on('line', (line) => this.#log(`[agent] ${line}`));

    child.on('error', (error) => {
      this.#log(`[client] 进程错误：${error.message}`);
      this.#rejectHello(child, new AgentError('spawnFailed', error.message));
    });
    child.on('close', (code, signal) => this.#onClose(child, code, signal));
    return child;
  }

  #onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    // 一个旧子进程的管道可能在新子进程启动后才关闭。它的任何协议帧都必须丢弃，
    // 否则旧 hello/reply 会污染当前子进程的状态。
    if (child !== this.#child) return;
    const text = line.trim();
    if (!text) return;
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      // stdout 只该跑协议；解析失败说明混进了日志（serve 的 bug）——记下来但别当数据用
      this.#log(`[client] 非协议行（已丢弃）：${text.slice(0, 200)}`);
      return;
    }
    switch (frame.type) {
      case 'hello':
        this.#helloFrame = frame;
        this.#resolveHello(child, frame);
        this.emit('hello', frame);
        break;
      case 'reply':
        this.#onReply(frame);
        break;
      case 'event': {
        const event = frame.event as RoomEvent;
        this.#noteEvent(event);
        this.emit('event', event);
        break;
      }
      default:
        this.#log(`[client] 未知帧类型：${JSON.stringify(frame).slice(0, 200)}`);
    }
  }

  #onReply(frame: ReplyFrame): void {
    if (frame.id == null) {
      this.#log(`[client] 无 id 的 reply（已丢弃）：${frame.error?.code ?? ''}`);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      this.#log(`[client] 未知 reply id=${frame.id}（已丢弃）`);
      return;
    }
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.value);
    else
      pending.reject(new AgentError(frame.error?.code ?? 'internal', frame.error?.message ?? ''));
  }

  #onClose(child: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    // 旧子进程的 close 不能清空新子进程的引用，也不能再开一条重启循环。
    if (child !== this.#child) {
      this.#log(`[client] 忽略旧 agent 子进程退出（code=${code} signal=${signal}）`);
      return;
    }
    const wasRunning = this.#helloFrame !== null;
    this.#log(`[client] agent 进程退出（code=${code} signal=${signal}）`);
    this.#childExited = true;
    this.#child = null;
    this.#helloFrame = null;
    this.#stopWatchdog();
    this.#failPending(new AgentError('processExited', 'agent 进程已退出'));
    this.#rejectHello(child, new AgentError('processExited', 'agent 进程已退出'));
    this.emit('exit', { code, signal });
    if (!this.#stopping && wasRunning) this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (this.#restartLoopRunning || this.#stopping) return;
    this.#restartLoopRunning = true;
    void this.#restartLoop().finally(() => {
      this.#restartLoopRunning = false;
    });
  }

  async #restartLoop(): Promise<void> {
    try {
      while (!this.#stopping) {
        const backoff = this.#opts.restartBackoffMs ?? DEFAULT_BACKOFF;
        const wait = backoff[Math.min(this.#restarts, backoff.length - 1)];
        this.#restarts += 1;
        this.#log(`[client] ${wait}ms 后重启（第 ${this.#restarts} 次）`);
        await sleep(wait);
        if (this.#stopping) return;
        let child: ChildProcessWithoutNullStreams;
        try {
          child = this.#spawn();
        } catch (error) {
          this.#log(`[client] 重启前发现已有 agent 子进程：${(error as Error).message}`);
          await sleep(wait);
          continue;
        }
        try {
          const hello = await this.#waitHello(child, 60_000);
          this.#log(`[client] 已重启并重新握手：endpointId=${hello.endpointId}`);
          this.#restarts = 0;
          // #onClose 会先停掉看门狗；重启成功后必须完整恢复，否则第一次
          // 自动重连之后就失去“睡醒后自愈”的能力。
          this.#startWatchdog();
          this.#startStaleWatchdog();
          this.emit('restarted', hello);
          return;
        } catch (error) {
          this.#log(`[client] 重启失败：${(error as Error).message}`);
          // 握手超时不能把一个没有协议输出的旧 serve 留在后台；否则下一轮
          // restart 会和它共用 identity.key，relay 看到的就是 same endpoint id。
          if (this.#child === child && !this.#childExited) {
            child.kill('SIGKILL');
            await Promise.race([once(child, 'close'), sleep(2_000)]);
          }
        }
      }
    } finally {
      this.#restartLoopRunning = false;
    }
  }

  #waitHello(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<HelloFrame> {
    if (this.#child === child && this.#helloFrame) return Promise.resolve(this.#helloFrame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#helloWaiters = this.#helloWaiters.filter((w) => w.timer !== timer);
        reject(new AgentError('helloTimeout', `${timeoutMs}ms 内没有收到 hello`));
      }, timeoutMs);
      this.#helloWaiters.push({ child, resolve, reject, timer });
    });
  }

  #resolveHello(child: ChildProcessWithoutNullStreams, hello: HelloFrame): void {
    const waiters = this.#helloWaiters.filter((w) => w.child === child);
    this.#helloWaiters = this.#helloWaiters.filter((w) => w.child !== child);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(hello);
    }
  }

  #rejectHello(child: ChildProcessWithoutNullStreams, error: Error): void {
    const waiters = this.#helloWaiters.filter((w) => w.child === child);
    this.#helloWaiters = this.#helloWaiters.filter((w) => w.child !== child);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #startWatchdog(): void {
    const interval = this.#opts.pingIntervalMs ?? 45_000;
    if (interval <= 0) return;
    this.#stopWatchdog();
    this.#pingFailures = 0;
    this.#pingTimer = setInterval(() => {
      void this.ping()
        .then(() => {
          this.#pingFailures = 0;
        })
        .catch((error) => {
          if (this.#stopping) return;
          this.#pingFailures += 1;
          this.#log(`[client] ping 失败 ${this.#pingFailures}/2：${(error as Error).message}`);
          if (this.#pingFailures >= 2) {
            this.#pingFailures = 0;
            // 进程可能卡死（写不出也读不动）：杀掉，由 #onClose 走重启流程
            this.#log('[client] ping 连续失败，强制重启 agent 进程');
            this.#child?.kill('SIGKILL');
          }
        });
    }, interval);
    this.#pingTimer.unref?.();
  }

  #stopWatchdog(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    this.#stopStaleWatchdog();
  }

  /**
   * 连接看门狗的"心跳"判定：**只有能证明"和房间还连着"的事件才算数**。
   *
   * ⚠️ 2026-10-14 实测踩到：`relayStatus` 在"家庭中继反复横跳"时会几秒一条
   *    （日志里 `home is now relay iroh1→iroh2→…`）；把任何事件都当心跳的话，
   *    它会一直把心跳续上，看门狗被骗成"一切正常"——用户中午回来发现又断了、
   *    而且**没有触发任何自愈**。`isolated: true` 同理：那是"联系不上"的声明，不是活着。
   */
  #noteEvent(event: RoomEvent): void {
    if (!event) return;
    if (event.type === 'relayStatus') {
      // 只记中继侧的整体状态（全断时看门狗可以更早介入——见 #startStaleWatchdog）
      this.#relaysConnected = (event.relays ?? []).some((r) => r.connected);
      return;
    }
    if (event.type === 'error') return; // 本地错误，不证明连通
    if (event.type === 'isolated' && (event as { isolated?: boolean }).isolated === true) return;
    this.#lastRoomEventAt = Date.now();
    if (event.type === 'joined') this.#joinedSeen = true;
  }

  /**
   * 连接看门狗：进程活着，但"和房间失联"时把子进程杀掉让它重连。
   *
   * 为什么需要（2026-10-14 实测）：笔记本睡一晚后，iroh 的 gossip/中继连接没恢复；
   * 本地 ping 照常成功（那只是同一进程的 stdin/stdout），适配器却再收不到任何消息 ——
   * 表现为"打开它好像不行了"。presence 心跳正常约 15s 一次，所以"进房后 2 分钟
   * 一条事件都没有"几乎一定是连接死了。
   */
  #startStaleWatchdog(): void {
    const staleMs = this.#opts.staleRestartMs ?? 120_000;
    if (staleMs <= 0) return;
    this.#stopStaleWatchdog();
    // 检查频率：取 staleMs/4，夹在 1s..5s（测试里能传很小的值）
    const checkMs = Math.max(1000, Math.min(5_000, Math.floor(staleMs / 4)));
    // 中继全断时的更快阈值（有硬证据就不用等满 staleMs）
    const relayDeadMs = Math.max(5_000, Math.floor(staleMs / 2));
    this.#staleTimer = setInterval(() => {
      if (this.#stopping || !this.#joinedSeen) return;
      // 有在途请求（比如正在接收文件，可能跑 10 分钟）就先不动它，下一轮再看
      if (this.#pending.size > 0) return;
      const idle = Date.now() - this.#lastRoomEventAt;
      const relayDead = this.#relaysConnected === false && idle > relayDeadMs;
      if (idle <= staleMs && !relayDead) return;
      this.#log(
        `[client] 进房后 ${Math.round(idle / 1000)}s 收不到任何"能证明连通"的事件` +
          `${relayDead ? '（且中继全部断开）' : '（relayStatus 之类的中继事件不算数）'}` +
          ' → 强制重启 agent 进程重连',
      );
      // 先复位，避免重启完成前被重复判定
      this.#joinedSeen = false;
      this.#lastRoomEventAt = Date.now();
      this.#relaysConnected = null;
      this.#child?.kill('SIGKILL');
    }, checkMs);
    this.#staleTimer.unref?.();
  }

  #stopStaleWatchdog(): void {
    if (this.#staleTimer) {
      clearInterval(this.#staleTimer);
      this.#staleTimer = null;
    }
  }
}
