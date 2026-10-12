/* ============================================================================
 * mention.js · @ 提及的**唯一寻址**（R1）
 *
 * ## 规范（三端一致，改之前先看这里）
 *
 * @ 的底层引用是成员的 **EndpointId**，不是昵称。昵称只做两件事：
 * **输入时给人挑**、**渲染时给人看**。
 *
 *   · 线上/历史里只出现 token：`@<id8>`，id8 = EndpointId 前 8 位小写 hex
 *   · 草稿里允许人手打 `@昵称` 或 `@昵称#id8`（甚至 `@id8`）；
 *     **发送前**由 `resolveDraft()` 统一改写成 token：
 *       唯一匹配 → token；`@昵称#id8` / `@id8` → token；
 *       同名歧义或匹配不到 → **原样保留**（当普通文本），并如实回报给调用方提示用户
 *
 * ## 为什么不是昵称寻址
 *
 * 同名、改名、昵称为空，都会让"这条消息到底在 @ 谁"变得不确定；
 * 而 id 唯一且稳定 —— 改名之后**历史里的 chip 也会显示新名字**（因为渲染时才查名册）。
 *
 * ## 为什么把 token 放在文本里（而不是结构化字段）
 *
 * 结构化 `mentions: [endpoint_id]` 要改 `ChatMessage` 的**签名载荷**（破坏性变更），
 * 按计划留到 v6；过渡期先用文本 token，语义完全一样，只是难看一点。
 *
 * ⚠️ 名册（id → 昵称）来自 presence 的**软状态**：成员离线后可能查不到名字，
 *    那时 chip 显示 id8 本身（如实，不猜）。
 * ==========================================================================*/

import { bus, EV } from './bus.js';

/** EndpointId → id8（前 8 位小写 hex） */
export function id8Of(id) {
  return String(id || '').slice(0, 8).toLowerCase();
}

/** 规范 token */
export function tokenFor(id) {
  return `@${id8Of(id)}`;
}

/**
 * token 的匹配式。
 *
 * ⚠️ 结尾用 `(?![0-9a-f])`：`@9b45b7ef` 后面紧跟别的小写十六进制字符时**不算** token，
 *    否则 `@9b45b7efabc` 这种更长的 id 会被误截成 8 位。
 */
const TOKEN_RE = /@([0-9a-f]{8})(?![0-9a-f])/g;

/**
 * 把文本切成 `[img]` 之外的分段，供时间线渲染 chip 用。
 *
 * `self` = 我自己（`{id, nickname}`）—— **必须传**：presence 的成员表里不含自己，
 * 不传的话"别人 @ 我"会渲染成 `@<id8>` 而不是我的名字（实测踩过）。
 */
export function segments(text, members = currentMembers(), self = null) {
  const out = [];
  const src = String(text ?? '');
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    const id8 = m[1];
    const member = memberById8(id8, members, self);
    out.push({
      type: 'mention',
      id8,
      nickname: member?.nickname ?? null,   // null = 名册里查不到（离线/换房/别人的历史）
      known: !!member,
    });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

/** 这条消息是否 @ 了我 */
export function mentionsMe(text, myId) {
  const mine = id8Of(myId);
  if (!mine) return false;
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    if (m[1] === mine) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ 名册 */

/**
 * 当前房间的成员名册（`{id, nickname, …}`）。
 *
 * ⚠️ **只有当前房间**：presence 是按房间推的，切房后会被替换 —— 与时间线一致
 *    （时间线也只显示当前房间）。
 * ⚠️ 自己不在 presence 的成员表里（Rust 侧把"我"排除掉了），所以 `memberById8`
 *    会把我自己补上，否则"@我自己"永远查不到名字。
 */
let members = [];

bus.on(EV.PRESENCE, ({ peers }) => {
  members = Array.isArray(peers) ? peers : [];
});

export function currentMembers() {
  return members;
}

/** 按 id8（或更长的 id 前缀）找成员；含我自己（`self`） */
export function memberById8(id8, roster = members, self = null) {
  const key = String(id8 || '').toLowerCase();
  if (!key) return null;
  const hit = roster.find((p) => String(p.id).toLowerCase().startsWith(key));
  if (hit) return hit;
  if (self && id8Of(self.id).startsWith(key)) return { id: self.id, nickname: self.nickname };
  return null;
}

/* ------------------------------------------------------- 发送前的草稿改写 */

/** @ 前允许的边界：行首、空白、常见中英文标点（避免把 `a@b.com` 当成提及） */
const LEADING = "(^|[\\s，。！？、；：,.!?;:()\\[\\]{}\"「」“”'’])";

/**
 * 把草稿里的提及统一改写成 token。
 *
 * @returns {{text: string, ambiguous: string[], unresolved: string[]}}
 *   `ambiguous`：同名多人，没法确定 @ 的是谁（原样保留，调用方应提示用户）
 *   `unresolved`：像是要 @ 但名册里没有这个人（同样原样保留）
 */
export function resolveDraft(text, roster = members) {
  const ambiguous = [];
  const unresolved = [];

  // ① 显式带 id 的两种写法 → 规范 token（人打的，或补全菜单插入的消歧形式）
  //    `@昵称#id8` / `@id8` 都归一到 `@id8`
  let out = String(text ?? '').replace(
    new RegExp(`${LEADING}@([^\\s@#]{1,40})?#([0-9a-f]{8})(?![0-9a-f])`, 'g'),
    (_m, lead, _nick, id) => `${lead}${tokenFor(id)}`,
  );

  // ② 裸 `@昵称` → 只有**唯一**匹配才改写
  out = out.replace(
    new RegExp(`${LEADING}@([^\\s@#]{1,40})`, 'g'),
    (whole, lead, nick) => {
      const hits = roster.filter((p) => p.nickname === nick);
      if (hits.length === 1) return `${lead}${tokenFor(hits[0].id)}`;
      if (hits.length > 1) { ambiguous.push(nick); return whole; }
      unresolved.push(nick);
      return whole;
    },
  );
  return { text: out, ambiguous, unresolved };
}
