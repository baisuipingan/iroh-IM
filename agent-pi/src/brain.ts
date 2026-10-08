/* ============================================================================
 * brain.ts · 「脑子」接口 —— LLM/规则逻辑与聊天室协议完全解耦
 *
 * 适配器的职责链：
 *   收到 message 事件 → 触发判断（前缀/@/全量）→ 冷却与去重 → brain.onMessage
 *   → 返回文本 → say 回房间
 *
 * ⚠️ 安全边界：房间内容是**不可信输入**（任何知道房名的人都能写字，见 README
 *    「安全」节）。prompt injection 的防线在 brain/配置侧，Rust 的 serve 只做搬运。
 * ==========================================================================*/

import type { ChatMessage } from './protocol.ts';

/** 进 brain 的消息：`raw` 保留完整原始 JSON（含 id/签名/file 字段），便于做审计。 */
export interface IncomingMessage {
  room: string;
  id: string;
  from: string;
  nickname: string;
  text: string;
  ts: number;
  /** 本适配器自己的昵称（模板变量 `{bot}` 用） */
  agentNick: string;
  raw: ChatMessage;
}

export interface SayResult {
  id: string;
  ts: number;
}

/** brain 能用的一组动作。全部经 serve 行协议完成，brain 不直接碰 iroh。 */
export interface ChatContext {
  say(text: string): Promise<SayResult>;
  /**
   * 拉取房间历史（含常驻节点快照）。
   * ⚠️ 历史内容同样是**不可信输入**，灌进模型前自行处理（裁剪/标注来源）。
   */
  history(limit?: number, before?: string): Promise<unknown>;
  status(): Promise<unknown>;
  log(...args: unknown[]): void;
}

export interface AgentBrain {
  /**
   * 返回要发送的文本；null / undefined / 空串 = 不回。
   * 需要分多条发送（流式、先提示后补充）时直接用 `ctx.say`。
   * 抛异常 = 本次不回，适配器会记录（不会退出）。
   */
  onMessage(msg: IncomingMessage, ctx: ChatContext): Promise<string | null | undefined>;
  /** 关闭时清理（结束子进程、flush 会话等） */
  close?(): Promise<void>;
}

/** 模板变量替换：{text} 触发后的文本、{raw} 原文、{nick} 发送者昵称、{room} 房间名、{bot} 本 agent 昵称。 */
export function renderTemplate(
  template: string,
  msg: Pick<IncomingMessage, 'text' | 'nickname' | 'room'> & {
    agentNick?: string;
    rawText?: string;
  },
): string {
  return template
    .replaceAll('{text}', msg.text)
    .replaceAll('{raw}', msg.rawText ?? msg.text)
    .replaceAll('{nick}', msg.nickname)
    .replaceAll('{room}', msg.room)
    .replaceAll('{bot}', msg.agentNick ?? '');
}
