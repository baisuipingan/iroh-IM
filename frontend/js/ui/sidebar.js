/* ============================================================================
 * ui/sidebar.js · 左侧列表（四个标签页）
 *
 * 一个标签 = 一个渲染函数，返回 HTML 字符串 + 一个可选的 bind 回调。
 * 这样新增标签只需加一条注册，不用改 switch。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { dialog } from './dialog.js';
import * as U from '../util.js';

const $ = (id) => document.getElementById(id);

/** 会话预览需要把内联图片转成文字 */
function previewText(text) {
  const m = /^\[img\][\s\S]+?\[\/img\]\n?([\s\S]*)$/.exec(text || '');
  if (m) return m[1] ? `[图片] ${m[1]}` : '[图片]';
  return text || '';
}

export const sidebar = {
  tab: 'chats',
  peers: [],
  /** room -> {text, nick, ts, mine}（内存镜像，持久化在 store.previews） */
  previews: new Map(),
  /** room -> 未读数（内存镜像，持久化在 store.unread） */
  unread: new Map(),
  currentNodeState: { ok: false, text: '启动中' },
  currentRoom: '',
  /**
   * 当前 gossip 邻居的 id 集合（PEER_UP / PEER_DOWN 实时维护）。
   * ⚠️ 这是**网络邻居**，不是"房间成员" —— 邻居只是 gossip 覆盖网的局部视图，
   *    所以它只用于状态页的诊断信息，**不要**拿它增删成员列表。
   */
  neighbors: new Set(),
  /** 移动端：面板是否展开。桌面端恒为 false（CSS 里靠媒体查询忽略它） */
  panelOpen: false,

  init() {
    // 偏好要在第一次渲染前落到 DOM 上（密度会改变气泡间距/头像大小）
    this._applyPrefs();
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
    const tabs = ['chats', 'people', 'status', 'settings'];
    for (const t of tabs) {
      $(`tab-${t}`).onclick = () => sidebar.show(t);
    }
    // 搜索（防抖）
    $('filter').oninput = U.debounce(() => sidebar.render(), 100);
    $('btn-new').onclick = () => sidebar.newRoom();
    // 点遮罩关闭移动端面板
    $('panel-scrim').onclick = () => sidebar.closePanel();

    bus.on(EV.MSG, ({ room, message, mine }) => {
      // 提示音：只在自己发的之外、且页面可见时响（浏览器自动播放策略）
      if (!mine && !document.hidden) sidebar.ding();
      sidebar.setPreview(room, {
        text: previewText(message.text),
        nick: message.nickname,
        ts: message.ts,
        mine,
      });
      if (!mine && room !== sidebar.currentRoom) {
        sidebar.bumpUnread(room);
      }
      // 消息时间就是房间的"最近活跃时间"，用它重排列表（微信行为）
      store.upsertRoom(room, { last: message.ts });
      sidebar.render();
    });
    // 进房后拉到的历史里，最后一条要回填到会话预览（否则显示"还没有消息"）
    bus.on(EV.HISTORY, ({ room, messages, me }) => {
      const last = messages?.[messages.length - 1];
      if (!last) return;
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
    bus.on(EV.PRESENCE, ({ peers }) => {
      sidebar.peers = peers;
      if (sidebar.tab === 'people') sidebar.render();
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
  },

  setPreview(room, p) {
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
    this.tab = tab;
    for (const t of ['chats', 'people', 'status', 'settings']) {
      $(`tab-${t}`).classList.toggle('is-active', t === tab);
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
    document.title = n > 0 ? `(${n}) iroh 聊天室` : 'iroh 聊天室';
  },

  render() {
    const q = ($('filter').value || '').trim().toLowerCase();
    const body = $('panel-body');
    const view = this[`view_${this.tab}`]?.call(this, q);
    // ⚠️ 整段替换 innerHTML 会把 scrollTop 归零 —— 列表滚动到中间时收到一条消息
    // 就会"跳回顶部"。所以先记住位置，替换后还原。
    const keepTop = body.scrollTop;
    body.innerHTML = view?.html ?? '';
    view?.bind?.(body);
    if (keepTop) body.scrollTop = keepTop;
  },

  /* ------------------------------------------------------------------ 会话 */
  view_chats(q) {
    const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
    const list = store.roomsSorted().filter((r) => hit(r.name) || hit(r.alias));

    if (!list.length) {
      return {
        html: `<div class="empty">${
          q ? '没有匹配的房间' : '还没有房间<br />点右上角 + 新建，或让别人把房间名告诉你'
        }</div>`,
      };
    }

    const html =
      list
        .map((r) => {
          const last = this.previews.get(r.name);
          const un = this.unread.get(r.name) || 0;
          const name = r.alias || r.name;
          // 微信的会话预览**不写"我:"**，靠气泡左右区分说话人；这里保持一致。
          const preview = last ? last.text : '还没有消息';
          return `
          <div class="row ${r.name === this.currentRoom ? 'is-active' : ''}" data-room="${U.esc(r.name)}">
            ${avatar(name)}
            <div class="row__meta">
              <div class="row__line1">
                <span class="row__name">${r.pinned ? '📌 ' : ''}${U.esc(name)}</span>
                <span class="row__time">${last ? U.listTime(last.ts) : ''}</span>
              </div>
              <div class="row__line2">
                <span class="row__preview">${U.esc(preview)}</span>
                ${un ? `<span class="badge">${un > 99 ? '99+' : un}</span>` : ''}
              </div>
            </div>
          </div>`;
        })
        .join('');

    return {
      html,
      bind: (root) => {
        root.querySelectorAll('.row[data-room]').forEach((el) => {
          const room = el.dataset.room;
          el.onclick = () => {
            // 移动端：面板是覆盖层，不收起来就永远看不到聊天区
            if (matchMedia('(max-width: 760px)').matches) this.closePanel();
            bus.emit(EV.ROOM_OPEN, room);
          };
          el.oncontextmenu = (e) => {
            e.preventDefault();
            this.roomMenu(room);
          };
        });
      },
    };
  },

  /* ------------------------------------------------------------------ 在线成员 */
  //
  // 只读视图：当前房间里都有谁（presence 快照 + 常驻节点单独一节）。
  // 这里**不**做联系人/好友簿 —— 那是"平台"功能，这个项目只借微信的交互方式，
  // 不打算复刻一整套微信。想找谁说话就把房间名告诉他。
  view_people(q) {
    const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
    // 常驻节点（anchor）本身也会出现在 peers 里（它是个真实端点）。
    // 之前"在线成员"和"常驻节点"两段各画一次，同一个 id 显示两遍 —— 去掉重复。
    const anchorId = net.config?.anchor?.id || '';
    const list = this.peers.filter((p) => hit(p.nickname) && p.id !== anchorId);
    const anchor = anchorId ? this.peers.find((p) => p.id === anchorId) : null;
    const anchorRow = anchorId
      ? `<div class="peer">
           ${avatar('常驻节点', 'avatar--sm')}
           <div class="peer__body">
             <span class="peer__name">常驻节点</span>
             <span class="peer__sub">${U.shortId(anchorId)} · 提供历史${anchor ? '' : ' · 未连接'}</span>
           </div>
         </div>`
      : `<div class="empty">未配置常驻节点</div>`;

    return {
      html:
        `<div class="section-title">在线成员（${list.length}）</div>` +
        (list.length
          ? list
              .map(
                (p) => `
                <div class="peer">
                  ${avatar(p.nickname, 'avatar--sm')}
                  <div class="peer__body">
                    <span class="peer__name">${U.esc(p.nickname)}</span>
                    <span class="peer__sub">${U.shortId(p.id)} · ${U.relTime(p.lastSeenMs)}</span>
                  </div>
                </div>`,
              )
              .join('')
          : `<div class="empty">房间里还没有其他人在线</div>`) +
        `<div class="section-title">我自己</div>
         <div class="peer">
           ${avatar(store.nick(), 'avatar--sm')}
           <div class="peer__body">
             <span class="peer__name">${U.esc(store.nick())}</span>
             <span class="peer__sub">${U.shortId(net.endpoint_id())}</span>
           </div>
         </div>
         <div class="section-title">常驻节点</div>
         ${anchorRow}`,
    };
  },

  /* ------------------------------------------------------------------ 状态 */
  view_status() {
    const relays = net.relayStatus();
    const ok = relays.filter((r) => r.connected).length;
    const row = (k, v, cls = '') =>
      `<div class="kv"><span class="kv__k">${U.esc(k)}</span><span class="kv__v ${cls}">${U.esc(v)}</span></div>`;

    // 探测结果：区分"还在探"、"探完但全挂"、"探完有活的"三种。
    // ⚠️ 判成败用 `p.ok`，不能用 `p.rtt` —— 中继**可达但读不到计时**
    //    （缺 Timing-Allow-Origin 且 duration 为 0）时 ok=true、rtt=null，
    //    只看 rtt 会把它显示成 `×`（不可达），与下面"重新探测"的提示自相矛盾。
    const probeCell = net.probes.length
      ? net.probes
          .map((p) => `${p.id} ${p.ok ? (p.rtt ? `${Math.round(p.rtt)}ms` : '可达') : '×'}`)
          .join(' · ')
      : net.probing
        ? '正在探测…'
        : '尚未探测';

    return {
      html:
        `<div class="section-title">连接</div>` +
        row('节点', this.currentNodeState.text, this.currentNodeState.waiting ? '' : this.currentNodeState.ok ? 'is-ok' : 'is-bad') +
        row('我的身份', net.endpoint_id() || '—') +
        row('当前房间', this.currentRoom || '未进入') +
        // gossip 邻居数（PEER_UP / PEER_DOWN 实时维护）。
        // 是**网络拓扑**诊断信息，不是"房间里有多少人"—— 后者看成员页。
        row('gossip 邻居', this.neighbors.size ? `${this.neighbors.size} 个` : '暂无') +
        // 断线时给一个明确的重连入口 —— 干等退避计时器时用户无事可做
        (net.phase === 'online'
          ? ''
          : `<div class="set-row" data-act="reconnect">
               <span class="set-row__label">立即重新连接</span>
               <span class="set-row__value">↻</span>
             </div>`) +
        `<div class="section-title">中继（${ok}/${relays.length} 已连接）</div>` +
        (relays.length
          ? relays
              .map((r) =>
                row(r.url.replace('https://', ''), r.connected ? '已连接' : '未连接', r.connected ? 'is-ok' : 'is-bad'),
              )
              .join('')
          : `<div class="empty">暂无中继信息</div>`) +
        `<div class="section-title">延迟探测</div>` +
        row('结果', probeCell) +
        `<div class="set-row" data-act="reprobe">
           <span class="set-row__label">重新探测中继</span>
           <span class="set-row__value">↻</span>
         </div>`,
      bind: (root) => {
        root.querySelectorAll('.set-row[data-act]').forEach((el) => {
          el.onclick = () => {
            if (el.dataset.act === 'reconnect') {
              net.reconnect();
              bus.emit(EV.TIP, '正在重新连接中继…');
            } else {
              bus.emit(EV.TIP, '正在探测中继…');
              net.probe().then(() => {
                bus.emit(
                  EV.TIP,
                  net.probes
                    .filter((p) => p.ok)
                    .map((p) => `${p.id} ${p.rtt ? `${Math.round(p.rtt)}ms` : '?'}`)
                    .join(' · ') || '全部不可达',
                );
                this.render();
              });
            }
          };
        });
      },
    };
  },

  /* ------------------------------------------------------------------ 设置 */
  //
  // 之前是 4 组纯文字 `kv` / `set-row`：没有开关、没有输入框、
  // "深色模式 已开启"这种文案也点一下才知道能不能改。
  // 现在换成真实控件：开关、输入框、select，且每个都立刻生效并落盘。
  view_settings() {
    const prefs = store.prefs();
    const dark = document.documentElement.dataset.theme === 'dark';
    const myId = net.endpoint_id();
    const usage = store.usage();

    // 带开关的行
    const toggle = (act, label, on, hint = '') =>
      `<div class="set-row set-row--toggle">
         <div class="set-row__text">
           <div class="set-row__label">${U.esc(label)}</div>
           ${hint ? `<div class="set-row__hint">${U.esc(hint)}</div>` : ''}
         </div>
         <button class="switch ${on ? 'is-on' : ''}" data-toggle="${act}"
                 role="switch" aria-checked="${on}" title="${on ? '点击关闭' : '点击开启'}">
           <i></i>
         </button>
       </div>`;

    // 可点开的行（带右侧箭头）
    const nav = (act, label, value = '', sub = '') =>
      `<div class="set-row set-row--nav" data-act="${act}">
         <div class="set-row__text">
           <div class="set-row__label">${U.esc(label)}</div>
           ${sub ? `<div class="set-row__hint">${U.esc(sub)}</div>` : ''}
         </div>
         <div class="set-row__right">
           ${value ? `<span class="set-row__value">${U.esc(value)}</span>` : ''}
           <span class="chev">›</span>
         </div>
       </div>`;

    const danger = (act, label, sub) =>
      `<div class="set-row set-row--danger" data-act="${act}">
         <div class="set-row__text">
           <div class="set-row__label">${U.esc(label)}</div>
           <div class="set-row__hint">${U.esc(sub)}</div>
         </div>
         <span class="chev">›</span>
       </div>`;

    return {
      html:
        // ---- 资料卡 ----
        `<div class="set-card">
           ${avatar(store.nick(), 'avatar--lg')}
           <div class="set-card__body">
             <div class="set-card__name">${U.esc(store.nick())}</div>
             <div class="set-card__id" title="${U.esc(myId)}">
               <code>${U.esc(U.shortId(myId, 20))}…</code>
               <button class="mini-btn" data-act="copy-id">复制 ID</button>
             </div>
           </div>
         </div>

         <div class="set-group">
           <div class="section-title">资料</div>
           ${nav('nick', '昵称', store.nick(), '房间里别人看到的名字')}
           <div class="set-row set-row--field">
             <div class="set-row__text">
               <div class="set-row__label">发送快捷键</div>
               <div class="set-row__hint">输入框里用什么键发送消息</div>
             </div>
             <select class="mini-select" data-pref="sendKey">
               <option value="enter" ${prefs.sendKey !== 'ctrl' ? 'selected' : ''}>Enter</option>
               <option value="ctrl" ${prefs.sendKey === 'ctrl' ? 'selected' : ''}>Ctrl + Enter</option>
             </select>
           </div>
           ${nav('newroom', '新建 / 加入房间', '', '同名即同房间')}
         </div>

         <div class="set-group">
           <div class="section-title">外观</div>
           ${toggle('theme', '深色模式', dark, '浅色更接近微信桌面端')}
           <div class="set-row set-row--field">
             <div class="set-row__text">
               <div class="set-row__label">消息密度</div>
               <div class="set-row__hint">紧凑模式一屏能看到更多消息</div>
             </div>
             <select class="mini-select" data-pref="density">
               <option value="cozy" ${prefs.density !== 'compact' ? 'selected' : ''}>标准</option>
               <option value="compact" ${prefs.density === 'compact' ? 'selected' : ''}>紧凑</option>
             </select>
           </div>
         </div>

         <div class="set-group">
           <div class="section-title">通知</div>
           ${toggle(
             'sound',
             '新消息提示音',
             prefs.sound !== false,
             '仅在页面可见时播放（浏览器限制）',
           )}
           ${toggle(
             'flashTitle',
             '未读时闪烁标题',
             prefs.flashTitle !== false,
             '切到别的标签页时把标题标成未读',
           )}
         </div>

         <div class="set-group">
           <div class="section-title">连接</div>
           ${nav('status', '连接诊断', this.currentNodeState.ok ? '在线' : '异常', '中继、延迟、重连')}
           ${nav('probecopy', '我的身份 ID', U.shortId(myId, 10) + '…', '相当于你的主密码，勿外传')}
         </div>

         <div class="set-group">
           <div class="section-title">数据</div>
           <div class="kv"><span class="kv__k">本地占用</span><span class="kv__v">${U.humanSize(usage.bytes)}</span></div>
           <div class="kv"><span class="kv__k">房间数</span><span class="kv__v">${store.rooms().length}</span></div>
           ${nav('export', '导出本地数据', '', '房间列表、会话预览、偏好为 JSON')}
           ${nav('clearlocal', '清除本地记录', '', '房间列表、预览、未读、偏好（不动身份）')}
         </div>

         <div class="set-group set-group--danger">
           <div class="section-title">危险操作</div>
           ${danger('rotatekey', '更换身份密钥', 'EndpointId 会变，别人看到的是另一个你')}
           ${danger('resetall', '清空全部数据并换身份', '等于重装一个新账号')}
         </div>

         <div class="set-group">
           <div class="section-title">关于</div>
           <div class="kv"><span class="kv__k">传输</span><span class="kv__v">iroh · QUIC over 自建中继</span></div>
           <div class="kv"><span class="kv__k">加密</span><span class="kv__v">端到端；中继看不到内容</span></div>
           <div class="kv"><span class="kv__k">浏览器</span><span class="kv__v">永久 relay-only（不能打洞）</span></div>
           <div class="kv"><span class="kv__k">文件传输</span><span class="kv__v">${
             typeof window.showSaveFilePicker === 'function' ? '可用（Chrome / Edge）' : '不支持（需 Chrome / Edge）'
           }</span></div>
         </div>`,
      bind: (root) => {
        root.querySelectorAll('.set-row[data-act]').forEach((el) => {
          el.onclick = () => this._settingsAction(el.dataset.act);
        });
        root.querySelectorAll('[data-toggle]').forEach((el) => {
          el.onclick = () => this._togglePref(el.dataset.toggle);
        });
        root.querySelectorAll('[data-pref]').forEach((el) => {
          el.onchange = () => {
            store.setPref(el.dataset.pref, el.value);
            this._applyPrefs();
            this.render();
            bus.emit(EV.TIP, '已保存');
          };
        });
      },
    };
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
    const p = store.prefs();
    store.setPref(key, !(p[key] !== false));
    this._applyPrefs();
    this.render();
  },

  /** 把会影响全局外观/行为的偏好落到 DOM 上 */
  _applyPrefs() {
    const p = store.prefs();
    document.documentElement.dataset.density = p.density === 'compact' ? 'compact' : 'cozy';
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

  /** 收到新消息时"叮"一下（设置里可关） */
  ding() {
    if (store.prefs().sound === false) return;
    const ac = this._ac;
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

  _settingsAction(act) {
    if (act === 'copy-id') {
      const id = net.endpoint_id();
      navigator.clipboard
        ?.writeText(id)
        .then(() => bus.emit(EV.TIP, '已复制我的身份 ID'))
        .catch(() => bus.emit(EV.TIP, '复制失败，请手动选中复制'));
      return;
    }
    if (act === 'probecopy') {
      dialog.open({
        title: '我的身份 ID',
        body:
          `<div class="id-box"><code>${U.esc(net.endpoint_id())}</code></div>` +
          `<div class="dialog__hint">这串 ID 就是你的身份凭据。<b>谁拿到都能以"你"的身份连进来</b>，只在信任的人之间分享。<br />` +
          `换身份请用下面的「更换身份密钥」。</div>`,
        okText: '知道了',
      });
      return;
    }
    if (act === 'status') return this.show('status');
    if (act === 'export') {
      const dump = {
        exportedAt: new Date().toISOString(),
        endpointId: net.endpoint_id(),
        nickname: store.nick(),
        rooms: store.rooms(),
        previews: store.previews(),
        prefs: store.prefs(),
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `iroh-chat-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      bus.emit(EV.TIP, '已导出');
      return;
    }
    if (act === 'nick') {
      return dialog.ask({
        title: '设置昵称',
        label: '昵称',
        value: store.nick(),
        placeholder: '你的名字',
        okText: '保存',
        onOk: (v) => {
          const name = (v || '').trim();
          if (!name) {
            bus.emit(EV.TIP, '昵称不能为空');
            return false;
          }
          if (name.length > 24) {
            bus.emit(EV.TIP, '昵称太长了（最多 24 字）');
            return false;
          }
          store.setNick(name);
          net.setNickname(name);
          document.dispatchEvent(new CustomEvent('nickchange'));
          this.render();
          bus.emit(EV.TIP, '昵称已更新');
        },
      });
    }
    if (act === 'newroom') return this.newRoom();
    if (act === 'theme') {
      document.getElementById('btn-theme').click();
      this.render();
      return;
    }
    if (act === 'clearlocal') {
      return dialog.open({
        title: '清除本地记录',
        body:
          '<div class="dialog__hint">会清掉：房间列表、会话预览、未读计数、偏好设置。<br />' +
          '<b>保留</b>：身份密钥、服务器上的历史消息。<br />' +
          '想要连身份一起换，用下面的「清空全部数据」。</div>',
        okText: '清除',
        onOk: () => {
          store.clearLocal();
          this.unread.clear();
          this.previews.clear();
          this.paintBadge();
          this.render();
          bus.emit(EV.TIP, '已清除本地记录');
        },
      });
    }
    if (act === 'rotatekey') {
      return dialog.open({
        title: '更换身份密钥',
        body:
          '<div class="dialog__hint">换掉后你的 EndpointId 会变，别人看到的"你"就是另一个身份' +
          '（历史消息仍按旧身份签名显示）。<br />房间里的人需要用你的新身份重新认到你，' +
          '之前靠旧身份约定的房间名也要重新告诉对方。</div>',
        okText: '更换',
        onOk: () => {
          store.resetIdentity();
          location.reload();
        },
      });
    }
    if (act === 'resetall') {
      return dialog.open({
        title: '清空全部数据',
        body:
          '<div class="dialog__hint"><b>不可撤销。</b>会删掉：<br />' +
          '· 身份密钥（换成一个全新的身份）<br />· 房间列表与全部本地记录<br />' +
          '服务器上的历史消息不会动，但那些消息的署名已是旧身份。<br /><br />' +
          '相当于重装一个新账号。确定继续？</div>',
        okText: '全部清空',
        onOk: () => {
          // 只清 iroh.* 前缀，别的键不动
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith('iroh.')) localStorage.removeItem(k);
          }
          location.reload();
        },
      });
    }
  },

  /* ------------------------------------------------------------------ 房间菜单 */
  roomMenu(name) {
    const r = store.room(name) || { name };
    dialog.open({
      title: `房间：${name}`,
      body:
        `<label class="dialog__label">备注名（只改我这边显示）</label>` +
        `<input id="dlg-alias" class="dialog__field" value="${U.esc(r.alias || '')}" placeholder="留空 = 显示原名" />` +
        `<label class="dialog__label">置顶</label>` +
        `<select id="dlg-pin" class="dialog__field">` +
        `<option value="0">不置顶</option><option value="1" ${r.pinned ? 'selected' : ''}>置顶</option>` +
        `</select>` +
        `<div class="dialog__hint">房间名本身不可改（它决定了加密组播的标识），这里改的是你本地看到的备注。</div>`,
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
  },

  newRoom() {
    dialog.ask({
      title: '新建 / 加入房间',
      label: '房间名（同名即同房间）',
      placeholder: '例如 team-alpha',
      hint: '房间名决定加密组播的标识。把同一个名字告诉别人，就能互相看到。',
      okText: '进入',
      onOk: (v) => {
        if (!v) return false;
        bus.emit(EV.ROOM_OPEN, v);
      },
    });
  },
};

/** 头像元素（色块 + 首字母），颜色由名字稳定推导 */
export function avatar(name, extraClass = '') {
  return `<div class="avatar ${extraClass}" style="background:${U.colorOf(name)}">${U.esc(U.initial(name))}</div>`;
}
