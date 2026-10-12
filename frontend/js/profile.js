/* ============================================================================
 * profile.js · 名片（R2a）
 *
 * ## 名片是什么
 *
 * 一条**普通的签名消息**，text 是固定形状的 JSON：
 *
 *     {"t":"profile","v":1,"bio":"能查代码 · 会跑脚本","tags":["ts","rust"]}
 *
 * 为什么不新增协议帧：那要改 `ChatMessage` 的**签名载荷**（破坏性变更），
 * 按计划留到 v6 做正式的房间状态帧。现在用"约定格式的签名消息"落地，
 * 语义完全一样，而且**天然进历史** —— 新人翻记录就能看到（这正是我们要的）。
 *
 * ⚠️ 键序与空白是**约定**：常驻节点将来要能一句 SQL 就认出它们
 *    （`text LIKE '{"t":"profile"%'`），所以编码必须是这个前缀 + 无空格。
 *
 * ## 谁负责什么
 *
 *   · `encodeProfile` / `parseProfile`：格式的唯一实现（别处不许手拼这个 JSON）
 *   · `learn()`：把见到的名片记进本地表（**只认更新的那条**，按 ts）
 *   · `of()` / `mine()`：给 UI 读
 *
 * 名片表持久化在 `store.profiles()`：历史每次进房都要重拉，不存一份的话刷新就丢了。
 * ==========================================================================*/

import { bus, EV } from './bus.js';
import { store } from './store.js';

/** 前缀必须与 `encodeProfile` 的输出严格一致（常驻节点靠它做 SQL 过滤） */
export const PROFILE_PREFIX = '{"t":"profile"';

/** 简介长度上限（按字符算，够写一句话；太长会把花名册撑爆） */
export const MAX_BIO = 160;
/** 标签个数与单个长度上限 */
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 16;

export function isProfileText(text) {
  return typeof text === 'string' && text.startsWith(PROFILE_PREFIX);
}

/** 把 `{bio, tags}` 编成规范 JSON（键序固定、无空格 —— 见文件头） */
export function encodeProfile({ bio = '', tags = [] } = {}) {
  const cleanBio = String(bio ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_BIO);
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t ?? '').trim().slice(0, MAX_TAG_LEN))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  return JSON.stringify({ t: 'profile', v: 1, bio: cleanBio, tags: cleanTags });
}

/** 解析；不是名片 / 坏 JSON 一律返回 null（**永不抛**，别让一条脏消息打断时间线） */
export function parseProfile(text) {
  if (!isProfileText(text)) return null;
  try {
    const o = JSON.parse(text);
    if (!o || o.t !== 'profile') return null;
    return {
      bio: String(o.bio ?? '').slice(0, MAX_BIO),
      tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t).slice(0, MAX_TAG_LEN)).slice(0, MAX_TAGS) : [],
    };
  } catch {
    return null;
  }
}

/**
 * 并进一批名片（**唯一的写入口**）。
 *
 * **只认更新的那条**（按 `ts`）：gossip 不保证顺序、历史也可能被重放，
 * 一份旧名片不该把新简介盖回去。`ts` 相同则后到的胜（同一条消息重放没有差别）。
 *
 * @param {string} room
 * @param {Array<{id: string, bio: string, tags: string[], ts: number}>} entries
 */
export function upsert(room, entries) {
  if (!room || !entries?.length) return false;
  const all = store.profiles();
  const table = (all[room] ??= {});
  let changed = false;
  for (const e of entries) {
    const id = e?.id;
    if (!id) continue;
    const bio = String(e.bio ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_BIO);
    const tags = (Array.isArray(e.tags) ? e.tags : [])
      .map((t) => String(t ?? '').trim().slice(0, MAX_TAG_LEN))
      .filter(Boolean)
      .slice(0, MAX_TAGS);
    const ts = Number(e.ts ?? 0);
    const cur = table[id];
    if (cur && Number(cur.ts ?? 0) > ts) continue;
    if (cur && cur.bio === bio && JSON.stringify(cur.tags) === JSON.stringify(tags)) continue;
    table[id] = { bio, tags, ts };
    changed = true;
  }
  if (changed) {
    store.setProfiles(all);
    bus.emit(EV.PROFILES, { room });
  }
  return changed;
}

/** 从一批消息里学名片（实时消息与历史消息都走这里） */
export function learn(room, messages) {
  if (!room || !messages?.length) return false;
  const entries = [];
  for (const m of messages) {
    const p = parseProfile(m?.text);
    if (!p || !m.from) continue;
    entries.push({ id: m.from, bio: p.bio, tags: p.tags, ts: Number(m.ts ?? 0) });
  }
  return upsert(room, entries);
}

/**
 * 常驻节点从历史里学来的名片（R2b，`RoomEvent::Profiles`）→ 并进本地表。
 *
 * 它补的是客户端够不着的那部分：**只加载最近一页历史时，更早的名片翻不到**。
 */
export function mergeSnapshot(room, list) {
  return upsert(room, list);
}

/** 某个成员在这个房间的名片；没有则 null */
export function of(room, id) {
  if (!room || !id) return null;
  return store.profiles()[room]?.[id] ?? null;
}

/** 我自己的名片 */
export function mine(room, myId) {
  return of(room, myId);
}
