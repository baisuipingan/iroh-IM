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
import { join } from 'node:path';
import type { AgentBrain, ChatContext, IncomingMessage } from './brain.ts';
import type { AgentClient } from './client.ts';
import type { ChatMessage, FileMeta, RoomEvent } from './protocol.ts';

/** 传给策略钩子的文件邀约信息（字段做了扁平化，方便直接判断） */
export interface FileInviteInfo {
  room: string;
  fileId: string;
  name: string;
  size: number;
  mime: string;
  /** 发送方的 EndpointId（白名单按它匹配） */
  sender: string;
}

export type FileDecision = 'accept' | 'reject' | 'ignore';

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
  // ---------------- 文件接收策略 ----------------
  /**
   * 收到文件邀约怎么办：`off`（默认，只记日志）/ `accept`（自动接收）/
   * `reject`（自动拒绝）。给了 `onFileInvite` 则完全由钩子接管，本项不生效。
   */
  files?: 'off' | 'accept' | 'reject';
  /** `accept` 模式的大小上限（字节），默认 64 MiB；超限自动拒绝 */
  filesMaxBytes?: number;
  /** 只接收这些发送方（EndpointId 列表）；空/不传 = 不限 */
  filesAllowFrom?: string[];
  /** 落盘目录（作为 savePath 传给 daemon）；不传 = daemon 默认 `<IROH_AGENT_HOME>/received/` */
  filesSaveDir?: string;
  /** 并发接收上限（默认 2）；满了自动拒绝并让对端稍后重发 */
  filesMaxConcurrent?: number;
  /** 自定义策略钩子：完全接管文件决策（可 async）；抛异常 = 本次忽略 */
  onFileInvite?: (invite: FileInviteInfo) => FileDecision | Promise<FileDecision>;
  log?: (...args: unknown[]) => void;
}

export class ChatAdapter {
  #opts: AdapterOptions;
  #dedupe = new Set<string>();
  #dedupeOrder: string[] = [];
  #lastReplyAt = 0;
  #started = false;
  /** 已处理过的文件邀约（fileId LRU）；接收失败会移除以允许重发重试 */
  #fileSeen = new Set<string>();
  #fileSeenOrder: string[] = [];
  /** 正在接收的 fileId（并发上限用） */
  #accepting = new Set<string>();

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
    if (event.type === 'fileInvite') {
      void this.#handleFileInvite(event.room, event.meta);
      return;
    }
    if (event.type === 'fatal') this.#log(`[adapter] fatal：${event.reason}（等待自动重启）`);
  };

  // ------------------------------------------------------------------ 文件策略

  async #handleFileInvite(room: string, meta: FileMeta): Promise<void> {
    // 同一 fileId 只处理一次（发送方可能因 FileQueryAsked 重发邀约）；
    // 接收失败时会 forget，让重发的邀约能再次尝试。
    if (!this.#rememberFile(meta.file_id)) return;
    const info: FileInviteInfo = {
      room,
      fileId: meta.file_id,
      name: meta.name,
      size: meta.size,
      mime: meta.mime ?? '',
      sender: meta.sender,
    };

    let decision: FileDecision;
    try {
      decision = this.#opts.onFileInvite
        ? await this.#opts.onFileInvite(info)
        : this.#filePolicy(info);
    } catch (error) {
      // 钩子异常视为"这次忽略"，但**允许重发重试**（别把 fileId 永久吞掉）
      this.#forgetFile(info.fileId);
      this.#log(`[adapter] 文件策略异常（本次忽略 ${info.name}）：${(error as Error).message}`);
      return;
    }

    if (decision === 'ignore') {
      this.#log(
        `[adapter] 文件邀约（忽略）：${info.name}（${info.size} 字节，来自 ${info.sender.slice(0, 8)}…）`,
      );
      return;
    }
    if (decision === 'reject') {
      const reason = this.#rejectReason(info);
      try {
        await this.#opts.client.rejectFile(info.fileId, reason);
        this.#log(`[adapter] 已拒绝 ${info.name}：${reason}`);
      } catch (error) {
        this.#log(`[adapter] 拒绝失败（忽略）：${(error as Error).message}`);
      }
      return;
    }

    // accept
    const maxConcurrent = this.#opts.filesMaxConcurrent ?? 2;
    if (this.#accepting.size >= maxConcurrent) {
      try {
        await this.#opts.client.rejectFile(info.fileId, '接收忙，稍后请重发');
      } catch {
        // 对端可能已经走了；记日志即可
      }
      this.#log(`[adapter] 并发已满（${maxConcurrent}），拒绝 ${info.name}`);
      return;
    }
    this.#accepting.add(info.fileId);
    try {
      const savePath = this.#opts.filesSaveDir
        ? join(this.#opts.filesSaveDir, sanitizeName(info.name))
        : undefined;
      const result = await this.#opts.client.acceptFile(info.fileId, savePath);
      this.#log(`[adapter] 已接收 ${info.name} → ${result.path}（${result.bytes} 字节）`);
    } catch (error) {
      // 失败允许重发重试：把 fileId 从"已处理"里摘掉
      this.#forgetFile(info.fileId);
      this.#log(`[adapter] 接收 ${info.name} 失败：${(error as Error).message}`);
    } finally {
      this.#accepting.delete(info.fileId);
    }
  }

  /** 默认策略：按 `files` 模式 + 白名单 + 大小上限决策。 */
  #filePolicy(info: FileInviteInfo): FileDecision {
    const mode = this.#opts.files ?? 'off';
    if (mode === 'off') return 'ignore';
    if (mode === 'reject') return 'reject';
    const allow = this.#opts.filesAllowFrom;
    if (allow && allow.length > 0 && !allow.includes(info.sender)) return 'reject';
    if (info.size > (this.#opts.filesMaxBytes ?? 64 * 1024 * 1024)) return 'reject';
    return 'accept';
  }

  /** 拒绝理由：说清楚是哪条守卫拦的（对端能看到）。 */
  #rejectReason(info: FileInviteInfo): string {
    if ((this.#opts.files ?? 'off') === 'reject') return '文件接收已关闭';
    const allow = this.#opts.filesAllowFrom;
    if (allow && allow.length > 0 && !allow.includes(info.sender)) return '发送方不在白名单';
    const max = this.#opts.filesMaxBytes ?? 64 * 1024 * 1024;
    if (info.size > max) {
      return `文件超过大小上限（${fmtSize(info.size)} > ${fmtSize(max)}）`;
    }
    return '文件接收已关闭';
  }

  /** 文件邀约去重（LRU 128）。返回 true = 第一次见。 */
  #rememberFile(fileId: string): boolean {
    if (this.#fileSeen.has(fileId)) return false;
    this.#fileSeen.add(fileId);
    this.#fileSeenOrder.push(fileId);
    if (this.#fileSeenOrder.length > 128) {
      const oldest = this.#fileSeenOrder.shift();
      if (oldest) this.#fileSeen.delete(oldest);
    }
    return true;
  }

  #forgetFile(fileId: string): void {
    this.#fileSeen.delete(fileId);
    this.#fileSeenOrder = this.#fileSeenOrder.filter((id) => id !== fileId);
  }

  // ------------------------------------------------------------------ 消息触发

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

/** 人类可读大小（日志/拒绝理由用）。 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 只留 basename、去控制字符（文件名来自对端；daemon 侧还有一层同样逻辑兜底）。 */
export function sanitizeName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() ?? '';
  const cleaned = [...base].filter((c) => c.charCodeAt(0) >= 32).join('');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
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
