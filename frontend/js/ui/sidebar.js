/* ============================================================================
 * ui/sidebar.js · 左侧面板（薄门面 /Facade）
 *
 * ## 现在这个文件只管三件事
 *
 *   1. **持有状态**：tab / peers / previews / unread / currentRoom ...
 *   2. **事件接线**：init() 里订阅 bus，转发给子模块或自己处理
 *   3. **渲染调度**：render() 决定调哪个子模块的渲染函数
 *
 * ## 为什么拆开
 *
 * 原来三个页面（会话列表 / 连接状态 / 设置）全挤在这一个文件里，
 * 1415 行、其中 `view_status` 单个函数 318 行、`view_settings` 302 行 ——
 * 改设置页要翻会话列表的代码。现在一页一个文件：
 *
 *   sidebar/chats.js     会话列表
 *   sidebar/status.js    连接状态（含`collectRelays` / `rttOf` 等纯函数）
 *   sidebar/settings.js  设置页 + 所有 [data-act] 动作
 *
 * 子模块**接收 `host`（= 本单例）** 来读状态，**不持有自己的状态**。
 * 所以对外 `sidebar.xxx` 的形状一字未变，调用点（main.js / motion.js /
 * topology.js / e2e 脚本）完全不用改。
 *
 * 一个标签 = 一个渲染函数，返回 `{ html, bind? }`。新增标签只需注册，
 * 不用改 switch。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { dialog } from './dialog.js';
import { theme } from './theme.js';
import { notify } from './notify.js';
import * as U from '../util.js';
// 共享原语住在 primitives.js（原先在本文件末尾）：
// ⚠️ `avatar` / `ico` / `regionLabel` 被 timeline.js、topology.js 也用得到。
//    它们住在这里时，依赖方向变成了 timeline → sidebar、topology → sidebar ——
//    一个"会话列表"模块成了所有视图的公共地基，边界就拉歪了。
//    下面这行 re-export 是**故意保留的兼容垫片**（e2e 与外部脚本可能从
//    sidebar.js 引入这三个符号）；新代码请直接从 primitives.js 引。
import {
  WALLPAPER_IDS,
} from './primitives.js';
import { renderChats } from './sidebar/chats.js';
import { renderStatus } from './sidebar/status.js';
import { renderSettings, provideSettingsDeps, settingsAction } from './sidebar/settings.js';
export { avatar, ico, regionLabel, WALLPAPERS, WALLPAPER_IDS } from './primitives.js';

const $ = (id) => document.getElementById(id);

/** 会话预览需要把内联图片转成文字 */
function previewText(text) {
  const m = /^\[img\][\s\S]+?\[\/img\]\n?([\s\S]*)$/.exec(text || '');
  if (m) return m[1] ? `[图片] ${m[1]}` : '[图片]';
  return text || '';
}

