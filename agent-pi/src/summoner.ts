#!/usr/bin/env node
/* ============================================================================
 * summoner.ts · 召唤器（A2：邀请制）
 *
 * ## 它解决什么
 *
 * 房间里 **@ 了一个注册过但不在场的 agent** → 由它把那个 agent 拉进房间，
 * 并把原始请求**转交**过去 —— 被拉进来的成员看不到 @ 它的那条旧消息
 * （gossip 不补历史），所以这一步不能省。
 *
 * ## 谁提供、谁有权（A2 要求"要定"的两件事）
 *
 * · **谁提供**：由 agent **所有者**在他自己的机器上跑这个进程（凭据/沙箱都在那边）。
 *   它本身也是房间里一个普通成员（默认昵称"召唤器"），用 `respondToAll` 看所有消息。
 * · **谁有权**：v1 = **房间里任何成员**（与"知道房名就能进"一致）；
 *   想收窄就配 `--summon-from <id8,…>`（全局），或在注册表里按名字配 `allowFrom`（C4，更细）。
 *   **但无论如何，只能召唤注册表里列出的名字** —— 不能召唤任意程序（最重要的一道闸门）。
 *
 * ## 怎么被叫到（两条寻址，都落到注册表里的名字）
 *
 * 1. **`@注册名`**（人手打的）：名字后面不接 ASCII 字母/数字/下划线就算数，
 *    所以 `@研究助手帮我查` 这种中文不打空格的也认；转交时剥掉这个名字。
 * 2. **`@<id8>`**（规范 token，R1）：只要名册里见过这个 id 对应的是谁（注册成员），
 *    照样把人叫回来；等它进房后**用它在名册里的当前 id8 重新指向**（旧 token 剥掉）。
 *    为什么需要这条：翻历史回一条旧消息、或空闲回收之后再叫，手里只有 token。
 *    转交时说两样：文本 `@<id8>`（渲染锚点）+ **结构化 mentions**（V6 的寻址真相）。
 *
 * ## 闸门（硬约束：能力自带资源闸门）
 *
 * `--max-live`（同时最多几个）/ `--cooldown-ms`（同一名字两次召唤的间隔）/
 * `--idle-ms`（**没人叫它、它也没说话**多久就收掉）/ `--summon-from`（白名单）/
 * 注册表（名字白名单）。全部超限时**如实说一句**，不静默丢弃。
 *
 * ## 一房一会话（A3 结论，v1 就这么定）
 *
 * `--rooms` **只收一个房间**：同一个 `IROH_AGENT_HOME`（身份目录）绝不能给两个
 * `serve` 进程共用（中继/端点会互相踢），所以"一个进程盯多个房间"在这里直接拒绝，
 * 而不是让它带着会打架的身份跑起来。要同时盯几个房间 = 起几个召唤器进程，
 * 每个进程各自的 `IROH_AGENT_HOME`。
 *
 * ⚠️ 空闲回收看的是"互动"，不是"进程活着"：它按时发心跳也照样会被收掉 ——
 *    在跑长任务的成员要把 `--idle-ms` 调大；"忙碌"状态与更细的生命周期在 A4/C 期。
 *
 * ## 注册表格式（`--registry <file>`）
 *   { "研究助手": { "bin": "node", "args": ["…cli.ts","--nick","研究助手","--brain","rule"],
 *                   "env": {"IROH_AGENT_BIN": "/opt/iroh-agent/bin/agent"},
 *                   "cwd": "/tmp/sandbox" } }
 *   ⚠️ 召唤时会自动追加 `--room <房间>`（所以"加一个 agent = 加一份 spawn 配置"）；
 *      `--nick` 由注册表 args 自己带，并且**要和注册名一致**——转交靠名册里的名字找人。
 *   ⚠️ 成员的 env 要带齐进房需要的一切（中继/令牌 + rendezvous/history；可参考
 *      `scripts/e2e/summoner.py` 里的注册表样例）—— 少一样就是"孤立进房"，谁都看不见。
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { AgentBrain, ChatContext, IncomingMessage } from './agent-io/index.ts';
import { ChatAdapter } from './room/adapter.ts';
import { AgentClient } from './room/client.ts';
import type { RoomEvent } from './room/protocol.ts';

/** 注册表里一条 spawn 配置（召唤时自动追加 `--room`） */
export interface SpawnSpec {
  bin: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * C4 治理：**只有这些成员（id8）能召唤这一个名字**（可选）。
   * 与全局 `--summon-from` 是"与"的关系：两道都过才叫得动。
   */
  allowFrom?: string[];
}
export type Registry = Record<string, SpawnSpec>;

