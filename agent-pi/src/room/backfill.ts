/* ============================================================================
 * backfill.ts · 进房补投：把"桥不在时"错过的消息捞回来
 *
 * 为什么需要（2026-10-15 实测）：你重启 room-bridge（或它自己崩溃重拉）的那几秒里，
 * 用户在房间里 @ 了它 —— 消息已经进了房间/常驻节点历史，但**适配器是在消息之后才
 * 进房的**，gossip 不补历史，于是它永远看不到这条 @：用户"等了半天没反应"。
 *
 * 形态：每次看到 `joined` 事件就做一次"补投"——
 *   1. 拉最近一页历史（默认 50 条）；
 *   2. 挑出：不是自己发的、**没见过**的、`ts` 在窗口内（默认 3 分钟）的；
 *   3. 用 `client.emit('event', …)` 按**和实时消息完全相同的事件形状**重放一遍
 *      —— 触发判断/去重/冷却全部走同一条路径，这里不做任何特判。
 *
 * ⚠️ 去重是**持久化**的（`<home>/room-seen.json`，每房最近 200 个消息 id）：
 *    没有它，进程重启一次就会把窗口内的 @ 再回一遍（用户会看到重复回复）。
 *    用 id 而不是时间戳去重，是为了不受各端时钟偏差影响。
 *
 * ⚠️ 只在"窗口内"补投：不翻旧账（重启后不会去回早上/昨天的问题）。
 * ==========================================================================*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient } from './client.ts';
import { agentHomeDir } from './bootstrap.ts';
import type { ChatMessage, RoomEvent } from './protocol.ts';

export interface JoinBackfillOptions {
  /** 只补最近这么久内发的消息（默认 180000；0 = 关闭补投） */
  ageMs?: number;
  /** 每次最多拉多少条历史（默认 50） */
  limit?: number;
  /** 去重状态目录（默认 = iroh-agent 的 home 目录） */
  stateDir?: string;
  log?: (line: string) => void;
  now?: () => number;
}

type ProfileClient = Pick<AgentClient, 'on' | 'off' | 'emit' | 'history' | 'hello'>;

const MAX_SEEN_PER_ROOM = 200;

interface SeenState {
  rooms: Record<string, string[]>;
}

/** 读去重状态；坏文件/不存在都当空的（不 let 它挡住补投） */
function loadSeen(path: string): SeenState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SeenState;
    if (parsed && typeof parsed === 'object' && parsed.rooms && typeof parsed.rooms === 'object') {
      return { rooms: parsed.rooms };
    }
  } catch {
    // 首次运行（文件不存在）/坏文件：都从零开始
  }
  return { rooms: {} };
}

/** 绑定"进房补投"。返回解绑函数。`ageMs <= 0` 时什么都不做。 */
export function attachJoinBackfill(
  client: ProfileClient,
  opts: JoinBackfillOptions = {},
): () => void {
  const ageMs = opts.ageMs ?? 180_000;
  if (ageMs <= 0) return () => {};
  const limit = opts.limit ?? 50;
  const log = opts.log ?? ((line: string): void => console.error(line));
  const now = opts.now ?? Date.now;
  const stateDir = opts.stateDir ?? agentHomeDir();
  const statePath = join(stateDir, 'room-seen.json');

  const seen = loadSeen(statePath);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const saveSoon = (): void => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(statePath, `${JSON.stringify(seen)}\n`);
      } catch (error) {
        log(`[backfill] 去重状态写入失败（不影响运行）：${(error as Error).message}`);
      }
    }, 3_000);
    saveTimer.unref?.();
  };

  const remember = (room: string, id: string): void => {
    const list = (seen.rooms[room] ??= []);
    if (list.includes(id)) return;
    list.push(id);
    if (list.length > MAX_SEEN_PER_ROOM) list.splice(0, list.length - MAX_SEEN_PER_ROOM);
    saveSoon();
  };

  const backfill = async (room: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const reply = (await client.history(limit)) as { messages?: ChatMessage[] } | undefined;
      const messages = reply?.messages ?? [];
      const myId = client.hello?.endpointId ?? '';
      const ids = new Set(seen.rooms[room] ?? []);
      const missed: ChatMessage[] = [];
      for (const m of messages) {
        if (!m?.id) continue;
        if (m.from === myId) continue;
        if (ids.has(m.id)) continue;
        if (now() - Number(m.ts ?? 0) > ageMs) continue;
        missed.push(m);
      }
      // 所有拉到的消息都记进"见过"（含不补投的），避免下一轮重复扫描
      for (const m of messages) if (m?.id) remember(room, m.id);
      if (missed.length) {
        log(`[backfill] 补投 ${missed.length} 条「进房前错过」的消息（最近 ${Math.round(ageMs / 1000)}s 窗口）`);
        for (const m of missed.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))) {
          // 与实时消息完全相同的事件形状 —— 触发/去重/冷却走同一条路
          client.emit('event', { type: 'message', room, mine: false, message: m } as RoomEvent & {
            room: string;
            mine: boolean;
            message: ChatMessage;
          });
        }
      }
    } catch (error) {
      log(`[backfill] 拉历史失败（下次 joined 再试）：${(error as Error).message}`);
    } finally {
      running = false;
    }
  };

  const onEvent = (event: RoomEvent): void => {
    if (!event) return;
    if (event.type === 'message' && event.message?.id) {
      remember(event.room, event.message.id);
      return;
    }
    if (event.type === 'joined') {
      const room = (event as { room?: string }).room;
      if (room) void backfill(room);
    }
  };

  client.on('event', onEvent);
  return () => client.off('event', onEvent);
}
