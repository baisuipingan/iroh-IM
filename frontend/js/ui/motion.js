/* ============================================================================
 * ui/motion.js · 海底交互与动效层
 *
 * 设计稿里**属于"演出"而不是"数据"**的那部分都收在这里，避免污染既有逻辑模块：
 *
 *   1. 环境气泡（floatUp）—— 纯装饰，reduced-motion 下整层隐藏
 *   2. 顶栏的房间成员药丸（真实人数，参与 sidebar 的成员页）
 *   3. 顶栏快捷操作：提示音开关 / 加密说明 / 房间菜单
 *   4. 三处**真实**连接信息：
 *        · 列表右上"信道"指示点 + 文案
 *        · 列表底部"中继"状态条
 *        · 输入区页脚
 *   5. 房间筛选 chips 的接线（真正的过滤逻辑在 sidebar.js 里）
 *
 * ⚠️ 这一层**不发明任何数据**。设计稿的"声纳频段 104.5 MHz / 深度压强 304 kPa"
 *    是氛围文案，这里一律换成中继 id / 探测延迟 / 连接数这些真实量。
 *    假数字比没有数字更糟 —— 用户会拿它当依据排查问题。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { dialog } from './dialog.js';
import { roster } from './roster.js';
import { collectRelayModel } from '../relay-model.js';

const $ = (id) => document.getElementById(id);

/** 环境气泡的配方（对齐设计稿 code.html 里那 6 颗） */
const BUBBLES = [
  { size: 26, left: 18, dur: 14, delay: 0 },
  { size: 14, left: 42, dur: 18, delay: 3 },
  { size: 38, left: 75, dur: 22, delay: 1.5 },
  { size: 18, left: 60, dur: 16, delay: 7 },
  { size: 22, left: 88, dur: 20, delay: 5 },
  { size: 12, left: 30, dur: 12, delay: 9 },
  { size: 30, left: 8, dur: 26, delay: 11 },
];

/** cubic-bezier(.42,0,.58,1) = CSS 的 ease-in-out（牛顿迭代解 x→t，够准了） */
function easeInOut(x) {
  const cx = 3 * 0.42;
  const bx = 3 * (0.58 - 0.42) - cx;
  const ax = 1 - cx - bx;
  const cy = 0;
  const by = 3 * (1 - 0) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const d = sampleX(t) - x;
    if (Math.abs(d) < 1e-4) break;
    const dx = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(dx) < 1e-6) break;
    t -= d / dx;
  }
  return sampleY(t);
}

/**
 * 气泡上浮路径的关键帧插值 —— 与旧 CSS `@keyframes floatUp` **逐项一致**，
 * 只是换了执行方式（画布按 12fps 画，见 `_paintAmbient` 的注释）。
 * 关键帧（百分比）：0 / 15 / 50 / 85 / 100；transform 段 0→50→100、opacity 四段，
 * 缓动都是 CSS 的 `ease-in-out`。
 * 返回 `ty` 的单位是 vh（viewport 高度的比例），调用方乘上实际像素。
 */
function floatUpAt(k) {
  let ty = 0;
  let tx = 0;
  let scale = 0.7;
  let alpha = 0;
  if (k <= 50) {
    const u = easeInOut(k / 50);
    ty = -0.55 * u;
    tx = 18 * u;
    scale = 0.7 + 0.3 * u;
  } else {
    const u = easeInOut((k - 50) / 50);
    ty = -0.55 - 0.55 * u;
    tx = 18 - 30 * u;
    scale = 1 + 0.15 * u;
  }
  if (k <= 15) alpha = 0.65 * easeInOut(k / 15);
  else if (k <= 50) alpha = 0.65 - 0.1 * easeInOut((k - 15) / 35);
  else if (k <= 85) alpha = 0.55 + 0.05 * easeInOut((k - 50) / 35);
  else alpha = 0.6 - 0.6 * easeInOut((k - 85) / 15);
  return { ty, tx, scale, alpha };
}

