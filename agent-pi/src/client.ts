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
  /** 至少成功握手过一次（决定崩溃后是否值得自动重启：路径写错就别无限重试） */
  #everHello = false;
  #stopping = false;
  #restarts = 0;
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
    this.#spawn();
    const hello = await this.#waitHello(60_000);
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

  say(text: string): Promise<{ id: string; ts: number }> {
    return this.request('say', { text }, 60_000) as Promise<{ id: string; ts: number }>;
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
    try {
      await this.request('shutdown', { reason: 'adapter stopping' }, 5_000);
    } catch {
      // 已经死了/超时：继续走退出确认
    }
    const exited = await Promise.race([
      once(child, 'close').then(() => true),
      sleep(5_000).then(() => false),
    ]);
    if (!exited) {
      this.#log('[client] agent 进程 5s 未退出，SIGKILL');
      child.kill('SIGKILL');
      await Promise.race([once(child, 'close'), sleep(2_000)]);
    }
    this.#failPending(new AgentError('stopped', '客户端已停止'));
  }

  // ------------------------------------------------------------------ 内部

  #spawn(): void {
    const args = ['serve', ...(this.#opts.args ?? [])];
    this.#log(`[client] 启动：${this.#opts.bin} ${args.join(' ')}`);
    const child = spawn(this.#opts.bin, args, {
      env: { ...process.env, ...this.#opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#helloFrame = null;

    createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => this.#log(`[agent] ${line}`));

    child.on('error', (error) => {
      this.#log(`[client] 进程错误：${error.message}`);
      this.#rejectHello(new AgentError('spawnFailed', error.message));
    });
    child.on('close', (code, signal) => this.#onClose(code, signal));
  }

  #onLine(line: string): void {
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
        this.#everHello = true;
        this.#resolveHello(frame);
        this.emit('hello', frame);
        break;
      case 'reply':
        this.#onReply(frame);
        break;
      case 'event':
        this.emit('event', frame.event as RoomEvent);
        break;
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

  #onClose(code: number | null, signal: string | null): void {
    const wasRunning = this.#everHello;
    this.#log(`[client] agent 进程退出（code=${code} signal=${signal}）`);
    this.#child = null;
    this.#helloFrame = null;
    this.#stopWatchdog();
    this.#failPending(new AgentError('processExited', 'agent 进程已退出'));
    this.#rejectHello(new AgentError('processExited', 'agent 进程已退出'));
    this.emit('exit', { code, signal });
    if (!this.#stopping && wasRunning) void this.#restartLoop();
  }

  async #restartLoop(): Promise<void> {
    while (!this.#stopping) {
      const backoff = this.#opts.restartBackoffMs ?? DEFAULT_BACKOFF;
      const wait = backoff[Math.min(this.#restarts, backoff.length - 1)];
      this.#restarts += 1;
      this.#log(`[client] ${wait}ms 后重启（第 ${this.#restarts} 次）`);
      await sleep(wait);
      if (this.#stopping) return;
      this.#spawn();
      try {
        const hello = await this.#waitHello(60_000);
        this.#log(`[client] 已重启并重新握手：endpointId=${hello.endpointId}`);
        this.#restarts = 0;
        this.emit('restarted', hello);
        return;
      } catch (error) {
        this.#log(`[client] 重启失败：${(error as Error).message}`);
      }
    }
  }

  #waitHello(timeoutMs: number): Promise<HelloFrame> {
    if (this.#helloFrame) return Promise.resolve(this.#helloFrame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#helloWaiters = this.#helloWaiters.filter((w) => w.timer !== timer);
        reject(new AgentError('helloTimeout', `${timeoutMs}ms 内没有收到 hello`));
      }, timeoutMs);
      this.#helloWaiters.push({ resolve, reject, timer });
    });
  }

  #resolveHello(hello: HelloFrame): void {
    const waiters = this.#helloWaiters;
    this.#helloWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(hello);
    }
  }

  #rejectHello(error: Error): void {
    const waiters = this.#helloWaiters;
    this.#helloWaiters = [];
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
  }
}
