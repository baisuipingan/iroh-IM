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

export const motion = {
  init(host) {
    this.host = host;
    this._paintAmbient();
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

  /* ---------------------------------------------------------------- 环境气泡 */
  _paintAmbient() {
    const box = $('ambient');
    if (!box || box.childElementCount) return;   // 只生成一次
    const frag = document.createDocumentFragment();
    for (const b of BUBBLES) {
      const el = document.createElement('div');
      el.className = 'ambient__b';
      el.style.width = `${b.size}px`;
      el.style.height = `${b.size}px`;
      el.style.left = `${b.left}%`;
      el.style.animationDuration = `${b.dur}s`;
      el.style.animationDelay = `${b.delay}s`;
      frag.appendChild(el);
    }
    box.appendChild(frag);
  },

  /* ------------------------------------------------------------ 顶栏快捷操作 */
  _wireHead() {
    // 成员药丸 → 成员页（没进房时它是隐藏的，不会点到这里）
    const members = $('room-members');
    // 「在线成员」页已合并进连接状态页（名单收在「在线成员」那一行下面）
    if (members) members.onclick = () => this.host.show('status');

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