/** 拉起一个成员的把手；`onExit` 在它自己退出时回调（崩溃/自杀都能收到） */
export interface SpawnHandle {
  stop: () => void;
}
export type SpawnFn = (
  room: string,
  name: string,
  spec: SpawnSpec,
  onExit: (code: number | null, signal: string | null) => void,
) => SpawnHandle;

export interface SummonerOptions {
  registry: Registry;
  /** 允许召唤的 id8 白名单；空 = 房间里任何人都能召唤 */
  summonFrom?: string[];
  /** 同时最多带几个（默认 3） */
  maxLive?: number;
  /** 同一名字两次召唤的最小间隔 ms（默认 60s） */
  cooldownMs?: number;
  /** 没人叫它、它也没说话多久就收掉（默认 10 分钟） */
  idleMs?: number;
  log?: (line: string) => void;
  /** 测试注入点：默认真起子进程 */
  spawnFn?: SpawnFn;
}

/** 一个活着的成员（被召唤起来的那个 agent 进程） */
interface LiveMember {
  key: string; // `${room}/${名字}`
  room: string;
  name: string;
  stop: () => void;
  spawnedAt: number;
  lastAt: number; // 最近一次"被 @ 或自己说话"；空闲回收看它
}

const keyOf = (room: string, name: string) => `${room}/${name}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `@名字` 是否出现。
 * 名字后面不能紧接 ASCII 字母/数字/下划线（`@研究助手2` ≠ `@研究助手`），
 * 但 CJK 可以直接接（`@研究助手帮我查` —— 中文常不打空格）。
 */
export function mentionsName(text: string, name: string): boolean {
  return new RegExp(`@${escapeRegExp(name)}(?![A-Za-z0-9_])`).test(text);
}

/** 规范 token：`@<8 位小写 hex>`（R1）。别放宽成"任意长度 hex 前缀"。 */
const ID_TOKEN = /@[0-9a-f]{8}(?![0-9a-f])/g;

/** 默认的 spawn：真起子进程；stdout/stderr 直接继承（日志留在召唤器的输出里） */
export const defaultSpawnFn: SpawnFn = (room, _name, spec, onExit) => {
  const args = [...(spec.args ?? []), '--room', room];
  const proc = spawn(spec.bin, args, {
    cwd: spec.cwd ?? process.cwd(),
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('exit', (code, signal) => onExit(code, signal));
  return {
    stop: () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // 已经死了：忽略
      }
    },
  };
};

export class Summoner {
  #registry: Registry;
  #summonFrom: Set<string>;
  #maxLive: number;
  #cooldownMs: number;
  #idleMs: number;
  #log: (line: string) => void;
  #spawnFn: SpawnFn;
  #live = new Map<string, LiveMember>();
  /** 名册里见过的**注册成员**：id8 → 名字（`@<id8>` 再召唤用） */
  #id8ToName = new Map<string, string>();
  /** `${room}/${名字}` → 上次召唤时间（冷却用） */
  #lastSummon = new Map<string, number>();
  /** 等着的转交：`${room}/${名字}` → 要重说给它的那句话 */
  #pendingRelay = new Map<string, string>();

  constructor(opts: SummonerOptions) {
    this.#registry = opts.registry;
    this.#summonFrom = new Set((opts.summonFrom ?? []).map((s) => s.toLowerCase()));
    this.#maxLive = opts.maxLive ?? 3;
    this.#cooldownMs = opts.cooldownMs ?? 60_000;
    this.#idleMs = opts.idleMs ?? 10 * 60_000;
    this.#log = opts.log ?? ((line) => console.error(`[summoner] ${line}`));
    this.#spawnFn = opts.spawnFn ?? defaultSpawnFn;
  }

  get liveCount(): number {
    return this.#live.size;
  }

  /**
   * 一条房间消息（ChatAdapter → brain 的入口）。
   * 召唤器不直接"回话"（返回 null），要说的一律走 `say`。
   */
  async onMessage(
    room: string,
    msg: Pick<IncomingMessage, 'from' | 'text'> & { mine?: boolean },
    say: (text: string) => Promise<unknown> | unknown,
  ): Promise<null> {
    if (msg.mine) return null; // 自己说的话不算（也防自环）
    const text = String(msg.text ?? '');
    const from = String(msg.from ?? '');

    // 活成员自己在说话 = 它在忙 → 别让空闲回收把它收走
    const busyName = this.#id8ToName.get(from.slice(0, 8).toLowerCase());
    if (busyName) {
      const item = this.#live.get(keyOf(room, busyName));
      if (item) item.lastAt = Date.now();
    }

    // ① 人手打的 `@注册名`
    for (const name of Object.keys(this.#registry)) {
      if (!mentionsName(text, name)) continue;
      const relay = text.replaceAll(`@${name}`, '').trim() || '在吗？';
      await this.#summon(room, name, from, relay, say);
    }

    // ② 规范 token `@<id8>`（回复旧消息 / 再召唤时走这条）
    for (const token of text.match(ID_TOKEN) ?? []) {
      const name = this.#id8ToName.get(token.slice(1));
      if (!name) continue; // 没见过的 id（不在名册里）→ 什么都做不了
      // 剥掉旧 token；转交由 onRoster 用它**当前**的 id8 重新指向（换身份也能命中）
      const relay = text.replaceAll(token, '').trim() || '在吗？';
      await this.#summon(room, name, from, relay, say);
    }
    return null;
  }

  /**
   * presence（名册）更新：维护 `@<id8>` 对照表，并把欠着的转交补上。
   * ⚠️ 只在被召唤者**真的出现在名册里**才转交 —— 早说会石沉大海（gossip 不补历史）。
   */
  async onRoster(
    room: string,
    peers: { id: string; nickname: string }[],
    say: (text: string, mentions?: string[]) => Promise<unknown> | unknown,
  ): Promise<void> {
    for (const peer of peers) {
      const name = String(peer.nickname ?? '');
      if (!this.#registry[name]) continue; // 只认注册表里的成员（@<id8> 只服务召唤）
      const id8 = String(peer.id ?? '')
        .slice(0, 8)
        .toLowerCase();
      if (!id8) continue;
      this.#id8ToName.set(id8, name);
    }
    for (const [key, request] of [...this.#pendingRelay.entries()]) {
      if (!key.startsWith(`${room}/`)) continue;
      const name = key.slice(room.length + 1);
      const hit = peers.find((p) => String(p.nickname ?? '') === name);
      if (!hit) continue;
      this.#pendingRelay.delete(key);
      const id8 = String(hit.id ?? '')
        .slice(0, 8)
        .toLowerCase();
      // 规范 token（R1）当**渲染锚点** + 结构化 mentions（V6）当**寻址真相**
      await say(`@${id8} ${request}`, [String(hit.id)]);
      this.#log(`已把请求转交给「${name}」（@${id8}）`);
    }
  }

  /**
   * 召唤的唯一入口（闸门都在这里）。"叫不动"的每种原因都如实说出去，不静默。
   * `relay`：等它进房后要重说给它的那句话。
   */
  async #summon(
    room: string,
    name: string,
    from: string,
    relay: string,
    say: (text: string) => Promise<unknown> | unknown,
  ): Promise<void> {
    const key = keyOf(room, name);

    const existing = this.#live.get(key);
    if (existing) {
      // 已经在场：它自己看得见消息，不用我们管（刷新计时，防被回收）
      existing.lastAt = Date.now();
      return;
    }

    const sender8 = from.slice(0, 8).toLowerCase();
    if (this.#summonFrom.size && !this.#summonFrom.has(sender8)) {
      this.#log(`拒绝：${sender8} 不在 --summon-from 名单里（想叫「${name}」）`);
      await say(`我不能替你叫「${name}」——房主没把 ${sender8} 加进召唤名单`);
      return;
    }
    // C4 治理：注册表里还能按**名字**收窄（谁有权召唤哪一个）
    const perName = (this.#registry[name].allowFrom ?? []).map((s) => s.toLowerCase());
    if (perName.length && !perName.includes(sender8)) {
      this.#log(`拒绝：${sender8} 不在「${name}」的专属名单里（注册表 allowFrom）`);
      await say(`「${name}」只接受名单内成员的召唤 —— 你（${sender8}）不在名单里`);
      return;
    }

    const since = Date.now() - (this.#lastSummon.get(key) ?? 0);
    if (since < this.#cooldownMs) {
      await say(`「${name}」刚被叫过，${Math.ceil((this.#cooldownMs - since) / 1000)} 秒后再试`);
      return;
    }

    if (this.#live.size >= this.#maxLive) {
      await say(`同时最多带 ${this.#maxLive} 个助手，现在满了 —— 叫不动「${name}」`);
      return;
    }

    this.#lastSummon.set(key, Date.now());
    const now = Date.now();
    let handle: SpawnHandle | null = null;
    let member: LiveMember | null = null;
    handle = this.#spawnFn(room, name, this.#registry[name], (code, signal) => {
      if (member && this.#live.get(key) === member) this.#live.delete(key);
      this.#log(`「${name}」退出 code=${code} signal=${signal}（剩 ${this.#live.size} 个）`);
    });
    const created: LiveMember = {
      key,
      room,
      name,
      spawnedAt: now,
      lastAt: now,
      stop: () => handle?.stop(),
    };
    member = created;
    this.#live.set(key, created);
    // ⚠️ 先记下转交、再说"去叫了"：顺序反了的话，say 慢/失败会漏掉这次转交
    this.#pendingRelay.set(key, relay);
    await say(`🫡 去叫「${name}」了`);
    this.#log(`已拉起「${name}」进 ${room}（现在共 ${this.#live.size}/${this.#maxLive} 个）`);
  }

  /**
   * 空闲回收：把很久没人叫、自己也没说话的成员收掉（闸门之一）。
   * `now` 可注入（测试用），返回这批被收掉的名字。
   */
  reapIdle(now = Date.now()): string[] {
    const reaped: string[] = [];
    for (const item of [...this.#live.values()]) {
      const idle = now - item.lastAt;
      if (idle < this.#idleMs) continue;
      this.#log(`「${item.name}」已 ${Math.round(idle / 1000)}s 没人互动，收掉`);
      item.stop();
      this.#live.delete(item.key);
      reaped.push(item.name);
    }
    return reaped;
  }

  /** 收摊：把所有带起来的成员停掉（信号退出时用） */
  stopAll(): void {
    for (const item of [...this.#live.values()]) {
      item.stop();
      this.#live.delete(item.key);
    }
  }
}

/** 每个房间一个：把 ChatAdapter 的 brain 调用原样转给 Summoner */
export class SummonBrain implements AgentBrain {
  #summoner: Summoner;
  #room: string;
  constructor(summoner: Summoner, room: string) {
    this.#summoner = summoner;
    this.#room = room;
  }
  onMessage(msg: IncomingMessage, ctx: ChatContext): Promise<null> {
    return this.#summoner.onMessage(this.#room, msg, (text) => ctx.say(text));
  }
}

const argsOf = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const numOf = (name: string, fallback: number): number => {
  const raw = argsOf(name);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function startRoom(
  room: string,
  summoner: Summoner,
  opts: { nick: string; agentBin: string },
  log: (line: string) => void,
): Promise<void> {
  const client = new AgentClient({
    bin: opts.agentBin,
    args: ['serve', '--room', room, '--nick', opts.nick],
    log,
  });
  await client.start();
  const adapter = new ChatAdapter({
    client,
    brain: new SummonBrain(summoner, room),
    room,
    // 要看**所有**消息才能发现"有人 @ 了不在场的人"；过滤在 Summoner 里做
    respondToAll: true,
    cooldownMs: 0,
    log: (...args) => log(args.map(String).join(' ')),
  });
  adapter.start();
  client.on('event', (ev: RoomEvent) => {
    if (ev.type !== 'presence') return;
    void summoner.onRoster(room, ev.peers, (text, mentions) => client.say(text, mentions));
  });
  log(`已在 ${room} 待命（昵称 ${opts.nick}）：@ 注册表里的名字就能把它叫来`);
}

async function main(): Promise<void> {
  const rooms = String(argsOf('rooms', ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const registryPath = argsOf('registry');
  const nick = argsOf('nick') ?? '召唤器';
  const agentBin = argsOf('agent-bin') ?? process.env.IROH_AGENT_BIN ?? 'iroh-agent';
  const maxLive = numOf('max-live', 3);
  const cooldownMs = numOf('cooldown-ms', 60_000);
  const idleMs = numOf('idle-ms', 10 * 60_000);
  const summonFrom = String(argsOf('summon-from', ''))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!rooms.length) {
    throw new Error(
      '用法：summoner.ts --rooms a,b --registry <file> [--nick 召唤器] [--agent-bin …]',
    );
  }
  if (rooms.length > 1) {
    throw new Error(
      '一次只能盯一个房间（一房一会话）：要同时盯多个房间，请起多个 summoner 进程，' +
        '每个进程用各自的 IROH_AGENT_HOME（同一身份目录不能给两个进程共用）',
    );
  }
  if (!registryPath) throw new Error('缺 --registry（注册表 JSON：名字 → spawn 配置）');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Registry;
  if (!Object.keys(registry).length) throw new Error('注册表是空的');

  const log = (line: string): void => console.error(`[summoner] ${line}`);
  const summoner = new Summoner({ registry, summonFrom, maxLive, cooldownMs, idleMs, log });
  await Promise.all(rooms.map((room) => startRoom(room, summoner, { nick, agentBin }, log)));

  // 空闲回收：每 30s 扫一次（unref：不碍着退出）
  setInterval(() => summoner.reapIdle(), 30_000).unref();

  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，收摊（把带起来的成员也停掉）`);
    summoner.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 只有"被直接当程序跑"才启动；被 import（测试）时是纯库，不出副作用
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(`[summoner] 启动失败：${(error as Error).message}`);
    process.exit(1);
  });
}
