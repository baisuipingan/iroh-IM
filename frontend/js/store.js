/* ============================================================================
 * store.js · 本地持久化
 *
 * 统一收口 localStorage，键名集中在这里，避免散落各处拼字符串。
 * 版本前缀方便以后做数据迁移。
 * ==========================================================================*/

const NS = 'iroh.';

const KEYS = {
  secretKey: `${NS}secret-key`,
  nick: `${NS}nickname`,
  theme: `${NS}theme`,
  rooms: `${NS}rooms`,
  lastRoom: `${NS}last-room`,
  avatarColor: `${NS}avatar-color`,
  prefs: `${NS}prefs`,
  /** room -> {text, nick, ts, mine}：会话列表里显示的最后一条消息预览 */
  previews: `${NS}previews`,
  /** room -> 未读数 */
  unread: `${NS}unread`,
  hidden: `${NS}hidden-messages`,
};

const sessionValues = new Map();
let persistent = true;

function storageFailed() {
  if (!persistent) return;
  persistent = false;
  document.dispatchEvent(new CustomEvent('storageunavailable'));
}

function getValue(key) {
  if (sessionValues.has(key)) return sessionValues.get(key);
  try { return localStorage.getItem(key); }
  catch { storageFailed(); return null; }
}

function setValue(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    sessionValues.delete(key);
  } catch { sessionValues.set(key, value); storageFailed(); }
}

function readJSON(key, fallback) {
  try {
    const raw = getValue(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  setValue(key, JSON.stringify(value));
}

export const store = {
  keys: KEYS,
  get persistent() { return persistent; },
  getValue,
  setValue,

  /* ---------- 身份 ---------- */
  /** 读取身份私钥；没有就生成一个（32 字节 hex） */
  identity() {
    let hex = getValue(KEYS.secretKey);
    if (!/^[0-9a-f]{64}$/.test(hex || '')) {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
      setValue(KEYS.secretKey, hex);
    }
    return hex;
  },
  resetIdentity() {
    setValue(KEYS.secretKey, null);
  },

  /* ---------- 昵称 ---------- */
  nick(fallback) {
    const v = getValue(KEYS.nick);
    return v || fallback || '';
  },
  setNick(v) {
    setValue(KEYS.nick, v);
  },

  /* ---------- 主题 ---------- */
  //
  // 三个取值：`'auto'`（跟随系统，默认）/ `'dark'` / `'light'`。
  //
  // ⚠️ 默认值必须是 `'auto'` —— 原来是 `'dark'`，等于把"深色"当默认，
  //    与用户系统设置无关。改成 auto 后，白天用浅色系统的人打开就是浅色。
  // ⚠️ 这个 key（`iroh.theme`）在 `index.html` 的内联脚本里也读了一次
  //    （为了在首帧前定主题），改 key 要两处一起改。
  theme() {
    const v = getValue(KEYS.theme);
    return v === 'dark' || v === 'light' || v === 'auto' ? v : 'auto';
  },
  setTheme(v) {
    setValue(KEYS.theme, v);
  },

  /* ---------- 房间列表 ---------- */
  rooms() {
    const list = readJSON(KEYS.rooms, []);
    return Array.isArray(list) ? list : [];
  },
  saveRooms(list) {
    writeJSON(KEYS.rooms, list.slice().sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned) || (right.last || 0) - (left.last || 0)).slice(0, 40));
  },
  /** 降序：置顶优先，其次最近活跃 */
  roomsSorted() {
    return store
      .rooms()
      .slice()
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.last || 0) - (a.last || 0));
  },
  room(name) {
    return store.rooms().find((r) => r.name === name);
  },
  /** 更新或插入一个房间 */
  upsertRoom(name, patch = {}) {
    const list = store.rooms();
    const i = list.findIndex((r) => r.name === name);
    if (i >= 0) Object.assign(list[i], patch);
    else {
      if (list.length >= 40) return null;
      list.unshift({ name, last: Date.now(), ...patch });
    }
    store.saveRooms(list);
    return store.room(name);
  },
  removeRoom(name) {
    store.saveRooms(store.rooms().filter((r) => r.name !== name));
  },

  lastRoom() {
    return getValue(KEYS.lastRoom) || '';
  },
  setLastRoom(name) {
    setValue(KEYS.lastRoom, name);
  },

  /* ---------- 会话预览 / 未读 ----------
   *
   * 为什么要落盘：预览和未读原本只存在内存的 Map 里，刷新页面就全没了 ——
   * 表现是"明明有人发过消息，列表却显示'还没有消息'，未读红点也消失"。
   * 这类"看起来像假数据"的问题，根因就是状态没持久化。
   */

  /** @returns {Record<string, {text:string,nick:string,ts:number,mine:boolean}>} */
  previews() {
    const o = readJSON(KEYS.previews, {});
    return o && typeof o === 'object' ? o : {};
  },
  setPreview(room, preview) {
    const all = store.previews();
    all[room] = preview;
    // 只保留最近活跃的 40 个房间，和房间列表的上限一致，避免 localStorage 无限膨胀
    const keys = Object.keys(all);
    if (keys.length > 40) {
      keys
        .sort((a, b) => (all[b]?.ts || 0) - (all[a]?.ts || 0))
        .slice(40)
        .forEach((k) => delete all[k]);
    }
    writeJSON(KEYS.previews, all);
  },
  clearPreviews() {
    setValue(KEYS.previews, null);
  },

  /** @returns {Record<string, number>} */
  unread() {
    const o = readJSON(KEYS.unread, {});
    return o && typeof o === 'object' ? o : {};
  },
  setUnread(room, n) {
    const all = store.unread();
    if (n > 0) all[room] = n;
    else delete all[room];
    writeJSON(KEYS.unread, all);
  },
  clearUnread() {
    setValue(KEYS.unread, null);
  },

  /** localStorage 实际占用（设置页"数据用量"用，别写死数字骗人） */
  usage() {
    let bytes = 0;
    const detail = {};
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(NS)) continue;
      // UTF-16：字符数 × 2
        const size = (localStorage.getItem(key) || '').length * 2;
        bytes += size;
        detail[key.slice(NS.length)] = size;
      }
    } catch { storageFailed(); }
    return { bytes, detail };
  },

  /* ---------- 偏好 ---------- */
  prefs() {
    return readJSON(KEYS.prefs, {});
  },
  setPref(k, v) {
    const p = store.prefs();
    p[k] = v;
    writeJSON(KEYS.prefs, p);
  },

  clearLocal() {
    setValue(KEYS.rooms, null);
    setValue(KEYS.lastRoom, null);
    setValue(KEYS.prefs, null);
    setValue(KEYS.hidden, null);
    store.clearPreviews();
    store.clearUnread();
  },

  hideMessage(room, id) {
    const hidden = readJSON(KEYS.hidden, {});
    hidden[room] = [...new Set([...(hidden[room] || []), id])];
    writeJSON(KEYS.hidden, hidden);
  },
  isHidden(room, id) {
    return (readJSON(KEYS.hidden, {})[room] || []).includes(id);
  },
};
