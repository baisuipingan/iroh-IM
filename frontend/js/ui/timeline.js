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
import { avatar } from './sidebar.js';
import * as U from '../util.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;              // 每次翻页条数
const GROUP_GAP = 5 * 60e3;   // 同一天内超过 5 分钟插一条时刻分隔

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

  init() {
    $('timeline').addEventListener('scroll', () => {
      const el = $('timeline');
      this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      $('jump-btn').classList.toggle('is-on', !this.atBottom);
      if (el.scrollTop < 40) this.loadOlder();
    });
    $('jump-btn').onclick = () => this.scrollBottom();

    // composer 高度会随待发送区/多行输入变化，"回到最新"要跟着上移。
    // 用 ResizeObserver 而不是写死数值 —— 之前写死 152px，附件一展开就压住输入框。
    const cp = $('composer');
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this.syncJumpBtn()).observe(cp);
    } else {
      addEventListener('resize', () => this.syncJumpBtn());
    }
    this.syncJumpBtn();

    bus.on(EV.MSG, ({ room, message, mine, isHistory }) => {
      if (room !== this.room) return;
      this.push(message, mine, isHistory);
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
      .forEach((el) => el.remove());
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
    else $('jump-btn').classList.add('is-on');

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
    if (m.id && this.seen.has(m.id)) return;
    if (m.id) this.seen.add(m.id);
    this._emptyState(false);   // 有消息了就把空态收掉

    // 「文件证明」：text 为空、带 file 字段的一条普通消息（发送方签名）。
    // 交给传输模块渲染成**文件卡片** —— 只有它知道"发送方此刻还在不在、
    // 还愿不愿意提供这个文件"，时间线不该重复实现这份判断。
    //
    // ⚠️ 仍然要推进"最新消息位置"，否则紧接着的那条文本消息会拿错误的
    //    时间基准去判断要不要插时间分隔线（会多插或漏插）。
    if (m.file) {
      this.lastDayKey = new Date(m.ts).toDateString();
      this.lastTs = m.ts;
      this._emptyState(false);   // 文件卡片也是内容，空态该收
      bus.emit(EV.FILE_PROOF, { room: this.room, m });
      return;
    }

    const dayKey = new Date(m.ts).toDateString();
    if (dayKey !== this.lastDayKey || m.ts - this.lastTs > GROUP_GAP) {
      this._divider(dayKey !== this.lastDayKey ? U.dayLabel(m.ts) : U.clockTime(m.ts));
      this.lastDayKey = dayKey;
    }
    this.lastTs = Math.max(this.lastTs, m.ts);

    // 不在底部时收到实时消息 → 记下第一条，插"新消息"分隔线
    const wasAtBottom = this.atBottom;
    if (!isHistory && !mine && !wasAtBottom && !this.unreadAnchor) {
      this.unreadAnchor = m.id;
      const d = document.createElement('div');
      d.className = 'tl-unread-divider';
      d.textContent = '以下为新消息';
      $('tl-inner').appendChild(d);
    }

    $('tl-inner').appendChild(this._bubble(m, mine, isHistory));

    if (wasAtBottom) this.scrollBottom();
    else $('jump-btn').classList.add('is-on');
  },

  /** 前插一页历史 */
  prependPage(list) {
    const el = $('timeline');
    const prevHeight = el.scrollHeight;
    const frag = document.createDocumentFragment();

    // ⚠️ 分隔线状态必须**先存后还原**。
    // lastDayKey / lastTs 描述的是"当前视口里最新那条消息的位置"。
    // 前插的是**更早**的消息，直接顺着遍历覆盖这两个值的话，
    // 遍历结束后它们会停在"本页最后一条"（即整段里最老的一条），
    // 于是接下来收到的新消息会拿一个错误的时间基准去判断要不要插分隔线。
    const savedKey = this.lastDayKey;
    const savedTs = this.lastTs;

    for (const m of list) {
      if (m.id && this.seen.has(m.id)) continue;
      if (m.id) this.seen.add(m.id);
      const dayKey = new Date(m.ts).toDateString();
      // 历史页内部也要按时钟分组，否则一口气 50 条全挤在一起没有时间参照
      if (dayKey !== this.lastDayKey || (this.lastTs && m.ts - this.lastTs > GROUP_GAP)) {
        const d = document.createElement('div');
        d.className = 'tl-day';
        d.textContent =
          dayKey !== this.lastDayKey && this.lastTs ? U.dayLabel(m.ts) : U.clockTime(m.ts);
        frag.appendChild(d);
        this.lastDayKey = dayKey;
      }
      frag.appendChild(this._bubble(m, m.from === this.me, true));
      this.lastTs = this.lastTs ? Math.min(this.lastTs, m.ts) : m.ts;
      // ⚠️ 用 (ts, id) 比大小，不能只比 ts —— 同毫秒消息的先后是 id 决定的。
      //    只比 ts 时，先渲染的那条可能不是真正最早的那条，游标就会落在
      //    页面中间，下一页把边界消息跳过去了。
      if (!this.oldestCursor || U.cursorOf(m) < this.oldestCursor) {
        this.oldestCursor = U.cursorOf(m);
      }
    }

    this.lastDayKey = savedKey;
    this.lastTs = savedTs;

    // 插在 hint 之后（hint 始终在最上面）
    $('tl-inner').insertBefore(frag, $('tl-hint').nextSibling);
    // 保持视口：高度差补回 scrollTop
    el.scrollTop += el.scrollHeight - prevHeight;
  },

  _divider(text) {
    const el = document.createElement('div');
    el.className = 'tl-day';
    el.textContent = text;
    $('tl-inner').appendChild(el);
  },

  /** 文件邀约卡片：文件名 / 大小 / ✓ ✗ 按钮 / 进度条 */
  /**
   * 新建一张文件卡片。
   *
   * `avail` 只对历史文件卡片有意义（live / expired / unknown）——
   * 重建视图时（`rebuildCardsForRoom`）要把当前算出来的可用性一起带回来，
   * 否则重建出来的卡片会退回"未知"文案。
   */
  pushFileCard({ room = '', meta, direction, state = 'invited', done = 0, total = 0, error = '', avail }) {
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
      });
      return existing;
    }
    this.seen.add(key);

    const el = document.createElement('div');
    el.className = 'msg msg--file';
    el.dataset.fileId = meta.file_id;
    if (room) el.dataset.room = room;
    // 记下方向：按钮要按方向给（接收卡片不能出现"重新发送"）
    el.dataset.dir = direction || '';
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
          <span class="filecard__state">${U.esc(this._fileStateText(state, error, { dir: direction || '', avail: avail || '' }))}</span>
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
          } · <span class="filecard__state">${U.esc(this._fileStateText(state, error, { dir: direction || '', avail: avail || '' }))}</span></div>
          <div class="filecard__bar"><i style="width:${pct}%"></i></div>
          ${error ? `<div class="filecard__err">${U.esc(error)}</div>` : ''}
        </div>
        <div class="filecard__actions"></div>
      </div>`;
    this._fileActions(el, state);
    $('tl-inner').appendChild(el);
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
  updateFileCard({ room, file_id, state, done, total, bytes, error, peers, peersDone, peersFailed, avail }) {
    // ⚠️ `file_id` 是**对端自选**的字符串（只过签名、不看格式）。
    //    直接拼进选择器的话，一个 `a"]` 就能让 querySelector 抛 SyntaxError，
    //    而 bus 对监听器有 try/catch 包着 → **异常被吞、进度从此不再更新**（P3-15）。
    //    `CSS.escape` 是标准做法；配合 Rust 侧 validate_meta 的字符集限制，双保险。
    const el = this._fileCardEl(file_id);
    if (!el) return;
    if (room && el.dataset.room && el.dataset.room !== room) return;
    if (avail !== undefined) {
      if (avail) el.dataset.avail = avail;
      else delete el.dataset.avail;
    }
    const st = el.querySelector('.filecard__state');
    if (st)
      st.textContent = this._fileStateText(state, error, {
        peers,
        peersDone,
        peersFailed,
        dir: el.dataset.dir,
        avail: avail || el.dataset.avail || '',
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
    // 多人汇总：把"已送达 N/M 人"补进 meta 行
    if (m && peers > 1) {
      let s = el.querySelector('.filecard__peers');
      if (!s) {
        s = document.createElement('span');
        s.className = 'filecard__peers';
        m.appendChild(s);
      }
      s.textContent = ` · 已送达 ${peersDone}/${peers} 人`;
    }
    const sz = el.querySelector('.filecard__size');
    if (sz && bytes) sz.textContent = U.humanSize(bytes);
    this._fileActions(el, state);
  },

  /**
   * 状态文案。
   * `info` 带上多人汇总时，文案要说清"几人收到/几人没收完" ——
   * 一份文件发给多个人时，"已完成"到底指谁完成，必须让用户看得明白。
   */
  _fileStateText(state, error, info = {}) {
    const { peers = 0, peersDone = 0, peersFailed = 0, dir = '', avail = '' } = info;
    // 历史里的文件：能不能收取决于**发送方此刻的状态**（派生，不是缓存的状态）
    if (state === 'archived') {
      if (avail === 'live') return '可接收（发送方在线）';
      if (avail === 'unknown') return '检查中…';
      return '已过期（发送方已离开）';
    }
    if (state === 'asking') return '正在联系发送方…';
    const multi = peers > 1;
    const base = {
      invited: '等待你确认',
      // 刷新页面后恢复出来的"没收完"的接收
      interrupted: '接收中断（可继续）',
      pending: '等待对方确认',
      active: multi ? `传输中（${peers} 人）` : '传输中',
      // 发送端专属：数据已全部发出，正在等接收方校验回执。
      // 与「传输中」分开，避免大文件在"已发完但对方还在校验"的空窗期看起来像卡住。
      sent: multi ? `已发送，等待确认（${peers} 人）` : '已发送，等待对方确认',
      // 传输被中断（网络断了 / 对方离开），已收部分保留，可续传
      paused: '已暂停（可续传）',
      done: multi ? `已完成（${peersDone}/${peers} 人）` : '已完成',
      rejected: '已拒绝',
      // ⚠️ 同一个 `expired` 两个方向含义不同：
      //    发送方看到的是"对方没点接受"，接收方看到的是"发送方走了"。
      expired: dir === 'send' ? '对方未响应' : '已失效',
    }[state];
    if (state === 'failed') {
      if (multi && peersFailed > 0) return `${peersFailed} 人未收到（可重发）`;
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

    // 刷新后恢复的"未完成接收" → 给一个「继续接收」
    //
    // ⚠️ `paused`（传输中途被打断/用户主动停下）是**同一件事的另一个来源**：
    //    文案已经写着"已暂停（可续传）"，如果不给按钮，这句承诺就是空的（F16）。
    if (state === 'interrupted' || state === 'paused') {
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
      const yes = document.createElement('button');
      yes.className = compact ? 'btn-primary' : 'filecard__btn is-yes';
      yes.title = '接收（会弹出保存位置）';
      yes.textContent = compact ? '接收' : '✓';
      const no = document.createElement('button');
      no.className = compact ? 'btn-ghost' : 'filecard__btn is-no';
      no.title = '拒绝';
      no.textContent = compact ? '拒绝' : '✗';
      yes.onclick = () => {
        yes.disabled = no.disabled = true;
        bus.emit(EV.FILE_ACCEPT, { file_id: fileId });
      };
      no.onclick = () => {
        yes.disabled = no.disabled = true;
        bus.emit(EV.FILE_REJECT, { file_id: fileId });
      };
      box.append(yes, no);
      return;
    }

    // 发送方在失败/超时之后给一个重发入口
    if (state === 'failed' || state === 'expired') {
      // ⚠️ 只有**我发的**才谈得上"重发"。
      //    接收方的卡片也可能变成 failed/expired（发送方走了、很久没响应），
      //    那种情况给"↻"是错的 —— 点了必然报"文件已不在内存"。
      //    给一个「移除」，让它能把这张死卡片清掉。
      if (el.dataset.dir !== 'send') {
        const drop = document.createElement('button');
        drop.className = 'filecard__btn is-no';
        drop.title = '移除这条记录';
        drop.textContent = '✗';
        drop.onclick = () => bus.emit(EV.FILE_DISMISS, { file_id: fileId });
        box.append(drop);
        return;
      }
      const again = document.createElement('button');
      again.className = 'filecard__btn is-again';
      again.title = '重新发送（对方接受后会从断点续传）';
      again.textContent = '↻';
      again.onclick = () => {
        again.disabled = true;
        bus.emit(EV.FILE_RESEND, { file_id: fileId });
      };
      box.append(again);
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
      items.push({ label: '删除（仅本地）', danger: true, fn: () => el.remove() });
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

  scrollBottom() {
    const el = $('timeline');
    el.scrollTop = el.scrollHeight;
    this.atBottom = true;
    this.unreadAnchor = null;
    // ⚠️ 顺带把"以下为新消息"分隔线摘掉（复检 P3-8）：
    //    原来只清了锚点，那条线会**一直留在会话中间**直到切房间。
    $('tl-inner').querySelector('.tl-unread-divider')?.remove();
    $('jump-btn').classList.remove('is-on');
  },

  /** 顶部翻页 */
  async loadOlder() {
    if (this.loading || this.reachStart || !this.room || !this.oldestCursor) return;
    this.loading = true;
    const hint = $('tl-hint');
    hint.style.display = 'block';
    hint.textContent = '正在加载更早的消息…';
    try {
      const room = this.room;
      const list = await net.history(room, PAGE, this.oldestCursor);
      if (this.room !== room) return;   // 已切房间，丢弃
      if (!list.length) {
        this.reachStart = true;
        hint.textContent = '没有更早的消息了';
        setTimeout(() => {
          hint.style.display = 'none';
        }, 1500);
      } else {
        const cursorBefore = this.oldestCursor;
        this.prependPage(list);
        hint.style.display = 'none';
        // ⚠️ 只有"不足一页"才说明到底了。刚好满页时服务端可能还有更多。
        //
        // 但还有第二种"到底了"：这一页**全是被去重掉的老消息**
        // （锚点视图与本地游标不一致时会发生），此时游标没有前进 ——
        // 再滚一次还是同一页，用户就永远卡在顶部转圈（复检 P3-9）。
        // 判据直接看**游标有没有前进**，而不是看这页几条。
        if (list.length < PAGE || this.oldestCursor === cursorBefore) {
          this.reachStart = true;
        }
      }
    } catch (e) {
      hint.textContent = `加载失败：${e?.message ?? e}（滚动可重试）`;
    } finally {
      this.loading = false;
    }
  },

  /** 首次进房：拉最新一页 */
  async loadLatest() {
    const hint = $('tl-hint');
    const room = this.room;
    try {
      const list = await net.history(room, PAGE, '');
      // 期间用户可能已经切到别的房间了 —— 这批结果属于旧房间，直接丢弃，
      // 否则会把上一个房间的消息追加到当前房间里。
      if (this.room !== room) return;
      list.forEach((m) => this.push(m, m.from === this.me, true));
      this.oldestCursor = list.length ? U.cursorOf(list[0]) : '';
      this.reachStart = list.length < PAGE;
      // 历史为空**并且**期间没有实时消息到达，才认为房间是空的。
      // （实时消息可能是"进房的瞬间对方刚发的"，这时它不在历史里？其实在，
      //   但历史响应可能更早/更晚返回，所以两条路都要看一眼。）
      const hasLive = !!$('tl-inner').querySelector('.msg');
      this._emptyState(list.length === 0 && !hasLive);
      this.scrollBottom();
      // 通知会话列表回填最后一条预览
      bus.emit(EV.HISTORY, { room, messages: list, me: this.me });
    } catch (e) {
      if (this.room !== room) return;
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
      bus.emit(EV.TIP, `拉取历史失败：${e?.message ?? e}`);
    }
  },
};
