/* ============================================================================
 * ui/topology.js · 中继拓扑视图（设计稿 _1 的「声呐拓扑」）
 *
 * ## 为什么名字改了
 *
 * 设计稿叫「声呐拓扑」，画的是"深海声呐节点分布图"，上面写着
 * `GEO: 11°21'N 142°12'E · 深度 3,000m`、`负载 18%`、`Gossip 0.42 秒/周期`、
 * `256 Bit 强度` —— **这些数字全都拿不到**：中继不报地理位置、不报负载，
 * gossip 周期没暴露给前端，加密强度也不是 256 这个数（我们只确定"端到端"）。
 *
 * 照抄的话，这一页会变成一个**看起来最专业、其实全是编的**页面，
 * 而它恰恰是用户"网络出问题"时最可能打开的那一页。
 * 所以：位置保留、视觉沿用，内容全部换成真量，名字改成**中继拓扑**。
 *
 * ## 能诚实画出来的拓扑长什么样
 *
 * 我们是浏览器版，**永久 relay-only**（打不了洞），所以拓扑结构只展示当前浏览器到中继的实际路径：
 *
 *     本机（浏览器）── 已连接中继；备选中继另列，延迟为 HTTP 健康探测
 *
 * 每一段都是真的：id / region / 连接态 / 探测延迟都来自
 * `net.relayStatus()` + `net.probes` + `relay-config.json`。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { ico, regionLabel } from './primitives.js';
import * as U from '../util.js';
import { collectRelayModel, probeLatency } from '../relay-model.js';

const $ = (id) => document.getElementById(id);

export const topology = {
  /** 'chat' | 'topology' */
  view: 'chat',

  init(host) {
    this.host = host;
    const tabs = $('view-tabs');
    if (tabs) {
      tabs.querySelectorAll('.view-tab').forEach((tab) => {
        tab.onclick = () => this.show(tab.dataset.view);
      });
    }
    // 连接/成员一变就重画（这一页整个都是连接状态的可视化）
    for (const ev of [EV.NODE_STATE, EV.RELAYS, EV.PRESENCE, EV.ROOM_LEFT, EV.PEER_UP, EV.PEER_DOWN]) {
      bus.on(ev, () => this.paint());
    }
  },

  show(view) {
    this.view = view === 'topology' ? 'topology' : 'chat';
    const tabs = $('view-tabs');
    if (tabs) {
      tabs.querySelectorAll('.view-tab').forEach((tab) => {
        const on = tab.dataset.view === this.view;
        tab.classList.toggle('is-on', on);
        tab.setAttribute('aria-selected', String(on));
      });
    }
    const panel = $('topology');
    if (panel) {
      panel.classList.toggle('is-on', this.view === 'topology');
      panel.setAttribute('aria-hidden', String(this.view !== 'topology'));
    }
    if (this.view === 'topology') this.paint();
  },

  /* ---------------------------------------------------------------- 数据 */
  _model() {
    return {
      ...collectRelayModel(net.config, net.relayStatus(), net.probes),
      rtt: (probe) => probeLatency(probe).text,
      rttNum: (probe) => probeLatency(probe).milliseconds,
    };
  },

  /* ---------------------------------------------------------------- 渲染 */
  paint() {
    const panel = $('topology');
    if (!panel || this.view !== 'topology') return;   // 没显示就别白算

    const m = this._model();
    const state = this.host.currentNodeState || { ok: false, text: '启动中', waiting: true };
    const stCls = state.waiting ? 'is-wait' : state.ok ? 'is-ok' : 'is-bad';
    const room = this.host.currentRoom;
    const myId = net.endpoint_id() || '';
    const peers = this.host.neighbors.size;
    const homeRtt = m.rtt(m.home?.probe);
    const homeRttNum = m.rttNum(m.home?.probe);
    const cfgTotal = m.items.length || 1;

    /* ---- 三张指标卡（全部真量） ---- */
    const card = ({ icon, label, num, unit, bar, foot, name }) => `
      <div class="topo-card" data-metric="${name}">
        <div class="topo-card__head">
          <span class="topo-card__label">${U.esc(label)}</span>
          ${ico(icon, 'ico-inline')}
        </div>
        <div class="topo-card__numwrap">
          <span class="topo-card__num">${U.esc(num)}</span>
          <span class="topo-card__unit">${U.esc(unit)}</span>
        </div>
        ${bar === null ? '<div class="topo-card__bar"></div>' : `<div class="topo-card__bar"><i style="width:${bar}%"></i></div>`}
        <div class="topo-card__foot">${foot}</div>
      </div>`;

    const metrics =
      card({
        icon: 'dns', name: 'relays', label: '中继集群',
        num: String(m.items.length), unit: '台配置',
        bar: Math.round((m.okCount / cfgTotal) * 100),
        foot: `在用 <b>${m.okCount}</b> 台${m.home ? ` · 主链路 ${U.esc(m.home.id)}` : ''}`,
      }) +
      card({
        icon: 'sensors', name: 'latency', label: 'HTTP 探测延迟',
        num: homeRttNum === null ? '—' : String(homeRttNum), unit: homeRttNum === null ? '' : 'ms',
        bar: null,
        foot: m.home
          ? `${U.esc(`${m.home.id}${m.home.region ? ` ${regionLabel(m.home.region)}` : ''}`)} · ${U.esc(homeRtt)}`
          : '还没有接入任何中继',
      }) +
      card({
        icon: 'wave', name: 'gossip', label: 'Gossip 邻居',
        num: String(peers), unit: '个直连',
        bar: null,
        foot: peers ? '覆盖网局部视图，<b>不等于</b>房间人数' : '只有自己时是正常的',
      });

    /* ---- 链路图 ---- */
    const nodeCls = (kind) => (kind === 'home' ? 'is-home' : 'is-standby');
    const homeLabel = m.home
      ? `${m.home.id}${m.home.region ? ` ${regionLabel(m.home.region)}` : ''}`
      : '未接入';
    const chain = `
      <div class="topo-chain">
        <div class="topo-node is-local">
          <span class="topo-node__ico">${ico('home', 'ico-plain')}</span>
          <span class="topo-node__t">本机</span>
          <span class="topo-node__s">${U.esc(U.shortId(myId, 8) || '—')}</span>
        </div>
        <div class="topo-link${m.home ? '' : ' is-dead'}">
          <span class="topo-link__t">${U.esc(m.home ? `HTTP 探测 ${homeRtt}` : '未连接')}</span>
        </div>
        <div class="topo-node ${nodeCls('home')}">
          <span class="topo-node__ico">${ico('dns', 'ico-plain')}</span>
          <span class="topo-node__t">${U.esc(homeLabel)}</span>
          <span class="topo-node__s">${m.home?.connected ? '主链路 · 在用' : '未在用'}</span>
        </div>
      </div>`;

    const standby = m.standbys.length
      ? `<div class="topo-standbys">
           <span class="topo-standbys__t">备选链路</span>
           ${m.standbys
             .map(
               (it) => `<span class="topo-chip${it.enabled === false ? ' is-off' : ''}" title="${U.esc(it.url)}">
                 <i class="topo-chip__dot${it.connected === true ? ' is-ok' : it.connected === false ? ' is-bad' : ''}"></i>
                 ${U.esc(`${it.id}${it.region ? ` ${regionLabel(it.region)}` : ''}`)}
                 <b>${U.esc(m.rtt(it.probe))}</b>
               </span>`,
             )
             .join('')}
         </div>`
      : '';

    panel.innerHTML = `
      <div class="topo-grid">${metrics}</div>

      <div class="topo-map">
        <div class="topo-map__head">
          <span class="topo-map__title">链路拓扑</span>
          <span class="topo-map__note">浏览器版使用 relay-only；仅展示当前连接和已配置备选</span>
        </div>
        ${chain}
        ${standby}
      </div>

      <div class="topo-foot">
        <span class="conn-foot__dot ${stCls}"></span>
        <span>${U.esc(state.text)}${room ? ` · 当前房间 ${U.esc(room)}` : ' · 未进入房间'}</span>
        <span class="topo-foot__spacer"></span>
        <button class="btn-block topo-foot__btn" data-topo="reprobe" type="button">
          ${ico('anchor', 'ico-plain')}<span>重新探测所有中继</span>
        </button>
      </div>`;

    // ⚠️ 拓扑页不在 `#panel-body` 里，`sidebar.render()` 的 `[data-act]` 绑定
    //    覆盖不到它 —— 这里的按钮要自己接线，否则点上去没反应。
    const btn = panel.querySelector('[data-topo="reprobe"]');
    if (btn) {
      btn.onclick = () => {
        bus.emit(EV.TIP, '正在探测中继…');
        net.probe().then(() => {
          const best = (net.probes || []).filter((p) => p.ok).map((p) => `${p.id} ${m.rtt(p)}`);
          bus.emit(EV.TIP, best.join(' · ') || '全部不可达');
          this.paint();
        });
      };
    }
  },
};
