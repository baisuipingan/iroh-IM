/* ============================================================================
 * adapter.ts · 触发策略 + 去重 + 冷却 —— 把「房间里的消息」接到「brain」
 *
 * 触发规则（任一命中就调 brain；可在 CLI 上关掉）：
 *   1. 前缀：`!ping`（默认前缀 `!`，剥离前缀后作为 {text}）
 *   2. @提及：`@小助手 在吗`（剥离提及后作为 {text}）
 *   3. respondToAll：所有消息都算触发（噪音大，慎用）
 *
 * 防回环/防刷屏（默认开）：
 *   - 自己的消息（mine）不回
 *   - 昵称以 `[bot]` 开头的消息不回（别的机器人，默认列表可扩展）
 *   - 同一个 message.id 只处理一次（去重）
 *   - 两次实际回复之间至少隔 cooldownMs（冷却期内的新触发**丢弃并记日志**，
 *     不排队 —— 聊天室场景里过期的回复比不回更糟）
 *
 * ⚠️ 安全：从这里进 brain 的一切文本都是**不可信输入**。适配器不做任何
 *    "基于内容的动作"，只做裁剪与限流；模型侧的 injection 防线见 README。
 * ==========================================================================*/

import { Buffer } from 'node:buffer';
import type { AgentBrain, ChatContext, IncomingMessage } from './brain.ts';
import type { AgentClient } from './client.ts';
import type { ChatMessage, RoomEvent } from './protocol.ts';

export interface AdapterOptions {
  client: AgentClient;
  brain: AgentBrain;
  room: string;
  /** 触发前缀；null = 关（默认 '!'） */
  prefix?: string | null;
  /** @ 提及的昵称；null = 关（默认 null；CLI 会在给了 --nick 时默认打开） */
  mention?: string | null;
  /** 所有消息都触发（默认 false） */
  respondToAll?: boolean;
  /** 两次回复的最小间隔，默认 3000ms */
  cooldownMs?: number;
  /** 回复文本上限（UTF-8 字节），默认 30000（serve 的 say 上限是 32768） */
  maxReplyBytes?: number;
  /** 这些昵称前缀的消息不触发（默认 ['[bot]']，避免机器人们互相刷屏） */
  ignoreBotPrefixes?: string[];
  log?: (...args: unknown[]) => void;
}

export class ChatAdapter {
  #opts: AdapterOptions;
  #dedupe = new Set<string>();
  #dedupeOrder: string[] = [];
  #lastReplyAt = 0;
  #started = false;

  constructor(opts: AdapterOptions) {
    this.#opts = opts;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#opts.client.on('event', this.#onEvent);
  }

  async stop(): Promise<void> {
    await this.#opts.brain.close?.();
  }

  #log = (...args: unknown[]): void => {
    this.#opts.log?.(...args);
  };

  #onEvent = (event: RoomEvent): void => {
    if (event.type === 'message' && !event.mine) {
      void this.#handle(event.room, event.message);
      return;
    }
    if (event.type === 'fatal') this.#log(`[adapter] fatal：${event.reason}（等待自动重启）`);
  };

  async #handle(room: string, message: ChatMessage): Promise<void> {
    const ignorePrefixes = this.#opts.ignoreBotPrefixes ?? ['[bot]'];
    if (ignorePrefixes.some((prefix) => message.nickname.startsWith(prefix))) return;
    if (!this.#remember(message.id)) return;

    const triggered = this.#extract(message.text);
    if (triggered === null) return;

    const cooldownMs = this.#opts.cooldownMs ?? 3000;
    const now = Date.now();
    if (now - this.#lastReplyAt < cooldownMs) {
      this.#log(
        `[adapter] 冷却中（${cooldownMs - (now - this.#lastReplyAt)}ms），忽略来自 ${message.nickname} 的触发`,
      );
      return;
    }

    const incoming: IncomingMessage = {
      room,
      id: message.id,
      from: message.from,
      nickname: message.nickname,
      text: triggered,
      ts: message.ts,
      agentNick: this.#opts.client.hello?.nickname ?? '',
      raw: message,
    };
    const ctx: ChatContext = {
      say: (text) => this.#opts.client.say(text),
      history: (limit, before) => this.#opts.client.history(limit, before),
      status: () => this.#opts.client.status(),
      log: (...args) => this.#log('[brain]', ...args),
    };

    let reply: string | null | undefined;
    try {
      reply = await this.#opts.brain.onMessage(incoming, ctx);
    } catch (error) {
      this.#log(`[adapter] brain 处理失败（本次不回）：${(error as Error).message}`);
      return;
    }
    if (typeof reply !== 'string') return;
    const text = reply.trim();
    if (!text) return;

    const clipped = truncateUtf8(text, this.#opts.maxReplyBytes ?? 30_000);
    if (clipped !== text)
      this.#log(`[adapter] 回复超过上限，已截断到 ${this.#opts.maxReplyBytes ?? 30_000} 字节`);
    this.#lastReplyAt = Date.now();
    try {
      const sent = await this.#opts.client.say(clipped);
      this.#log(`[adapter] 已回复 ${incoming.nickname}：id=${sent.id}`);
    } catch (error) {
      this.#log(`[adapter] 发送失败：${(error as Error).message}`);
    }
  }

  /**
   * 触发判断。返回剥掉前缀/提及后的文本（可能是空串，brain 自己决定怎么处理）；
   * null = 不触发。
   */
  #extract(text: string): string | null {
    const trimmed = text.trim();
    // ⚠️ 用 `=== undefined` 而不是 `??`：`null` 是显式的"关掉这个触发方式"。
    const prefix = this.#opts.prefix === undefined ? '!' : this.#opts.prefix;
    if (prefix && trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
    const mention = this.#opts.mention ?? null;
    if (mention && trimmed.includes(`@${mention}`)) {
      return trimmed.replaceAll(`@${mention}`, '').trim();
    }
    if (this.#opts.respondToAll) return trimmed;
    return null;
  }

  /** 消息 id 去重（LRU：只留最近 1024 个）。返回 true = 第一次见。 */
  #remember(id: string): boolean {
    if (this.#dedupe.has(id)) return false;
    this.#dedupe.add(id);
    this.#dedupeOrder.push(id);
    if (this.#dedupeOrder.length > 1024) {
      const oldest = this.#dedupeOrder.shift();
      if (oldest) this.#dedupe.delete(oldest);
    }
    return true;
  }
}

/** 按 UTF-8 字节上限截断（不会切坏多字节字符，因为按字符二分）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}\n…（已截断）`;
}
