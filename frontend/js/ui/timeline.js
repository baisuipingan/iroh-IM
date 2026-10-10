/* ============================================================================
 * ui/timeline.js · 消息时间线
 *
 * 职责：
 *   - 渲染消息（文本 / 内联图片），自动插时间分隔（跨天 → 今天/昨天/日期，同日 → 时刻）
 *   - 滚到顶部时向上翻页加载更早的消息，并保持视口不跳
 *   - 不在底部时显示"回到最新"，并可标记"新消息"分隔线
 *   - 作为滚动容器，自己负责把 scrollTop 调好
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { avatar } from './primitives.js';
import * as U from '../util.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;              // 每次翻页条数
const GROUP_GAP = 5 * 60e3;   // 同一天内超过 5 分钟插一条时刻分隔
const SYNC_INTERVAL = 10000;
const compareMessages = (left, right) => Number(left.ts) - Number(right.ts) ||
  (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0);

export const timeline = {
  room: '',
  me: '',
  seen: new Set(),        // 消息 id 去重（历史 + 实时 + 本地乐观插入）
  /** 最早一条消息的**复合游标** `"ts:id"`（空串 = 还没有历史） */
  oldestCursor: '',
  reachStart: false,
  loading: false,
  lastTs: 0,
  lastDayKey: '',
  atBottom: true,
  unreadAnchor: null,     // 不在底部时，第一条新消息的 id（用于插"新消息"分隔线）
  /** 临时系统提示的自动消失计时器 */
  _noteTimer: null,
  _generation: 0,
  _latestRequest: null,
  _syncTimer: null,
  _syncedMessage: null,
  _oldestMessage: null,
  _filePositions: new Map(),
  _prepending: false,

  /**
   * 现在「几何上是不是真的在底部」—— **实时算**。
   *
   * ⚠️ 用途只有一个：**决定「回到最新」按钮该不该亮**。
   *    **不要**用它决定"要不要滚动" —— 那是 `atBottom` 的事。
   *
   * ⚠️ 为什么不能拿它决定滚不滚（上一轮的教训）：刷新进房后 `visibilitychange`
   *    会触发一次 `_scheduleSync(0)` → 静默重载历史。那条路径是**逐条 push**，
   *    每条 push 前都问一次"现在在底部吗"—— 内容早就溢出了，答案永远是 false，
   *    于是**一条都不贴底**，最后停在中间，还把「回到最新」点亮了。
   *    实测：这就是"每次刷新后进度条都在中间"的成因。
   */
  _shouldStick() {
    const el = $('timeline');
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  },

  /** 贴底（差 2px 以内就算到位，避免和下一帧的亚像素抖动打架） */
  _pin() {
    const el = $('timeline');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.atBottom = true;
  },

  init() {
    $('timeline').addEventListener('scroll', () => {
      const el = $('timeline');
      this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      $('jump-btn').classList.toggle('is-on', !this.atBottom);
      if (el.scrollTop < 40) this.loadOlder();
    });

    // ★ 内容变高就自动重新贴底。
    //   为什么必须结构性地钉住，而不是"每次 push 时滚一次"：
    //   实测发消息时浏览器会做**滚动锚定**（scrollTop 自动跟着内容增长 +Δ），
    //   而我们那一刻读到的 scrollHeight 还没稳定，于是最后一条卡在输入区后面
    //   约 26px —— 要用户再点一下输入框才对。图片解码完那一下同理。
    const inner = $('tl-inner');
    if (typeof ResizeObserver === 'function' && inner) {
      new ResizeObserver(() => {
        // ⚠️ 这里必须用 `atBottom`（**变化前**的用户意图），**不能**用 `_shouldStick()`。
        //    内容长高之后 gap 已经不是原来那个值了（实测 0 → 200px），
        //    拿它一判断就必然是 false，于是永远不重贴 —— 这个坑我自己踩了一次。
        if (!this.atBottom) return;                          // 用户往上翻了，别动他的位置
        const el = $('timeline');
        if (el.scrollHeight - el.clientHeight - el.scrollTop <= 2) return;  // 已贴底，别制造抖动
        this._pin();
      }).observe(inner);
    }
    $('jump-btn').onclick = () => this.scrollBottom();

    // composer 高度会随待发送区/多行输入变化，"回到最新"要跟着上移。
    // 用 ResizeObserver 而不是写死数值 —— 之前写死 152px，附件一展开就压住输入框。
    //
    // ★ 这里除了挪 jump-btn，还要**重新贴底**：输入区一变高，时间线的可视高度就变小，
    //   `scrollHeight - clientHeight - scrollTop` 立刻差出一截（实测多行输入 3 行时差 52px），
    //   而内容本身没变 —— `#tl-inner` 那个观察器**不会触发**，于是最后一条被压在输入区下面。
    //   必须在 composer 变高的这一刻自己钉一次。
    const cp = $('composer');
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        this.syncJumpBtn();
        if (!this.atBottom) return;                          // 用户往上翻了，别动
        const el = $('timeline');
        if (el.scrollHeight - el.clientHeight - el.scrollTop <= 2) return;
        this._pin();
      }).observe(cp);
    } else {
      addEventListener('resize', () => this.syncJumpBtn());
    }
    this.syncJumpBtn();

    bus.on(EV.MSG, ({ room, message, mine, isHistory }) => {
      if (room !== this.room) return;
      this.push(message, mine, isHistory);
    });
    bus.on(EV.REJOINED, (room) => {
      if (room === this.room) this.loadLatest({ silent: true });
    });
    bus.on(EV.PEER_UP, () => this._scheduleSync(500));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._scheduleSync(0);
    });
  },

  /** 把 composer 的实际高度写进 CSS 变量，供 .jump-btn 定位 */
  syncJumpBtn() {
    const cp = $('composer');
    if (!cp) return;
    const h = cp.offsetHeight;
    if (h) document.documentElement.style.setProperty('--composer-h', `${h}px`);
  },

  /* ------------------------------------------------------------------ 生命周期 */

  open(room, me) {
    this._generation++;
    clearTimeout(this._syncTimer);
    this._latestRequest = null;
    this._syncedMessage = null;
    this._oldestMessage = null;
    this._filePositions.clear();
    this.room = room;
    this.me = me;
    this.seen.clear();
    this.oldestCursor = '';
    this.reachStart = false;
    this.loading = false;
    this.lastTs = 0;
    this.lastDayKey = '';
    this.unreadAnchor = null;
    this.atBottom = true;
    this._clear();
    $('blank').style.display = 'none';
    $('timeline').style.display = 'block';
    $('composer').style.display = 'block';
  },

  close() {
    this._generation++;
    clearTimeout(this._syncTimer);
    this.room = '';
    this._clear();
    $('blank').style.display = 'grid';
    $('timeline').style.display = 'none';
    $('composer').style.display = 'none';
    $('jump-btn').classList.remove('is-on');
  },

  /** 只清空消息，保留顶部的 hint 元素（它是翻页提示的挂载点） */
  _clear() {
    const inner = $('tl-inner');
    clearTimeout(this._noteTimer);
    inner
      .querySelectorAll('.msg, .tl-day, .tl-note, .tl-unread-divider, .tl-empty')
      .forEach((el) => {
        el.remove();
      });
    const hint = $('tl-hint');
    hint.style.display = 'none';
    hint.textContent = '';
  },

  /**
   * 临时系统提示（"正在进入…" / "拉取失败"等）。
   *
   * ⚠️ 之前每条 note 都永久留在时间线上，切几次房间就积出一堆
   * "正在进入「x」…/ 已进入「x」"，看起来像一堆假消息。
   * 现在 note 是**单例**：同一个 slot 复用，内容变了就替换，60 秒后自动淡出。
   */
  note(text, { sticky = false, kind = '', replace = false } = {}) {
    const inner = $('tl-inner');
    let el = inner.querySelector('.tl-note--live');
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'tl-note tl-note--live';
      inner.appendChild(el);
    }
    el.className = `tl-note tl-note--live${kind ? ` tl-note--${kind}` : ''}`;
    el.textContent = text;
    if (this.atBottom) this.scrollBottom();
    else if (!this._shouldStick()) $('jump-btn').classList.add('is-on');

    clearTimeout(this._noteTimer);
    // `replace`：把上一条"进行中"提示就地换掉（进房：正在进入 → 已进入），
    //   这样任何时刻最多只有一条系统提示，不会越积越多。
    if (!sticky) {
      this._noteTimer = setTimeout(() => el.remove(), 6000);
    }
  },

  /** 清掉临时提示（切房间时用） */
  clearNote() {
    clearTimeout(this._noteTimer);
    $('tl-inner').querySelector('.tl-note--live')?.remove();
  },

  /** 空房间提示（只有一条，且会随第一条消息到来自动消失） */
  _emptyState(on) {
    let el = $('tl-inner').querySelector('.tl-empty');
    if (!on) {
      el?.remove();
      return;
    }
    if (el) return;
    // ⚠️ 兜底自检：已经渲染出**内容**（消息 / 文件卡片 / 时间分隔线）就
    //    不能再摆一块"还没有人说话"。
    //
    // 为什么需要：`loadLatest()` 是异步的，而实时消息可能在它返回**之前**
    //    就到了 —— 于是"历史为空 ⇒ 显示空态"这个判断会晚一步执行，
    //    把已经显示出来的消息又盖上"还没有人说话"（实测踩到，而且是
    //    这轮给历史加了"房间快照"之后更明显：响应变慢，窗口更大）。
    //    判据直接看 DOM 事实，比维护计数器可靠。
    //
    // ⚠️ 但**不能**把 `.tl-note`（"正在进入房间…"这类系统提示）算成内容 ——
    //    进房时它一定存在，一算就把空态永久挡掉了（实测踩到）。
    if ($('tl-inner').querySelector('.msg, .tl-day')) return;
    el = document.createElement('div');
    el.className = 'tl-empty';
    el.innerHTML =
      '<div class="tl-empty__icon">💬</div>' +
      '<div class="tl-empty__title">还没有人说话</div>' +
      '<div class="tl-empty__sub">把房间名告诉对方，对方用同一个名字进来就能看到这里的消息</div>';
    $('tl-inner').insertBefore(el, $('tl-hint').nextSibling);
  },

  /* ------------------------------------------------------------------ 渲染 */

  /** 追加一条消息 */
  push(m, mine, isHistory = false) {
    if (store.isHidden(this.room, m.id)) return;
    if (m.id && this.seen.has(m.id)) return;
    if (m.id) this.seen.add(m.id);
    this._emptyState(false);   // 有消息了就把空态收掉
    if (!this._oldestMessage || compareMessages(m, this._oldestMessage) < 0) {
      this._oldestMessage = { ts: m.ts, id: m.id };
      this.oldestCursor = U.cursorOf(m);
    }

    // 「文件证明」：text 为空、带 file 字段的一条普通消息（发送方签名）。
    // 交给传输模块渲染成**文件卡片** —— 只有它知道"发送方此刻还在不在、
    // 还愿不愿意提供这个文件"，时间线不该重复实现这份判断。
    //
    // ⚠️ 仍然要推进"最新消息位置"，否则紧接着的那条文本消息会拿错误的
    //    时间基准去判断要不要插时间分隔线（会多插或漏插）。
    if (m.file) {
      this._filePositions.set(m.file.file_id, { ts: m.ts, id: m.id });
      this._emptyState(false);   // 文件卡片也是内容，空态该收
      bus.emit(EV.FILE_PROOF, { room: this.room, m, isHistory });
      const card = this._fileCardEl(m.file.file_id);
      if (card) this._insertMessage(card, m);
      return;
    }

    // 不在底部时收到实时消息 → 记下第一条，插"新消息"分隔线
    // ⚠️ 用 `atBottom`（用户意图，sticky），**不是**实时几何 ——
    //    静默重载历史时内容早就溢出了，用实时几何会判定"不在底部"，
    //    于是每条都不贴底，刷新后停在中间（实测踩过）。
    const wasAtBottom = this.atBottom;
    if (!isHistory && !mine && !wasAtBottom && !this.unreadAnchor) {
      this.unreadAnchor = m.id;
      const d = document.createElement('div');
      d.className = 'tl-unread-divider';
      d.textContent = '以下为新消息';
      $('tl-inner').appendChild(d);
    }

    this._insertMessage(this._bubble(m, mine, isHistory), m);

    // ⚠️ **前插历史（往上翻加载更早）时绝对不能滚动。**
    //    `prependPage` 靠插入前抓下的锚点（`_captureReadingPosition`）还原阅读位置，
    //    中途任何一次滚动都会让那个锚点失效 —— 位置会还原错，用户还会看到
    //    时间线剧烈跳一下再跳回来。
    //    ⚠️ 这个保护**只能放在这里**（跳过滚动）。曾经图省事在 `push()` 开头
    //    整段早返回，结果把 `m.file` 分支也跳过了 —— 文件消息被插成普通气泡，
    //    传输模块收不到 `EV.FILE_PROOF`，文件卡片永远不渲染（`multi-peer` 用例抓到）。
    if (this._prepending) return;
    if (wasAtBottom) this.scrollBottom();
    // 插完仍然贴底（比如插的是一条很短的旧消息）就不要亮按钮 ——
    // 之前是无条件点亮，于是每次静默同步「回到最新」都会冒出来。
    else if (!this._shouldStick()) $('jump-btn').classList.add('is-on');
  },

  /** 前插一页历史 */
  prependPage(list) {
    const anchor = this._captureReadingPosition();
    this._prepending = true;
    try {
      for (const m of list) {
        this.push(m, m.from === this.me, true);
      }
    } finally {
      this._prepending = false;
      this._restoreReadingPosition(anchor);
    }
  },

  _insertMessage(element, message) {
    const inner = $('tl-inner');
    const rows = [...inner.querySelectorAll('.msg[data-ts]')];
    const anchor = this._prepending ? null : this._captureReadingPosition();
    element.dataset.ts = String(message.ts);
    element.dataset.id = String(message.id || '');
    const next = rows.find((row) => row !== element && compareMessages(message, row.dataset) < 0);
    inner.insertBefore(element, next || null);
    inner.querySelectorAll('.tl-day').forEach((divider) => {
      divider.remove();
    });
    let previous = null;
    for (const row of inner.querySelectorAll('.msg[data-ts]')) {
      const timestamp = Number(row.dataset.ts);
      const dayKey = new Date(timestamp).toDateString();
      if (!previous || dayKey !== previous.dayKey || timestamp - previous.ts > GROUP_GAP) {
        const divider = document.createElement('div');
        divider.className = 'tl-day';
        divider.textContent = !previous || dayKey !== previous.dayKey ? U.dayLabel(timestamp) : U.clockTime(timestamp);
        inner.insertBefore(divider, row);
      }
      previous = { ts: timestamp, dayKey };
    }
    this.lastTs = previous?.ts || 0;
    this.lastDayKey = previous?.dayKey || '';
    this._restoreReadingPosition(anchor);
  },

  /** 文件邀约卡片：文件名 / 大小 / ✓ ✗ 按钮 / 进度条 */
  /**
   * 新建一张文件卡片。
   *
   * `avail` 只对历史文件卡片有意义（live / expired / unknown）——
   * 重建视图时（`rebuildCardsForRoom`）要把当前算出来的可用性一起带回来，
   * 否则重建出来的卡片会退回"未知"文案。
   */
  pushFileCard({ room = '', meta, direction, state = 'invited', done = 0, total = 0, error = '', avail, available = true, recipients = [], previewUrl, picking = false, pickerFailed = false, ts = meta.ts || Date.now() }) {
    if (store.isHidden(room || this.room, `file:${meta.file_id}`)) return;
    const key = `file:${room}:${meta.file_id}`;
    if (this.seen.has(key)) {
      const existing = this._fileCardEl(meta.file_id, room);
      if (!existing) return;
      this.updateFileCard({
        room,
        file_id: meta.file_id,
        state,
        done,
        total,
        error,
        avail,
        available,
        recipients,
        previewUrl,
      });
      return existing;
    }
    this.seen.add(key);

    const el = document.createElement('div');
    el.className = 'msg msg--file';
    if (direction === 'send') el.classList.add('msg--me');
    el.dataset.fileId = meta.file_id;
    if (room) el.dataset.room = room;
    // 记下方向：按钮要按方向给（接收卡片不能出现"重新发送"）
    el.dataset.dir = direction || '';
    el.dataset.available = String(available);
    // 正在等系统的「保存位置」对话框 —— 按钮要一直是禁用的（见 _fileActions）
    el.dataset.picking = String(!!picking);
    // 上次弹框失败过 → 卡片上给「直接下载」兜底入口
    el.dataset.pickerFailed = String(!!pickerFailed);
    el._recipients = recipients;
    // ⚠️ 重建视图时（rebuildCardsForRoom）要把 avail 落到 dataset 上，
    //    后续的 updateFileCard 才会沿用同一个值而不是退回"检查中…"。
    if (avail) el.dataset.avail = avail;
    const totalChunks = total || Math.ceil(meta.size / meta.chunk_size);
    // 初始进度：重建卡片时要能画回原来的百分比（复检 P3-6）。
    // 取整到 1 位小数，避免 done/total 极小时出现 33.333333%。
    const pct = totalChunks ? Math.round(((done || 0) / totalChunks) * 100) : state === 'done' ? 100 : 0;
    // 图片用缩略图卡片，普通文件用文件卡片 —— 视觉上和微信一致：
    // 图片消息看起来就是一张图，而不是"名字叫 xxx.png 的文件"
    const img = U.isImageName(meta.name.split('.').pop() || '') || (meta.mime || '').startsWith('image/');
    el.classList.toggle('msg--img', img);
    el.innerHTML = img
      ? `
      <div class="imgcard">
        <div class="imgcard__ph">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4.5" width="18" height="15" rx="2.5"/>
            <circle cx="8.5" cy="10" r="1.8"/>
            <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L15 16l2-2a2 2 0 0 1 2.8 0L21 15.2"/>
          </svg>
          <span class="imgcard__name">${U.esc(meta.name)}</span>
        </div>
        <div class="imgcard__bar"><i style="width:${pct}%"></i></div>
        <div class="imgcard__foot">
          <span class="filecard__state">${U.esc(this._fileStateText(state, error, { dir: direction || '', avail: avail || '', available, recipients, picking }))}</span>
          <span class="filecard__size">${U.humanSize(meta.size)}</span>
          <span class="imgcard__actions"></span>
        </div>
      </div>`
      : `
      <div class="filecard">
        <div class="filecard__icon">${U.fileIcon(meta.name)}</div>
        <div class="filecard__body">
          <div class="filecard__name">${U.esc(meta.name)}</div>
          <div class="filecard__meta">${U.humanSize(meta.size)} · ${
            direction === 'send' ? '我发送' : '对方发送'
          } · <span class="filecard__state">${U.esc(this._fileStateText(state, error, { dir: direction || '', avail: avail || '', available, recipients, picking }))}</span></div>
          <div class="filecard__bar"><i style="width:${pct}%"></i></div>
          ${error ? `<div class="filecard__err">${U.esc(error)}</div>` : ''}
        </div>
        <div class="filecard__actions"></div>
      </div>`;
    this._renderFileRecipients(el);
    this._fileActions(el, state);
    this._previewImage(el, previewUrl);
    this._insertMessage(el, this._filePositions.get(meta.file_id) || { ts, id: key });
    this._emptyState(false);
    if (this.atBottom) this.scrollBottom();
    return el;
  },

  /** 按 file_id 和当前房间查找卡片，不把对端输入拼进选择器。 */
  _fileCardEl(file_id, room = this.room) {
    return [...$('tl-inner').querySelectorAll('.msg--file')].find(
      (el) => el.dataset.fileId === String(file_id) && (!room || el.dataset.room === room),
    );
  },

  /** 更新卡片状态/进度 */
  updateFileCard({ room, file_id, state, done, total, bytes, error, avail, available, recipients, previewUrl, picking, pickerFailed }) {
    // ⚠️ `file_id` 是**对端自选**的字符串（只过签名、不看格式）。
    //    直接拼进选择器的话，一个 `a"]` 就能让 querySelector 抛 SyntaxError，
    //    而 bus 对监听器有 try/catch 包着 → **异常被吞、进度从此不再更新**（P3-15）。
    //    `CSS.escape` 是标准做法；配合 Rust 侧 validate_meta 的字符集限制，双保险。
    const el = this._fileCardEl(file_id);
    if (!el) return;
    if (room && el.dataset.room && el.dataset.room !== room) return;
    if (available !== undefined) el.dataset.available = String(available);
    if (recipients !== undefined) el._recipients = recipients;
    if (avail !== undefined) {
      if (avail) el.dataset.avail = avail;
      else delete el.dataset.avail;
    }
    // ⚠️ `picking` 必须落到 dataset 上：任何一次卡片重绘都会重建按钮，
    //    而重建出来的按钮**不带 disabled** —— 这正是"变灰 → 再点报
    //    File picker already active"的成因。状态放在 dataset 上才扛得住重绘。
    if (picking !== undefined) el.dataset.picking = String(!!picking);
    if (pickerFailed !== undefined) el.dataset.pickerFailed = String(!!pickerFailed);
    const st = el.querySelector('.filecard__state');
    if (st)
      st.textContent = this._fileStateText(state, error, {
        recipients: el._recipients || [],
        available: el.dataset.available !== 'false',
        dir: el.dataset.dir,
        avail: avail || el.dataset.avail || '',
        picking: el.dataset.picking === 'true',
      });
    const bar = el.querySelector('.filecard__bar i, .imgcard__bar i');
    if (bar) {
      if (total) bar.style.width = `${Math.round((done / total) * 100)}%`;
      else if (state === 'done') bar.style.width = '100%';
    }
    if (error) {
      let e = el.querySelector('.filecard__err');
      if (!e) {
        e = document.createElement('div');
        e.className = 'filecard__err';
        (el.querySelector('.filecard__body') || el.querySelector('.imgcard'))?.appendChild(e);
      }
      e.textContent = error;
    } else if (error === '') {
      el.querySelector('.filecard__err')?.remove();
    }
    const m = el.querySelector('.filecard__meta');
    if (m && total) m.title = `${done}/${total} 块${bytes ? `（${U.humanSize(bytes)}）` : ''}`;
    const sz = el.querySelector('.filecard__size');
    if (sz && bytes && el.dataset.dir !== 'send') sz.textContent = U.humanSize(bytes);
    this._renderFileRecipients(el);
    this._fileActions(el, state);
    this._previewImage(el, previewUrl);
  },

  _previewImage(el, url) {
    const placeholder = el.querySelector('.imgcard__ph');
    if (placeholder && url === null) {
      placeholder.classList.remove('has-preview');
      placeholder.textContent = '图片预览已释放，文件仍保存在本地';
      return;
    }
    if (!placeholder || !url || !url.startsWith('blob:')) return;
    if (placeholder.querySelector('img')?.src === url) return;
    const image = document.createElement('img');
    image.src = url;
    image.alt = '本地图片预览，点击放大';
    image.loading = 'lazy';
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('aria-label', '放大图片');
    open.append(image);
    open.onclick = () => this.viewImage(url);
    placeholder.replaceChildren(open);
    placeholder.classList.add('has-preview');
  },

  _renderFileRecipients(el) {
    if (el.dataset.dir !== 'send') return;
    const recipients = el._recipients || [];
    let details = el.querySelector('.filecard__recipients');
    if (!recipients.length) {
      details?.remove();
      return;
    }
    if (!details) {
      details = document.createElement('details');
      details.className = 'filecard__recipients';
      details.innerHTML = '<summary></summary><div class="filecard__recipient-list"></div>';
      (el.querySelector('.filecard__body') || el.querySelector('.imgcard'))?.appendChild(details);
    }
    details.querySelector('summary').textContent = `接收详情（${recipients.length} 人）`;
    const rows = recipients.map((recipient) => {
      const row = document.createElement('div');
      row.className = 'filecard__recipient';
      row.dataset.peer = recipient.id;
      row.dataset.state = recipient.state;
      const percent = recipient.total > 0 ? Math.min(100, Math.max(0, Math.round(recipient.done / recipient.total * 100))) : 0;
      const status = {
        waiting: '等待接收',
        sending: percent === 100 ? '等待确认' : `接收中 ${percent}%`,
        done: '✓ 已接收',
        rejected: '— 已拒绝',
        cancelled: '— 已取消',
        failed: '接收失败',
      }[recipient.state] || '等待接收';
      const name = recipient.nickname ? `${recipient.nickname} · ${String(recipient.id).slice(0, 6)}` : `用户 ${String(recipient.id).slice(0, 8)}`;
      row.innerHTML = `<div class="filecard__recipient-head"><span class="filecard__recipient-name" title="${U.esc(`${name} · ${recipient.id}`)}">${U.esc(name)}</span><span class="filecard__recipient-state">${U.esc(status)}</span></div>`;
      if (recipient.state === 'sending') {
        const progress = document.createElement('progress');
        progress.max = Math.max(1, recipient.total);
        progress.value = recipient.done;
        progress.setAttribute('aria-label', `${name} 的接收进度`);
        row.append(progress);
      }
      if (recipient.error && (recipient.state === 'failed' || recipient.state === 'cancelled')) {
        const note = document.createElement('div');
        note.className = 'filecard__recipient-note';
        note.textContent = recipient.error;
        row.append(note);
      }
      return row;
    });
    details.querySelector('.filecard__recipient-list').replaceChildren(...rows);
  },

  /**
   * 状态文案。
   * `info` 带上多人汇总时，文案要说清"几人收到/几人没收完" ——
   * 一份文件发给多个人时，"已完成"到底指谁完成，必须让用户看得明白。
   */
  _fileStateText(state, error, info = {}) {
    const { dir = '', avail = '', available = true, recipients = [], picking = false } = info;
    if (dir === 'send') {
      const labels = [available ? '已分享' : '已停止分享'];
      for (const [recipientState, label] of [
        ['done', '接收完成'], ['sending', '接收中'], ['waiting', '等待接收'],
        ['rejected', '拒绝接收'], ['cancelled', '取消接收'], ['failed', '接收失败'],
      ]) {
        const count = recipients.filter((recipient) => recipient.state === recipientState).length;
        if (count) labels.push(`${count} 人${label}`);
      }
      if (available && !recipients.some((recipient) => ['done', 'sending', 'waiting'].includes(recipient.state))) {
        labels.push('等待接收');
      }
      return labels.join(' · ');
    }
    // 历史里的文件：能不能收取决于**发送方此刻的状态**（派生，不是缓存的状态）
    if (state === 'archived') {
      if (avail === 'live') return '可接收（发送方在线）';
      if (avail === 'unknown') return '检查中…';
      return '已过期（发送方已离开）';
    }
    if (state === 'asking') return '正在联系发送方…';
    // 系统保存对话框已经弹出、还没选完 —— 让用户知道"在等的是你"，而不是卡死
    if (state === 'invited' && picking) return '等待你选择保存位置…';
    const base = {
      invited: '等待你确认',
      // 刷新页面后恢复出来的"没收完"的接收
      interrupted: '接收中断（可继续）',
      pending: '等待对方确认',
      active: '传输中',
      // 发送端专属：数据已全部发出，正在等接收方校验回执。
      // 与「传输中」分开，避免大文件在"已发完但对方还在校验"的空窗期看起来像卡住。
      sent: '已发送，等待对方确认',
      // 传输被中断（网络断了 / 对方离开），已收部分保留，可续传
      paused: '已暂停（可续传）',
      done: '已完成',
      rejected: '已拒绝',
      cancelled: '已取消保存（可重新接收）',
      expired: '已失效',
    }[state];
    if (state === 'failed') {
      return `失败${error ? `：${error}` : ''}`;
    }
    if (base) return base;
    return state;
  },

  /**
   * 卡片上的按钮：
   * - `invited`（我是接收方，等确认）→ ✓ / ✗
   * - `failed` / `expired`（我是发送方，对方断了或没响应）→ **重新发送**
   *
   * 「重新发送」存在的意义：传输中途对方刷新页面／断网时，发送端会失败，
   * 但已选的 **File 还在内存里**（Worker 的 outFiles 也留着），
   * 所以不必让用户重新选文件 —— 直接重发邀约即可，对方接受后会**断点续传**。
   */
  _fileActions(el, state) {
    const box = el.querySelector('.filecard__actions') || el.querySelector('.imgcard__actions');
    if (!box) return;
    box.innerHTML = '';
    const fileId = el.dataset.fileId;

    // 图片卡片的按钮在底部行里，用文字更省空间；文件卡片用圆钮
    const compact = box.classList.contains('imgcard__actions');
    if (el.dataset.dir === 'send') {
      if (el.dataset.available === 'false') return;
      if (!(el._recipients || []).some((recipient) => ['failed', 'cancelled'].includes(recipient.state))) return;
      const invite = document.createElement('button');
      invite.className = compact ? 'btn-ghost' : 'filecard__btn is-again';
      invite.title = '重新邀请未完成的接收者（不打扰已接收或拒绝的人）';
      invite.textContent = compact ? '重新邀请' : '↻';
      invite.onclick = () => {
        invite.disabled = true;
        bus.emit(EV.FILE_RESEND, { file_id: fileId });
      };
      box.append(invite);
      return;
    }
    if (typeof window.showSaveFilePicker !== 'function' && ['invited', 'interrupted', 'paused', 'cancelled', 'archived'].includes(state)) {
      const notice = document.createElement('span');
      notice.className = 'filecard__err';
      notice.textContent = '接收需 Chrome / Edge';
      const reject = document.createElement('button');
      reject.className = 'btn-ghost';
      reject.textContent = state === 'invited' ? '拒绝' : '移除';
      reject.onclick = () => bus.emit(state === 'invited' ? EV.FILE_REJECT : EV.FILE_DISMISS, { file_id: fileId });
      box.append(notice, reject);
      return;
    }

    // 刷新后恢复的"未完成接收" → 给一个「继续接收」
    //
    // ⚠️ `paused`（传输中途被打断/用户主动停下）是**同一件事的另一个来源**：
    //    文案已经写着"已暂停（可续传）"，如果不给按钮，这句承诺就是空的（F16）。
    if (state === 'interrupted' || state === 'paused' || state === 'cancelled') {
      const go = document.createElement('button');
      go.className = compact ? 'btn-primary' : 'filecard__btn is-yes';
      go.title = '继续接收（会从断点续传）';
      go.textContent = compact ? '继续接收' : '↻';
      go.onclick = () => {
        go.disabled = true;
        // reuseHandle：复用上次选的保存位置，不再弹一次对话框
        bus.emit(EV.FILE_ACCEPT, { file_id: fileId, reuseHandle: true });
      };
      box.append(go);
      return;
    }

    // 接收进行中 → 必须给一个「取消」入口（F16）。
    //
    // 没有它的后果实测过：Accept 发进了错误的房间（F13 修好之前）时，
    // 接收侧会**永久**停在"传输中 0%"，而卡片上一个按钮都没有，
    // 用户只能刷新页面。Rust 侧现在有停顿超时兜底，但用户也该能主动停。
    if (state === 'active') {
      if (el.dataset.dir === 'recv') {
        const stop = document.createElement('button');
        stop.className = compact ? 'btn-ghost' : 'filecard__btn is-no';
        stop.title = '停止接收（已收内容会保留，之后可以继续）';
        stop.textContent = compact ? '停止' : '✗';
        stop.onclick = () => {
          stop.disabled = true;
          bus.emit(EV.FILE_CANCEL, { file_id: fileId });
        };
        box.append(stop);
      }
      return;
    }

    // 历史文件卡片：只有"发送方此刻还能提供"时才给「接收」。
    // 点它 = 请对方重发一次邀约（我们手上没有 root_hash/chunk_size，开不了传输）。
    if (state === 'archived') {
      const avail = el.dataset.avail || '';
      if (avail === 'live') {
        const get = document.createElement('button');
        get.className = 'filecard__btn is-yes';
        get.title = '接收（会让发送方重新发一份邀约）';
        get.textContent = '✓';
        get.onclick = () => {
          get.disabled = true;
          bus.emit(EV.FILE_OPEN, { file_id: fileId });
        };
        box.append(get);
      } else if (avail === 'expired') {
        const drop = document.createElement('button');
        drop.className = 'filecard__btn is-no';
        drop.title = '移除这条记录';
        drop.textContent = '✗';
        drop.onclick = () => bus.emit(EV.FILE_DISMISS, { file_id: fileId });
        box.append(drop);
      }
      return;
    }
    if (state === 'asking') return;   // 正在等对方响应，先不给按钮

    if (state === 'invited') {
      const picking = el.dataset.picking === 'true';
      const yes = document.createElement('button');
      yes.className = compact ? 'btn-primary' : 'filecard__btn is-yes';
      yes.title = '接收（会弹出保存位置）';
      yes.textContent = compact ? '接收' : '✓';
      const no = document.createElement('button');
      no.className = compact ? 'btn-ghost' : 'filecard__btn is-no';
      no.title = '拒绝';
      no.textContent = compact ? '拒绝' : '✗';
      if (picking) {
        // ⚠️ 按钮的禁用必须**从状态派生**，不能只靠 onclick 里那一句
        //    `yes.disabled = true`：卡片重绘会重建按钮，把 disabled 丢掉，
        //    用户于是能在"对话框已经开着"的情况下再点一次，撞出
        //    `File picker already active`（实测到的就是这个现象）。
        yes.disabled = true;
        yes.title = '等待选择保存位置…（对话框可能在浏览器其他窗口后面）';
      } else {
        yes.onclick = () => {
          yes.disabled = no.disabled = true;
          bus.emit(EV.FILE_ACCEPT, { file_id: fileId });
        };
      }
      // ✗ 始终可用：对话框挂住时也要能退出，不能把用户困在"只能干等"
      no.onclick = () => {
        yes.disabled = no.disabled = true;
        bus.emit(EV.FILE_REJECT, { file_id: fileId });
      };
      box.append(yes, no);
      // 兜底入口：对话框挂着、或上次弹框失败过 → 给一条不依赖系统对话框的路
      if (picking || el.dataset.pickerFailed === 'true') {
        const alt = document.createElement('button');
        alt.className = 'btn-ghost';
        alt.title = '不用系统「保存位置」对话框：收完后走浏览器普通下载';
        alt.textContent = '直接下载';
        alt.onclick = () => {
          alt.disabled = true;
          bus.emit(EV.FILE_FALLBACK, { file_id: fileId });
        };
        box.append(alt);
      }
      return;
    }

    if (state === 'failed' || state === 'expired') {
      const drop = document.createElement('button');
      drop.className = 'filecard__btn is-no';
      drop.title = '移除这条记录';
      drop.textContent = '✗';
      drop.onclick = () => bus.emit(EV.FILE_DISMISS, { file_id: fileId });
      box.append(drop);
    }
  },

  /** 把一张文件卡片从时间线上摘掉（用于"移除已失效的接收记录"） */
  removeFileCard(file_id) {
    const el = this._fileCardEl(file_id, this.room);
    if (el) el.remove();
    this.seen.delete(`file:${this.room}:${file_id}`);
  },

  /**
   * 发送失败的气泡。
   *
   * 之前失败只弹一条 tip，消息直接消失 —— 用户既看不到自己发过什么，
   * 也没法重发。微信的做法是保留这条消息并标红，所以这里补上，
   * 同时给一个「重发」按钮（文案还留在气泡里，重发不需要回忆）。
   */
  pushFailed(text, reason = '', failed = {}) {
    const mine = this.me;
    const el = document.createElement('div');
    el.className = 'msg msg--me msg--failed';
    el.innerHTML =
      avatar(mine) +
      `<div class="msg__body">
         <div class="msg__meta">
           <span class="msg__time">${U.clockTime(Date.now())}</span>
           <span class="msg__failedtag">发送失败</span>
         </div>
         <div class="bubble"></div>
         <div class="msg__retry">
           <button class="link-btn">重新发送</button>
           <button class="link-btn">删除</button>
         </div>
       </div>`;
    this._fillBubble(el.querySelector('.bubble'), text);
    if (reason) {
      const r = document.createElement('div');
      r.className = 'msg__failedreason';
      r.textContent = reason;
      el.querySelector('.msg__body').appendChild(r);
    }
    const [again, drop] = el.querySelectorAll('.msg__retry .link-btn');
    again.onclick = () => bus.emit(EV.RETRY_SEND, { text, el });
    drop.onclick = () => el.remove();
    $('tl-inner').appendChild(el);
    this.scrollBottom();
    failed.el = el;      // 回传引用，供"重发成功后撤掉这条"用
    return el;
  },

  _bubble(m, mine, isHistory) {
    const el = document.createElement('div');
    el.className = `msg${mine ? ' msg--me' : ''}${isHistory ? ' msg--hist' : ''}`;
    el.dataset.id = m.id || '';
    // 微信的排版：头像在左（自己则在右），昵称与时间在气泡**上方**，
    // 且**只在收到消息时**显示昵称（自己发的没必要重复写自己名字）。
    el.innerHTML =
      avatar(m.nickname) +
      `<div class="msg__body">
         <div class="msg__meta">${
           mine
             ? `<span class="msg__time">${U.clockTime(m.ts)}</span>`
             : `${U.esc(m.nickname)}<span class="msg__time">${U.clockTime(m.ts)}</span>`
         }</div>
         <div class="bubble"></div>
       </div>`;
    this._fillBubble(el.querySelector('.bubble'), m.text);

    // 右键菜单：复制（文本消息）/ 删除本地
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [];
      if (m.text && !/^\[img\]/.test(m.text)) {
        items.push({ label: '复制', fn: () => navigator.clipboard?.writeText(m.text) });
      }
      items.push({ label: '删除（仅本地）', danger: true, fn: () => { store.hideMessage(el.dataset.room || this.room, m.id); el.remove(); } });
      this._contextMenu(e.clientX, e.clientY, items);
    });
    return el;
  },

  /** 极简右键菜单（只在需要时创建一个，避免每行都挂 DOM） */
  _contextMenu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.classList.add('is-danger');
      b.onclick = () => {
        it.fn();
        menu.remove();
      };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    // 贴边修正
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  },

  /** 内联格式：`[img]data:...[/img]` 渲染成图片，其余按纯文本（旧消息兼容） */
  _fillBubble(box, text) {
    const m = /^\[img\]([\s\S]+?)\[\/img\]\n?([\s\S]*)$/.exec(text || '');
    if (!m) {
      box.textContent = text || '';
      return;
    }
    // ⚠️ `[img]` 里的地址是**对端可控**的（composer 早就不再产生这种消息了，
    //    所以任何 `[img]` 都是手工构造的）。放任任意 URL 会让房间里每个客户端
    //    在气泡进入视口时向攻击者服务器发起请求：泄露 IP/在线时间/房间归属，
    //    还能拿 `http://127.0.0.1:...` 做内网盲探测（F14）。
    //    所以白名单只放 `data:image/*` 与 `blob:`（旧消息用的就是这两种）。
    const src = String(m[1] || '').trim();
    const allowed = /^data:image\//i.test(src) || /^blob:/i.test(src);
    if (!allowed) {
      const blocked = document.createElement('div');
      blocked.className = 'bubble__blocked';
      blocked.textContent = '已阻止一张外部图片（可能用于追踪）';
      box.appendChild(blocked);
      if (m[2]) {
        const cap = document.createElement('div');
        cap.style.marginTop = '4px';
        cap.textContent = m[2];
        box.appendChild(cap);
      }
      return;
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = '图片';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onclick = () => this.viewImage(src); // 内部查看器，不再开新标签（src 已白名单校验）
    box.appendChild(img);
    if (m[2]) {
      const cap = document.createElement('div');
      cap.style.marginTop = '4px';
      cap.textContent = m[2];
      box.appendChild(cap);
    }
  },

  /** 点图片放大：全屏遮罩，点任意处关闭（微信的行为） */
  viewImage(src) {
    let box = document.querySelector('.lightbox');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lightbox';
      box.innerHTML = '<img alt="" />';
      document.body.appendChild(box);
      box.onclick = () => box.classList.remove('is-on');
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') box.classList.remove('is-on');
      });
    }
    box.querySelector('img').src = src;
    box.classList.add('is-on');
  },

  /* ------------------------------------------------------------------ 滚动 */

  _captureReadingPosition() {
    if (this.atBottom) return null;
    const viewport = $('timeline');
    const bounds = viewport.getBoundingClientRect();
    const visible = [...$('tl-inner').querySelectorAll('.msg[data-ts]')].filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const element = visible.find(row => row.getBoundingClientRect().top >= bounds.top) || visible[0];
    return element ? { element, offset: element.getBoundingClientRect().top - bounds.top } : null;
  },

  _restoreReadingPosition(anchor) {
    if (!anchor?.element.isConnected) return;
    const viewport = $('timeline');
    viewport.scrollTop += anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  },

  scrollBottom() {
    this._pin();
    this.unreadAnchor = null;
    // ⚠️ 顺带把"以下为新消息"分隔线摘掉（复检 P3-8）：
    //    原来只清了锚点，那条线会**一直留在会话中间**直到切房间。
    $('tl-inner').querySelector('.tl-unread-divider')?.remove();
    $('jump-btn').classList.remove('is-on');

    // 布局常常要到下一两帧才稳定（图片解码、字体替换），
    // 只滚这一次会差那么十几二十像素 —— 视觉上就是"最后一条被输入区压住一半"。
    // 所以再补钉几帧；中途用户往上翻了就立刻停。
    let frames = 0;
    const settle = () => {
      const el = $('timeline');
      if (frames++ >= 3 || !this.atBottom) return;
      if (el.scrollHeight - el.clientHeight - el.scrollTop <= 2) return;
      el.scrollTop = el.scrollHeight;
      if (frames < 3) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  },

  /** 顶部翻页 */
  async loadOlder() {
    if (this.loading || this.reachStart || !this.room || !this.oldestCursor) return;
    this.loading = true;
    const hint = $('tl-hint');
    const initialAnchor = this._captureReadingPosition();
    hint.style.display = 'block';
    hint.textContent = '正在加载更早的消息…';
    this._restoreReadingPosition(initialAnchor);
    const generation = this._generation;
    let responseAnchor;
    try {
      const room = this.room;
      const list = await net.history(room, PAGE, this.oldestCursor);
      if (this._generation !== generation) return;
      responseAnchor = this._captureReadingPosition();
      if (!list.length) {
        this.reachStart = true;
        hint.textContent = '没有更早的消息了';
        setTimeout(() => {
          if (this._generation !== generation) return;
          const anchor = this._captureReadingPosition();
          hint.style.display = 'none';
          this._restoreReadingPosition(anchor);
        }, 1500);
      } else {
        const cursorBefore = this.oldestCursor;
        this.prependPage(list);
        hint.style.display = 'none';
        // 这一页**全是被去重掉的老消息**
        // （锚点视图与本地游标不一致时会发生），此时游标没有前进 ——
        // 再滚一次还是同一页，用户就永远卡在顶部转圈（复检 P3-9）。
        // 判据直接看**游标有没有前进**，而不是看这页几条。
        if (this.oldestCursor === cursorBefore) {
          this.reachStart = true;
        }
      }
    } catch (e) {
      if (this._generation !== generation) return;
      responseAnchor = this._captureReadingPosition();
      hint.textContent = `加载失败：${e?.message ?? e}（滚动可重试）`;
    } finally {
      if (this._generation === generation) {
        this._restoreReadingPosition(responseAnchor);
        this.loading = false;
      }
    }
  },

  /** 首次进房：拉最新一页 */
  _scheduleSync(delay = SYNC_INTERVAL) {
    clearTimeout(this._syncTimer);
    if (!this.room || !net.config?.anchor?.id) return;
    this._syncTimer = setTimeout(() => {
      if (net.canSend && net._room === this.room && !this.loading) this.loadLatest({ silent: true });
      else this._scheduleSync();
    }, delay);
  },

  async loadLatest({ silent = false } = {}) {
    if (!this.room) return;
    if (this._latestRequest?.generation === this._generation) return this._latestRequest.promise;
    const generation = this._generation;
    const promise = this._loadLatest(this.room, generation, silent);
    this._latestRequest = { generation, promise };
    try {
      return await promise;
    } finally {
      if (generation === this._generation) {
        this._latestRequest = null;
        this._scheduleSync();
      }
    }
  },

  async _loadLatest(room, generation, silent) {
    const hint = $('tl-hint');
    try {
      const previous = this._syncedMessage;
      let before = '';
      let newest = null;
      do {
        const list = await net.history(room, PAGE, before);
        if (this._generation !== generation) return;
        if (!before) newest = list[list.length - 1] || null;
        this.prependPage(list);
        if (!before) bus.emit(EV.HISTORY, { room, messages: list, me: this.me });
        if (!list.length) {
          if (!previous && !before) this.reachStart = true;
          break;
        }
        if (!previous || compareMessages(list[0], previous) <= 0) break;
        const next = U.cursorOf(list[0]);
        if (next === before) throw new Error('历史分页游标未推进');
        before = next;
      // ⚠️ 这里的 `while (before)` 就是"恒真"—— 写成 `while (true)` 会被
      //    linter 报 noConstantCondition。语义完全一致：`before` 初值是空串，
      //    而 do-while 保证第一轮必然执行，之后每轮都被赋成非空游标。
      //    退出靠上面三个 break（空页 /追上了 / 游标不推进就抛）。
      } while (before);
      if (newest) this._syncedMessage = { ts: newest.ts, id: newest.id };
      // 历史为空**并且**期间没有实时消息到达，才认为房间是空的。
      // （实时消息可能是"进房的瞬间对方刚发的"，这时它不在历史里？其实在，
      //   但历史响应可能更早/更晚返回，所以两条路都要看一眼。）
      const hasLive = !!$('tl-inner').querySelector('.msg');
      this._emptyState(!newest && !hasLive);
      if (!this.loading) {
        hint.style.display = 'none';
        hint.textContent = '';
      }
      // 静默同步同样要按**用户意图**贴底：刷新后页面一可见就会静默重载一次，
      // 用实时几何判断会让这次重载把时间线晾在中间。
      if (!silent || this.atBottom) this.scrollBottom();
    } catch (e) {
      if (this._generation !== generation) return;
      if (silent && this._syncedMessage) return;
      // 历史拉不到 ≠ 房间坏了：消息仍能实时收发，所以给一个可重试的提示而不是死掉
      this._emptyState(false);
      hint.style.display = 'block';
      hint.innerHTML =
        `<span>历史消息加载失败：${U.esc(e?.message ?? e)}</span> ` +
        `<button class="link-btn" id="tl-retry">重试</button>`;
      hint.querySelector('#tl-retry').onclick = () => {
        hint.style.display = 'none';
        this.loadLatest();
      };
      if (!silent) bus.emit(EV.TIP, `拉取历史失败：${e?.message ?? e}`);
    }
  },
};