export const motion = {
  init(host) {
    this.host = host;
    this._paintAmbient();
    this._startPingTicker();
    this._wireHead();
    this._wireChips();
    this._wireFooter();
    // 连接状态一变，三处信息一起重画（它们读的是同一批数据）
    bus.on(EV.NODE_STATE, () => this.paintConnection());
    bus.on(EV.RELAYS, () => this.paintConnection());
    bus.on(EV.PRESENCE, ({ room }) => {
      if (room === this.host.currentRoom) this.paintMembers();
    });
    // 设置页改了会影响到顶栏的偏好（目前只有提示音），同步一次图标
    document.addEventListener('prefchange', () => this._syncSoundBtn());
    document.addEventListener('themechange', () => this.paintConnection());
    this.paintConnection();
    this.paintMembers();
    this._syncSoundBtn();
  },

  /* ------------------------------------------------------------ 环境气泡（低帧率画布） */
  //
  // 2026-10-13：从「7 个 DOM 元素各跑一条 CSS 动画」改成「一张画布按 ~12fps 统一画」。
  // 为什么：CSS 动画只要有一条在跑，浏览器就会**永远以 60fps 出帧** ——
  // 实测（软件合成）常驻 ~22% CPU；老 Intel Mac 上表现为"开着聊天页风扇就转"。
  // 画布版把出帧降到 ~12fps；视觉上仍是那 7 颗、同一条上浮路径与淡入淡出
  // （10% 透明度的慢速漂浮，12fps 的步进肉眼不可见）。窗口不可见/失焦时直接停画。
  _paintAmbient() {
    const box = $('ambient');
    if (!box || this._ambientStarted) return;
    this._ambientStarted = true;
    // 尊重"减少动态效果"：整层不画（CSS 那边也会把 .ambient 藏掉）
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient__canvas';
    box.appendChild(canvas);
    this._ambientCanvas = canvas;
    this._ambientCtx = canvas.getContext('2d');
    this._ambientT0 = performance.now();
    this._readAmbientColors();
    document.addEventListener('themechange', () => this._readAmbientColors());
    this._ambientTimer = setInterval(() => this._drawAmbient(), 1000 / 12);
    this._drawAmbient();
    // 测试钩子：气泡"颗数"从 DOM 节点数变成规格数（e2e 仍然盯 7）
    window.__iroh_ambient = { count: BUBBLES.length, frameMs: Math.round(1000 / 12) };
  },

  /** 气泡的描边/填充跟着主题走（--water-tint / --water-line，浅深两套） */
  _readAmbientColors() {
    const c = this._ambientCanvas;
    if (!c) return;
    const cs = getComputedStyle(c);
    this._ambientFill = cs.getPropertyValue('--water-tint').trim() || 'rgba(110, 236, 255, .10)';
    this._ambientLine = cs.getPropertyValue('--water-line').trim() || 'rgba(110, 236, 255, .30)';
  },

  _drawAmbient() {
    const c = this._ambientCanvas;
    const ctx = this._ambientCtx;
    if (!c || !ctx) return;
    if (document.hidden || !document.hasFocus()) return; // 看不见就不出帧
    const box = c.parentElement;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const vh = window.innerHeight;
    const t = (performance.now() - this._ambientT0) / 1000;
    ctx.fillStyle = this._ambientFill;
    ctx.strokeStyle = this._ambientLine;
    ctx.lineWidth = 1;
    for (const b of BUBBLES) {
      if (t < b.delay) continue; // CSS 的 animation-delay：还没上场（在屏幕下方候场）
      const k = (((t - b.delay) % b.dur) / b.dur) * 100;
      const f = floatUpAt(k);
      const size = b.size * f.scale;
      // `left: N%` 是**左边缘**；transform 的缩放围绕元素中心（origin: 50% 50%）。
      const cx = (b.left / 100) * w + b.size / 2 + f.tx;
      // 起点：bottom:-60px（元素底边在面板下缘再往下 60px）；ty 为负 = 向上。
      const cy = h + 60 - b.size / 2 + f.ty * vh;
      if (cy + size / 2 < 0 || cy - size / 2 > h) continue;
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },

  /**
   * 在线光点的"雷达环"：相位由 JS 每 ~83ms 写一次 `--ping`（0→1），
   * 环的 transform/opacity 在 CSS 里由它算出来（见 components.css）。
   * 走 JS 而不是 CSS 动画的理由同环境气泡：**别让任何 CSS 常驻动画把出帧锁死在 60fps**。
   */
  _startPingTicker() {
    if (this._pingTimer) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now();
    this._pingTimer = setInterval(() => {
      if (document.hidden || !document.hasFocus()) return;
      const now = performance.now() - t0;
      const pill = document.querySelector('#node-pill .pill__dot');
      if (pill) pill.style.setProperty('--ping', ((now % 2200) / 2200).toFixed(3));
      for (const dot of document.querySelectorAll('.row__dot.radar-ring')) {
        dot.style.setProperty('--ping', ((now % 2400) / 2400).toFixed(3));
      }
    }, 1000 / 12);
  },

  /* ------------------------------------------------------------ 顶栏快捷操作 */
  _wireHead() {
    // 成员药丸 → 成员页（没进房时它是隐藏的，不会点到这里）
    const members = $('room-members');
    // 「在线成员」页已合并进连接状态页（名单收在「在线成员」那一行下面）
    // 点"人数"看花名册（R2a）：谁在场、各自的名片、最近说过什么、一键 @。
    // 节点连接状态仍在花名册之外（侧栏"连接状态"页），两者是不同的问题。
    if (members) members.onclick = () => roster.open();

    // 提示音开关：直接改真实偏好（设置页里那个开关的另一个入口）
    const sound = $('btn-head-sound');
    if (sound) {
      sound.onclick = () => {
        const on = store.prefs().sound !== false;
        store.setPref('sound', !on);
        this._syncSoundBtn();
        document.dispatchEvent(new CustomEvent('prefchange', { detail: { key: 'sound' } }));
        bus.emit(EV.TIP, !on ? '提示音已开启' : '提示音已关闭');
      };
    }

    // 加密说明：把"到底保护了什么、没保护什么"讲清楚，不要给用户虚假的安全感
    const lock = $('btn-head-lock');
    if (lock) {
      lock.onclick = () =>
        dialog.open({
          title: '加密与隐私',
          body:
            '<div class="dialog__hint">' +
            '<b>端到端加密。</b>消息在浏览器里加密，中继只转发密文，看不到内容。<br />' +
            '<b>以下几点是事实，不是劝告：</b><br />' +
            '· 房间是<b>凭名字进入</b>的 —— 知道房间名的人都能进来，没有成员审批。<br />' +
            '· 常驻节点是房间成员，会读取并保存<b>文本历史</b>；历史数据库没有额外的静态加密。<br />' +
            '· 浏览器版<b>只能走中继</b>（打不了洞），所以中继能看到你的 IP 与在线时间。' +
            '</div>',
          okText: '知道了',
        });
    }

    // 房间菜单（备注名 / 置顶 / 移出）—— 和点标题是同一个入口
    const menu = $('btn-room-menu');
    if (menu) {
      menu.onclick = () => {
        if (!this.host.currentRoom) {
          bus.emit(EV.TIP, '先进一个房间');
          return;
        }
        this.host.roomMenu(this.host.currentRoom);
      };
    }
  },

  _syncSoundBtn() {
    const btn = $('btn-head-sound');
    if (!btn) return;
    const on = store.prefs().sound !== false;
    btn.classList.toggle('is-off', !on);
    btn.title = on ? '新消息提示音：开' : '新消息提示音：关';
  },

  /* ---------------------------------------------------------- 房间筛选 chips */
  _wireChips() {
    const box = $('panel-tabs');
    if (!box) return;
    box.querySelectorAll('.tab-chip').forEach((chip) => {
      chip.onclick = () => {
        box.querySelectorAll('.tab-chip').forEach((c) => {
          c.classList.toggle('is-on', c === chip);
        });
        this.host.roomFilter = chip.dataset.filter || 'all';
        this.host.render();
      };
    });
  },

  /* ---------------------------------------------------------------- 页脚信息 */
  _wireFooter() {
    // 探测结果是异步回来的，等它回来再刷一次
    bus.on(EV.NODE_STATE, () => setTimeout(() => this.paintConnection(), 300));
  },

  /** 当前"正在用"的中继（取第一台 connected 的；否则取第一台配置的） */
  _homeRelay() {
    const { home } = collectRelayModel(net.config, net.relayStatus(), net.probes);
    return home || { id: '—', url: '', connected: false, probe: null };
  },

  paintConnection() {
    const state = this.host.currentNodeState || { ok: false, text: '启动中', waiting: true };
    const model = collectRelayModel(net.config, net.relayStatus(), net.probes);
    const total = model.items.length;
    const okCount = model.okCount;
    const { id, connected, probe } = this._homeRelay();

    // ① 列表右上角"信道"指示
    const chip = $('channel-link');
    const chipDot = $('channel-dot');
    const chipText = $('channel-text');
    if (chip && chipDot && chipText) {
      chip.classList.remove('is-wait', 'is-bad');
      chipDot.classList.remove('is-wait', 'is-bad');
      if (state.waiting) {
        chip.classList.add('is-wait');
        chipDot.classList.add('is-wait');
        chipText.textContent = '连接中';
      } else if (state.ok) {
        chipText.textContent = '信道稳定';
      } else {
        chip.classList.add('is-bad');
        chipDot.classList.add('is-bad');
        chipText.textContent = '已断开';
      }
      chip.title = state.ok
        ? `中继已连接（${okCount}/${total}）· 点这里看连接诊断`
        : `${state.text} · 点这里看连接诊断`;
      chip.onclick = () => this.host.show('status');
    }

    // ② 列表底部状态条
    const footDot = $('panel-foot-dot');
    const footText = $('panel-foot-text');
    const footVer = $('panel-foot-ver');
    if (footDot && footText) {
      footDot.classList.remove('is-wait', 'is-bad');
      if (state.waiting) {
        footDot.classList.add('is-wait');
        footText.textContent = '正在接入中继…';
      } else if (state.ok) {
        footText.textContent = connected ? `中继 ${id}${probe?.ok && probe.rtt ? ` · HTTP ${Math.round(probe.rtt)}ms` : ''}` : '尚未连接中继';
      } else {
        footDot.classList.add('is-bad');
        footText.textContent = state.text || '中继未连接';
      }
    }
    if (footVer) footVer.textContent = total ? `${okCount}/${total} 中继` : 'iroh';

    // ③ 输入区页脚
    const connDot = $('conn-foot-dot');
    const connText = $('conn-foot-text');
    if (connDot && connText) {
      connDot.classList.remove('is-wait', 'is-bad', 'is-ok');
      if (state.waiting) {
        connDot.classList.add('is-wait');
        connText.textContent = '正在接入中继…';
      } else if (state.ok) {
        connDot.classList.add('is-ok');
        const rtt = probe?.ok && probe.rtt ? ` · HTTP 探测 ${Math.round(probe.rtt)}ms` : '';
        connText.textContent = connected ? `中继 ${id}${rtt}` : '尚未连接中继';
      } else {
        connDot.classList.add('is-bad');
        connText.textContent = state.text || '中继未连接，消息发不出去';
      }
    }

    // ④ 顶栏副行（设计稿 _1 的"● 在线 · 主中继 hk-1 延迟 130ms · 端到端水下加密"）。
    //    ⚠️ 设计稿里那句"信标载波 142.85 MHz / 丢失率 0.00%"是**编的**，
    //    这里只放真数据：中继 id + 实测延迟 + 加密事实。
    const sub = $('chat-subline');
    const subText = $('chat-subline-text');
    if (sub && subText) {
      const room = this.host.currentRoom;
      const rtt = probe?.ok && probe.rtt ? ` · HTTP ${Math.round(probe.rtt)}ms` : '';
      sub.classList.remove('is-ok', 'is-bad', 'is-wait');
      if (state.waiting) {
        sub.classList.add('is-wait');
        subText.textContent = '正在连接中继…';
      } else if (!state.ok) {
        sub.classList.add('is-bad');
        subText.textContent = `${state.text || '已断开'} · 消息发不出去`;
      } else if (!connected) {
        sub.classList.add('is-wait');
        subText.textContent = '尚未连接中继';
      } else if (room) {
        sub.classList.add('is-ok');
        subText.textContent = `在线 · 中继 ${id}${rtt} · 端到端加密`;
      } else {
        sub.classList.add('is-ok');
        subText.textContent = `中继 ${id}${rtt} 已连接 · 选择一个房间开始聊天`;
      }
    }
  },

  /**
   * 顶栏的"房间身份"：房间号徽标 + 成员药丸。
   *
   * ⚠️ 徽标只在**有备注名**（alias ≠ 房间名）时显示。
   *    设计稿里徽标是「111」、标题是「蟹堡王后厨绝密研讨室」—— 那是"房间号 + 备注名"。
   *    我们没有独立的房间号，房间名本身就是标识；没有备注名时徽标和标题一模一样，
   *    显示两遍同一个名字只是占地方。
   */
  paintMembers() {
    const pill = $('room-members');
    const text = $('room-members-text');
    const badge = $('room-badge');
    const room = this.host.currentRoom;

    // 顺手把标题规范化到"备注名 || 房间名"。
    // ⚠️ 为什么要在这里重复一遍 main.js 的赋值：改备注名走的是
    //    `roomrenamed` 事件，而**别处**（测试脚注里直接写 store 就是例子）
    //    改了 alias 不会触发那个事件 —— 标题就会停在旧值，于是徽标和标题
    //    显示同一个名字，看起来像重复渲染。这条赋值是幂等的，两边算的
    //    也是同一个值，不会互相打架。
    const alias = room ? store.room(room)?.alias || '' : '';
    const title = $('room-title');
    if (title && room) {
      const want = alias || room;
      if (title.textContent !== want) title.textContent = want;
    }

    if (badge) {
      const show = !!room && !!alias;
      badge.hidden = !show;
      badge.textContent = show ? room : '';
      if (show) badge.title = `房间名：${room}`;
    }

    if (!pill || !text) return;
    const joined = !!room && net.canSend && net._room === room;
    pill.hidden = !joined;
    if (!joined) return;
    const n = this.host.memberCount();
    text.textContent = `${n} 人`;
    pill.title = `当前房间在线 ${n} 人（含自己）· 点击查看成员`;
  },
};
