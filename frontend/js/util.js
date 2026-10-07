/* ============================================================================
 * util.js · 纯函数工具
 * 无副作用、不碰 DOM、不碰全局状态 —— 方便复用与测试。
 * ==========================================================================*/

/** HTML 转义（唯一允许拼接 HTML 的地方用它） */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 稳定哈希：同一个字符串永远得到同一个数 */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由字符串生成稳定的头像底色 */
export function colorOf(str) {
  const hues = [8, 30, 48, 96, 140, 168, 190, 214, 240, 268, 300, 330];
  return `hsl(${hues[hash(str) % hues.length]} 42% 42%)`;
}

/** 取首字符（支持 emoji / 中文） */
export function initial(name) {
  const t = String(name || '?').trim();
  return t ? [...t][0].toUpperCase() : '?';
}

/** EndpointId 缩略：默认 8 位，可指定更多 */
export function shortId(id, chars = 8) {
  return id ? String(id).slice(0, chars) : '';
}

export function clockTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 列表里显示的时间：今天只给时刻，否则给月/日 */
export function listTime(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? clockTime(ts)
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 时间分隔文本：跨天给"今天/昨天/日期"，同一天给时刻 */
export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  if (d.toDateString() === today) return '今天';
  if (d.toDateString() === yesterday) return '昨天';
  return d.toLocaleDateString();
}

/** 相对时间（在线成员用） */
export function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return listTime(ts);
}

export function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** 防抖 */
export function debounce(fn, ms = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带超时的 Promise */
export async function withTimeout(promise, ms, label = '操作') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 字节数 → 人类可读（与 Rust 侧 `human_size` 保持一致的口径） */
export function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // ⚠️ 返回前必须确认输入是**数字**：`Number(x) || 0` 之后原来的写法
  //    在 i === 0 时仍是 `` `${bytes} B` `` —— 把**原始值**原样回显。
  //    而调用点把它拼进 innerHTML（timeline 的文件卡片），所以一个
  //    非数字的 size 就是一处 XSS。当前上游是 Rust 的 u64 所以不可达，
  //    但这里是"只差一次类型检查"的隐患（复检 P3-2）。
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** 按扩展名给一个文件图标（用 emoji 是为了零依赖、跨平台一致） */
export function fileIcon(name) {
  const ext = String(name).toLowerCase().split('.').pop() || '';
  const map = {
    pdf: '📕',
    doc: '📘', docx: '📘', rtf: '📘',
    xls: '📗', xlsx: '📗', csv: '📗',
    ppt: '📙', pptx: '📙',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵',
    mp4: '🎬', mov: '🎬', mkv: '🎬', avi: '🎬',
    exe: '⚙️', dmg: '💿', pkg: '💿',
    txt: '📄', md: '📄', json: '📄', xml: '📄', yml: '📄', yaml: '📄',
    js: '📜', ts: '📜', py: '📜', rs: '📜', go: '📜', java: '📜', sh: '📜',
    html: '🌐', css: '🌐',
  };
  if (isImageName(ext)) return '🖼️';
  return map[ext] || '📄';
}

/** 按扩展名判断图片（剪贴板里的图片常常没有 MIME，只能靠后缀兜底） */
export function isImageName(ext) {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'].includes(
    String(ext).toLowerCase().replace(/^\./, ''),
  );
}

/** 从文件名判断是不是图片（没有 MIME 时用） */
export function looksLikeImage(file) {
  if ((file?.type || '').startsWith('image/')) return true;
  const ext = String(file?.name || '').toLowerCase().split('.').pop() || '';
  return isImageName(ext);
}

/**
 * 历史分页的**复合游标**：`"<ts>:<id>"`。
 *
 * ## 为什么不能只用毫秒时间戳
 *
 * 时间戳只精确到**毫秒**，同一毫秒内的多条消息时间完全相同。
 * 服务端若用 `ts < before` 过滤，落在 `before` 那一毫秒上的消息会被
 * **整体跳过** —— 也就是说首页取走 50 条后，第 51 条只要和第 50 条
 * 同毫秒，就永远取不到了（实测 51 条同 ts 的消息，第 51 条丢失）。
 *
 * 加上 `id` 就有了全序：`(ts, id)` 严格小于游标才取，边界的消息不会漏。
 * `id` 由签名载荷派生（见 Rust 侧 `ChatMessage::compute_id`），
 * 同一毫秒内的消息 id 互不相同。
 */
export function cursorOf(msg) {
  if (!msg) return '';
  return `${Number(msg.ts) || 0}:${String(msg.id ?? '')}`;
}
export function roomNameError(room) {
  if (!room || /[\u0000-\u001f\u007f-\u009f]/u.test(room)) return '房间名不能为空或包含控制字符';
  if (new TextEncoder().encode(room).length > 256) return '房间名最多 256 UTF-8 字节（中文约 85 字）';
  return '';
}