export const sidebar = {
  tab: 'chats',
  /**
   * 会话列表的筛选维度（设计稿的"全部 / 群组 / 密友"chips）。
   *
   * ⚠️ **有意没有照抄设计稿的三个标签。**
   *    现有数据模型里房间只有 `{name, alias, pinned, last}`，没有"分组"
   *    这个字段 —— 做不出"群组 / 密友"这种语义。硬套上去只能是假的。
   *    所以换成三个**真实可算**的维度：
   *      all    = 全部房间
   *      pinned = 置顶（store.room.pinned）
   *      unread = 有未读
   *    想要设计稿那套，得先给房间加分组字段（见改造报告的建议）。
   */
  roomFilter: 'all',
  peers: [],
  /** room -> {text, nick, ts, mine}（内存镜像，持久化在 store.previews） */
  previews: new Map(),
  /** room -> 未读数（内存镜像，持久化在 store.unread） */
  unread: new Map(),
  currentNodeState: { ok: false, text: '启动中' },
  currentRoom: '',
  /**
   * 连接状态页里「在线成员」名单是否展开。
   * ⚠️ 它是 `render()` 全量重建的**必要配套** —— DOM 每次重绘都被换掉，
   *    展开类名留在节点上留不住（心跳约 15 秒一轮，会不断重绘）。
   *    详见 `render()` 上方的说明。e2e 里 `multi-peer` / `sidebar-pages` 会碰这一块。
   */
  _membersOpen: false,
  leaveCurrentRoom: async () => {},
  /**
   * 当前 gossip 邻居的 id 集合（PEER_UP / PEER_DOWN 实时维护）。
   * ⚠️ 这是**网络邻居**，不是"房间成员" —— 邻居只是 gossip 覆盖网的局部视图，
   *    所以它只用于状态页的诊断信息，**不要**拿它增删成员列表。
   */
  neighbors: new Set(),
  /** 移动端：面板是否展开。桌面端恒为 false（CSS 里靠媒体查询忽略它） */
  panelOpen: false,

  init() {
    // settings.js 需要读两样本模块自己的东西（节点状态、主题提示文案），
    // 但它不能 import 本文件 —— 那会形成 sidebar ⇄ settings 的循环依赖。
    // 所以在这里把**只读取值器**注入过去（一次性，init 时）。
    provideSettingsDeps({
      state: () => this.currentNodeState || { ok: false, text: '启动中', waiting: true },
      themeHint: () => this._themeHint(),
    });

    // 偏好要在第一次渲染前落到 DOM 上（密度会改变气泡间距/头像大小）
    this._applyPrefs();
    // ⚠️ 浏览器的自动播放策略：`new AudioContext()` 在没有用户手势的情况下
    //    创建出来就是 `suspended`，而 `ding()` 遇到 suspended 会直接返回 ——
    //    结果就是"提示音开关拨开了也永远不响"（开关是真的，声音是哑的）。
    //    这里在**第一次**交互时解锁一次，之后 ding() 才能真正出声。
    const unlockAudio = () => {
      const ac = this._ac;
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
      document.removeEventListener('pointerdown', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    };
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    // 从 localStorage 恢复会话预览与未读 —— 否则刷新后列表全是"还没有消息"
    for (const [room, p] of Object.entries(store.previews())) {
      if (p && typeof p.ts === 'number') this.previews.set(room, p);
    }
    for (const [room, n] of Object.entries(store.unread())) {
      const c = Number(n);
      if (c > 0) this.unread.set(room, c);
    }
    // 正在看的房间不该有未读红点
    if (this.unread.has(store.lastRoom())) {
      this.unread.delete(store.lastRoom());
      store.setUnread(store.lastRoom(), 0);
    }

    // 标签切换
    // 左栏只有三个入口了 ——「在线成员」已经合并进「连接状态页」（见 view_status）。
    const tabs = ['chats', 'status', 'settings'];
    for (const t of tabs) {
      const btn = $(`tab-${t}`);
      if (btn) btn.onclick = () => sidebar.show(t);
    }
    // 搜索（防抖）
    $('filter').oninput = U.debounce(() => sidebar.render(), 100);
    $('btn-new').onclick = () => sidebar.newRoom();
    // 点遮罩关闭移动端面板
    $('panel-scrim').onclick = () => sidebar.closePanel();

    bus.on(EV.MSG, ({ room, message, mine, isHistory }) => {
      if (!this.currentRoom) return;
      // 提示音：只在自己发的之外、且页面可见时响（浏览器自动播放策略）
      if (!mine && !document.hidden) sidebar.ding();
      sidebar.setPreview(room, {
        text: previewText(message.text),
        nick: message.nickname,
        ts: message.ts,
        mine,
      });
      if (!mine && !isHistory && (room !== sidebar.currentRoom || document.hidden)) {
        sidebar.bumpUnread(room);
      }
      // 消息时间就是房间的"最近活跃时间"，用它重排列表（微信行为）
      store.upsertRoom(room, { last: message.ts });
      sidebar.render();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.currentRoom) {
        this.unread.delete(this.currentRoom);
        store.setUnread(this.currentRoom, 0);
        this.paintBadge();
        this.render();
      }
    });
    // 进房后拉到的历史里，最后一条要回填到会话预览（否则显示"还没有消息"）
    bus.on(EV.HISTORY, ({ room, messages, me }) => {
      const last = messages?.[messages.length - 1];
      if (!last) return;
      if ((sidebar.previews.get(room)?.ts || 0) > last.ts) return;
      sidebar.setPreview(room, {
        text: previewText(last.text),
        nick: last.nickname,
        ts: last.ts,
        mine: last.from === me,     // 和 EndpointId 比，不是和昵称比
      });
      // 历史消息的时间才是这个房间真正的最后活跃时间
      store.upsertRoom(room, { last: last.ts });
      sidebar.render();
    });
    bus.on(EV.PRESENCE, ({ room, peers }) => {
      if (room !== sidebar.currentRoom) return;
      sidebar.peers = peers;
      // 成员列表现在长在「连接状态页」里，所以心跳变化要重绘它
      if (sidebar.tab === 'status') sidebar.render();
    });

    // PeerUp/PeerDown 是 gossip 邻居的**实时**上下线（Rust 一直在发，
    // 之前 `net.js` 的 `_dispatch` 没有对应分支，被静默丢弃了）。
    // 邻居 != 房间成员（邻居是覆盖网的局部视图），所以只喂状态页的诊断信息。
    bus.on(EV.PEER_UP, ({ id }) => {
      sidebar.neighbors.add(id);
      if (sidebar.tab === 'status') sidebar.render();
    });
    bus.on(EV.PEER_DOWN, ({ id }) => {
      sidebar.neighbors.delete(id);
      if (sidebar.tab === 'status') sidebar.render();
    });
    bus.on(EV.RELAYS, () => {
      if (sidebar.tab === 'status') sidebar.render();
    });
    bus.on(EV.NODE_STATE, (s) => {
      sidebar.currentNodeState = s;
      // 状态页要能反映"正在重试"，所以每次状态变化都重绘一次
      if (sidebar.tab === 'status') sidebar.render();
    });
    document.addEventListener('themechange', () => this._syncThemeSettings());
    document.addEventListener('prefchange', (event) => this._syncPrefSettings(event.detail?.key));
  },

  _syncPrefSettings(key) {
    if (!key || this.tab !== 'settings') return;
    const toggle = document.querySelector(`[data-toggle="${CSS.escape(key)}"]`);
    if (!toggle) return;
    const on = store.prefs()[key] === true || (key !== 'notify' && store.prefs()[key] !== false);
    toggle.classList.toggle('is-on', on);
    toggle.setAttribute('aria-checked', String(on));
    toggle.title = on ? '点击关闭' : '点击开启';
  },

  _themeHint() {
    // ⚠️ 文案要短。这一行右边紧跟着一个 `<select>`（固定 108px 宽）。
    //    用"跟随系统（当前深色）"这种带全角括号的写法，**弹出的菜单**会横向溢出
    //    300px 的面板（收起时看不出来，一点开就露馅 —— 实测）。
    //    改成间隔号就刚好一行，说明的部分交给 hint。
    return theme.pref === 'auto'
      ? `跟随系统 · 当前${theme.current === 'dark' ? '深色' : '浅色'}`
      : theme.pref === 'dark' ? '始终深色' : '始终浅色';
  },

  _syncThemeSettings() {
    if (this.tab !== 'settings') return;
    const select = $('panel-body').querySelector('select[data-theme-pref]');
    if (!select) return;
    select.value = theme.pref;
    select.closest('.set-row').querySelector('.set-row__hint').textContent = this._themeHint();
  },

  setPreview(room, p) {
    if ((this.previews.get(room)?.ts || 0) > p.ts) return;
    this.previews.set(room, p);
    store.setPreview(room, p);
  },

  bumpUnread(room) {
    const n = (this.unread.get(room) || 0) + 1;
    this.unread.set(room, n);
    store.setUnread(room, n);
    this.paintBadge();
  },

  show(tab) {
    // ⚠️ 向后兼容：「在线成员」页已合并进连接状态页，但调用点（比如顶栏的成员药丸）
    //    或者用户浏览器里存着的旧状态还可能传 'people' 进来。
    //    直接重定向，而不是留一个点了没反应的死入口。
    if (tab === 'people') tab = 'status';
    this.tab = tab;
    for (const t of ['chats', 'status', 'settings']) {
      $(`tab-${t}`).classList.toggle('is-active', t === tab);
    }
    // 筛选 chips 只对"会话"页有意义 —— 切走后藏起来，不然它会暗示
    // "这一页也能筛选"，点了却什么都不发生。
    const chips = $('panel-tabs');
    if (chips) chips.style.display = tab === 'chats' ? '' : 'none';
    // 搜索框说清这一页搜的是什么。设计稿给每页都配了各自的占位文案
    // （"搜索节点 / 中继网..."、"搜索设置项..."），而且现在**真的会筛**。
    const filter = $('filter');
    if (filter) {
      filter.placeholder = {
        chats: '搜索房间 / 比奇堡居民…',
        status: '搜索节点 / 中继…',
        settings: '搜索设置项…',
      }[tab] || '搜索';
      // 切页时清掉上一页的搜索词 —— 否则会出现"在设置页输了个词，
      // 切回会话列表发现列表空着"这种莫名其妙的状态。
      if (filter.value) filter.value = '';
    }
    this.openPanel();
    this.render();
  },

  openPanel() {
    this.panelOpen = true;
    $('panel').classList.add('is-open');
    $('panel-scrim').classList.add('is-on');
  },

  /** 移动端选完房间要把面板收起来，否则它会一直盖住聊天区 */
  closePanel() {
    this.panelOpen = false;
    $('panel').classList.remove('is-open');
    $('panel-scrim').classList.remove('is-on');
  },

  setRoom(room) {
    if (room !== this.currentRoom) {
      this.peers = [];
      this.neighbors.clear();
    }
    this.currentRoom = room;
    if (this.unread.delete(room)) store.setUnread(room, 0);
    this.paintBadge();
  },

  totalUnread() {
    let n = 0;
    for (const v of this.unread.values()) n += v;
    return n;
  },

  paintBadge() {
    const n = this.totalUnread();
    const b = $('rail-badge');
    if (!b) return;   // 元素缺失时不要炸掉整条流程
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('is-on', n > 0);
    // ⚠️ 标题上的未读数受设置里的开关控制 —— 之前它**无条件**写标题，
    //    那个"未读时闪烁标题"开关存了值却没有任何读取方（拨了没反应）。
    const showInTitle = store.prefs().flashTitle !== false;
    document.title = n > 0 && showInTitle ? `(${n}) 派大星聊天室` : '派大星聊天室';
  },

  /**
   * 重绘侧栏。**整段替换 `#panel-body` 的 innerHTML**。
   *
   * ## ⚠️ 这是全量重建，下面三处是它的必要配套，不是可以顺手删的 hack
   *
   * 换增量 diff（只改变化的节点）能消掉它们，但**当前规模下不值得**：
   * 40 个房间的全量重建是微秒级，真正的卡顿在 `timeline.js`（消息区、滚动锚定、
   * 图片解码），不在这里。
   *
   * 1. `keepTop` —— `innerHTML` 替换会把 `scrollTop` 归零。
   *    列表滚动到中间时收到一条消息就会"跳回顶部"。
   *    ⚠️ 没有 e2e 断言这个行为（我查过），所以删了测试不会红，但用户会察觉。
   *
   * 2. 下面的 `role="button"` / `tabIndex` / `onkeydown` 补绑 ——
   *    `.row[data-room]` 和 `[data-act]` 的宿主元素是 `<div>`，
   *    每次重建后都要重新挂键盘可达性。
   *
   * 3. `status.js` 里的 `_membersOpen` —— 展开态必须存在**sidebar 单例**上，
   *    因为 DOM 每次都被重建，类名留在节点上是留不住的（心跳一来就重绘）。
   *
   * 若将来真要做增量 diff：这四处要一起改，且 `redesign.py` 的 127 项断言
   * （选中态 / `aria-checked` / 几何）是最可能被打中的风险面。
   */
  render() {
    const q = ($('filter').value || '').trim().toLowerCase();
    const body = $('panel-body');
    // 每个标签页一个子模块：返回 { html, bind? }。
    // 新增标签只需在这里加一行，不用改任何别的地方。
    const view = {
      chats: () => renderChats(this, q),
      status: () => renderStatus(this, q),
      settings: () => renderSettings(this, q),
    }[this.tab]?.();
    // ⚠️ 整段替换 innerHTML 会把 scrollTop 归零 —— 列表滚动到中间时收到一条消息
    // 就会"跳回顶部"。所以先记住位置，替换后还原。
    const keepTop = body.scrollTop;
    body.innerHTML = view?.html ?? '';
    view?.bind?.(body);
    for (const element of body.querySelectorAll('.row[data-room], [data-act], [data-toggle]')) {
      if (element.tagName === 'BUTTON') continue;
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      element.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element.click(); }
        if (event.key === 'F10' && event.shiftKey && element.dataset.room) { event.preventDefault(); this.roomMenu(element.dataset.room); }
      };
    }
    if (keepTop) body.scrollTop = keepTop;
  },

  /* ----------------------------------------------------视图转发（兼容垫片）
   *
   * 三个页面的渲染都搬到 `sidebar/` 子模块了。这三个方法只做转发，
   * 保留是为了让旧调用点（e2e 脚本、`sidebar.view_status(q)` 之类）继续能用 ——
   * 删掉它们属于破坏性改动，不值当。
   *新代码请直接调子模块。 */
  view_chats(q) {
    return renderChats(this, q);
  },

  view_status(q = '') {
    return renderStatus(this, q);
  },

  view_settings(q = '') {
    return renderSettings(this, q);
  },

  memberCount() {
    const anchorId = net.config?.anchor?.id || '';
    const otherMembers = this.peers.filter((peer) => peer.id !== anchorId && peer.id !== net.endpoint_id());
    const joined = this.currentRoom && net.canSend && net._room === this.currentRoom;
    return otherMembers.length + (joined ? 1 : 0);
  },

  /** 偏好开关：立即生效 + 落盘 */
  _togglePref(key) {
    // ⚠️ 主题不能存进 prefs —— 它有自己的键 `iroh.theme`（store.theme/setTheme），
    //    两者并存会出现"开关显示已开、实际却是关的"这种自相矛盾
    //    （实测连点几次就卡住了）。所以这里直接转给 theme 模块。
    if (key === 'theme') {
      document.getElementById('btn-theme').click();
      this.render();
      return;
    }
    // ⚠️ 桌面通知不能走下面那条通用通路。它要**先拿到系统权限**才能算"开"：
    //    直接写 `prefs.notify = true` 会出现"开关是开的、系统里却一直拒绝" ——
    //    用户以为开了，其实永远收不到，而且没有任何提示。
    //    所以：授权失败就不落盘，并把开关留在关闭态。
    if (key === 'notify') {
      const done = () => {
        this._applyPrefs();
        this.render();
        document.dispatchEvent(new CustomEvent('prefchange', { detail: { key } }));
      };
      if (store.prefs().notify === true) {
        notify.close();
        done();
        return;
      }
      notify.enable().then(done);
      return;
    }
    const p = store.prefs();
    store.setPref(key, !(p[key] !== false));
    this._applyPrefs();
    this.render();
    // 顶栏的提示音图标也读同一个偏好，通知它同步（否则设置页关了、
    // 顶栏那个喇叭还亮着，两边自相矛盾）。
    document.dispatchEvent(new CustomEvent('prefchange', { detail: { key } }));
  },

  /** 把会影响全局外观/行为的偏好落到 DOM 上 */
  _applyPrefs() {
    const p = store.prefs();
    document.documentElement.dataset.density = p.density === 'compact' ? 'compact' : 'cozy';
    // 主题壁纸（设计稿 _2 的「比奇堡主题壁纸」）。
    // ⚠️ 必须先校验取值：localStorage 是用户可以手改的，写进一个不认识的
    //    字符串会让 `data-wallpaper` 落成一个没有对应 CSS 的值 ——
    //    表现是"对话区背景突然没了"，排查起来毫无线索。
    document.documentElement.dataset.wallpaper = WALLPAPER_IDS.includes(p.wallpaper) ? p.wallpaper : 'none';
    if (!$('input').disabled) $('input').placeholder = `输入消息，${p.sendKey === 'ctrl' ? 'Ctrl/⌘+Enter' : 'Enter'} 发送 · Shift+Enter 换行`;
    // 提示音：预置一个极短的"叮"，用 WebAudio 合成，不引入音频文件
    if (p.sound !== false && !this._soundReady) {
      this._soundReady = true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this._ac = new AC();
      } catch {
        this._soundReady = false;
      }
    }
  },

  /**
   * 拿一个可用的 AudioContext。
   *
   * ⚠️ 为什么不能只用 `prefs.sound !== false` 时创建的那一个：
   *    设置页的「测试提示音」在提示音**关着**的时候也要能响（用户点它就是想听），
   *    而那时 `_applyPrefs` 从来没创建过 `_ac` —— 按钮点了毫无反应，
   *    看起来像坏了。这里按需创建，并顺手 resume（点击本身就是用户手势，
   *    可以解开浏览器的自动播放限制）。
   */
  _ensureAudio() {
    try {
      if (!this._ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this._ac = new AC();
      }
      if (this._ac.state === 'suspended') this._ac.resume().catch(() => {});
      return this._ac;
    } catch {
      return null;
    }
  },

  /**
   * 收到新消息时"叮"一下（设置里可关）。
   * @param force 忽略"提示音已关"这个偏好（设置页的试听按钮用）
   */
  ding(force = false) {
    if (!force && store.prefs().sound === false) return;
    const ac = this._ensureAudio();
    if (!ac || ac.state === 'suspended') return;
    try {
      const t = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    } catch {
      /* 自动播放策略可能拦，静默失败即可 */
    }
  },

  /** 设置项动作（换昵称/导出/清数据…）—— 实现在 sidebar/settings.js */
  _settingsAction(act, el) {
    return settingsAction(this, act, el);
  },

  /* ------------------------------------------------------------------ 房间菜单 */
  roomMenu(name) {
    const r = store.room(name) || { name };
    dialog.open({
      title: `房间：${name}`,
      body:
        `<label class="dialog__label" for="dlg-alias">备注名（只改我这边显示）</label>` +
        `<input id="dlg-alias" class="dialog__field" value="${U.esc(r.alias || '')}" placeholder="留空 = 显示原名" />` +
        `<label class="dialog__label" for="dlg-pin">置顶</label>` +
        `<select id="dlg-pin" class="dialog__field">` +
        `<option value="0">不置顶</option><option value="1" ${r.pinned ? 'selected' : ''}>置顶</option>` +
        `</select>` +
        `<div class="dialog__hint">房间名不可改，备注只在本地生效。常驻节点保存历史，知道房名即可访问。</div>` +
        `<button class="btn-ghost" id="dlg-copy-room">复制真实房间名</button> <button class="btn-ghost" id="dlg-remove-room">移出列表${name === this.currentRoom ? '并退出' : ''}</button>`,
      okText: '保存',
      onOk: () => {
        store.upsertRoom(name, {
          alias: document.getElementById('dlg-alias').value.trim(),
          pinned: document.getElementById('dlg-pin').value === '1',
        });
        this.render();
        document.dispatchEvent(new CustomEvent('roomrenamed', { detail: name }));
      },
    });
    $('dlg-copy-room').onclick = () => navigator.clipboard.writeText(name).then(() => bus.emit(EV.TIP, '已复制房间名')).catch(() => bus.emit(EV.TIP, '复制失败，请手动复制标题中的房间名'));
    $('dlg-remove-room').onclick = async () => {
      if (name === this.currentRoom) await this.leaveCurrentRoom();
      store.removeRoom(name);
      this.render();
      dialog.close();
    };
  },

  newRoom() {
    dialog.ask({
      title: '新建 / 加入房间',
      label: '房间名（同名即同房间）',
      placeholder: '例如 team-alpha',
      hint: '同名即同房。常驻节点保存文本历史，知道房名即可访问；不要使用可猜的名称分享敏感内容。仅接收当前房间的消息。',
      okText: '进入',
      onOk: (v) => {
        if (!v) return false;
        const invalid = U.roomNameError(v);
        if (invalid) { bus.emit(EV.TIP, invalid); return false; }
        if (!store.room(v) && store.rooms().length >= 40) { bus.emit(EV.TIP, '房间列表已满（40 个），请先在房间菜单中移出一项'); return false; }
        bus.emit(EV.ROOM_OPEN, v);
      },
    });
  },
};
