/* ============================================================================
 * brains/rule.ts · 规则大脑（无 LLM，用于冒烟、自动化通知与"关键词应答"）
 *
 * 规则文件格式（JSON 数组）：
 *   [
 *     { "match": "ping",          "reply": "pong" },
 *     { "match": "/^hello/i",     "reply": "你好，{nick}！" },
 *     { "match": "/^who/i",       "reply": "我是 {nick}，在 {room} 房间里。" }
 *   ]
 *
 * `match` 两种写法：
 *   - `/pattern/flags` → 正则（⚠️ 会剥掉 g/y 标志，见下面注释）
 *   - 其它            → 不区分大小写的子串匹配
 * `reply` 里可用 {text} / {raw} / {nick} / {room} / {bot} 模板变量
 * （{nick} 是发送者，{bot} 是本 agent 自己的昵称）。
 * ==========================================================================*/

import { renderTemplate } from '../brain.ts';
import type { AgentBrain, IncomingMessage } from '../brain.ts';

export type RuleReply = string | ((msg: IncomingMessage) => string);

export interface RuleSpec {
  match: RegExp | string;
  reply: RuleReply;
}

/** 把规则文件的 JSON 解析成可执行规则；格式不对就抛（配置错误要响亮）。 */
export function parseRuleSpecs(json: unknown): RuleSpec[] {
  if (!Array.isArray(json)) throw new Error('规则文件必须是 JSON 数组');
  return json.map((entry, index) => {
    const obj = entry as Record<string, unknown>;
    const match = obj?.match;
    const reply = obj?.reply;
    if (typeof match !== 'string') throw new Error(`规则 #${index} 的 match 必须是字符串`);
    if (typeof reply !== 'string' && typeof reply !== 'function') {
      throw new Error(`规则 #${index} 的 reply 必须是字符串`);
    }
    return { match: toMatcher(match), reply: reply as RuleReply };
  });
}

function toMatcher(pattern: string): RegExp | string {
  if (pattern.length >= 2 && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const last = pattern.lastIndexOf('/');
    const body = pattern.slice(1, last);
    // ⚠️ 剥掉 g/y：带这两个标志的正则 `.test()` 有 lastIndex 状态，
    //    同一条规则第二次匹配会从上次位置继续 —— 表现为"隔一条才回一次"。
    const flags = pattern
      .slice(last + 1)
      .replaceAll('g', '')
      .replaceAll('y', '');
    return new RegExp(body, flags);
  }
  return pattern;
}

export class RuleBrain implements AgentBrain {
  #rules: RuleSpec[];

  constructor(rules: RuleSpec[]) {
    this.#rules = rules;
  }

  async onMessage(msg: IncomingMessage): Promise<string | null> {
    for (const rule of this.#rules) {
      const hit =
        typeof rule.match === 'string'
          ? msg.text.toLowerCase().includes(rule.match.toLowerCase())
          : rule.match.test(msg.text);
      if (!hit) continue;
      const reply = typeof rule.reply === 'function' ? rule.reply(msg) : rule.reply;
      return renderTemplate(reply, msg);
    }
    return null;
  }
}

/** 内置默认规则：`ping` → `pong`（不配规则文件时用）。 */
export function defaultRules(): RuleSpec[] {
  return [{ match: '/^ping\\b/i', reply: 'pong' }];
}
