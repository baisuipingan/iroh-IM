/* ============================================================================
 * sidebar/status.js · 连接状态页（侧栏第二个标签）
 *
 * 结构（对齐设计稿 `stitch_bikini_bottom_chat_ui 2/_1`）：
 *   连接概况 / 我的身份凭证 / 中继节点网络 / 整宽动作按钮
 *
 * ⚠️ 设计稿里的氛围文案一律换成**真实数据** ——
 *    "3000m 专线"、"香港海沟中继"、"信标载波 142.85 MHz"、"丢失率 0.00%"
 *    全是编的。这一页是排障用的，它只需要回答两个问题：
 *    **能不能用**、**为什么不能用**。
 *
 * 本文件分两段：
 *   1. collectStatus()—— 纯数据组装（读 net/store，算出要显示什么）
 *   2. renderStatus() —— 出 HTML + 绑事件
 * 拆开的理由：原来这两件事绞在一个 318 行函数里，改文案要翻过一堆计算。
 * ==========================================================================*/

import { bus, EV } from '../../bus.js';
import { net } from '../../net.js';
import { store } from '../../store.js';
import * as U from '../../util.js';
import { avatar, ico, regionLabel } from '../primitives.js';
import { collectRelayModel, probeLatency } from '../../relay-model.js';

/**
 * ⚠️ 判"探通没探通"用 `p.ok`，不能用 `p.rtt`：中继**可达但读不到计时**时
 *    （缺 Timing-Allow-Origin）ok=true、rtt=null，只看 rtt 会误标成不可达。
 */
export function rttOf(pr) {
  const latency = probeLatency(pr);
  return { text: latency.text, plain: latency.text, cls: latency.reachable === null ? '' : latency.reachable ? 'is-ok' : 'is-bad' };
}

/**
 * ⚠️ 措辞要准确：`relayStatus()` 来自 `endpoint.home_relay_status()`，
 *    它**只上报当前作为 home 的那一台**，而不是配置里的全部。
 *    所以"运行时没提它" ≠ "它坏了"（探测可能明明可达）—— 只是**没在用**。
 *    写"未知"会让人以为出问题了，写"未连接"更是错的。
 */
function relayState(it) {
  if (it.enabled === false) return { text: '已禁用', dim: true };
  if (it.connected === true) return { text: '主链路 · 在用', dim: false };
  if (it.connected === false) return { text: '连接异常', dim: true };
  return { text: '冷备节点 · 未使用', dim: true };
}

function relayTip(it) {
  const lines = [it.url];
  if (it.enabled === false) { lines.push('配置里已禁用（enabled: false）—— 不会参与选路'); return lines.join('\n'); }
  if (it.connected === false) lines.push('连接失败');
  else if (it.connected == null) lines.push('当前不是这台在用（浏览器版同一时刻只挂一台 home 中继）');
  if (it.probe && !it.probe.ok) lines.push(`探测不可达${it.probe.error ? `：${it.probe.error}` : ''}`);
  else if (it.probe?.rtt) lines.push(`探测延迟 ${Math.round(it.probe.rtt)}ms`);
  return lines.join('\n');
}

/**
 * 把三份数据按 url 合成一行：
 *   配置（id / region / url） + 运行时（connected） + 探测（ok / rtt）
 *
 * ⚠️ 三份数据的 url 写法**不一致**：运行时那份带结尾斜杠
 *    （Rust 侧给的是 `https://iroh1.editor.vip:15443/`），而配置与探测结果不带。
 *    不归一化的话按 url 关联会全部落空、状态一律显示"未知"
 *    （实测踩到：标题写着「1/1 已连接」，下面三行却全是「未知」）。
 */
export function collectRelays() {
  return collectRelayModel(net.config, net.relayStatus(), net.probes);
}

/** 成员头像叠层 —— 真实 presence（自己 + 其他成员），超出 3 个就 +N */
function avatarStack(host) {
  const anchorId = net.config?.anchor?.id || '';
  // 常驻节点本身也会出现在 peers 里（它是个真实端点）。
  // ⚠️ 这个 `anchor` 原来声明在 `view_people` 里；成员页合并进来之后必须在这里
  //    重新声明 —— 删掉成员页时漏了它，整个状态页会抛 ReferenceError 变空白（踩过）。
  const anchor = anchorId ? host.peers.find((p) => p.id === anchorId) : null;
  const others = host.peers.filter((p) => p.id !== anchorId && p.id !== net.endpoint_id());
  const names = [store.nick(), ...others.map((p) => p.nickname)].filter(Boolean);
  const avatars =
    names.slice(0, 3).map((n) => `<span class="avstack__i" style="background:${U.colorOf(n)}">${U.esc(U.initial(n))}</span>`).join('') +
    (names.length > 3 ? `<span class="avstack__i is-more">+${names.length - 3}</span>` : '');
  return { anchor, anchorId, others, avatars };
}

/**
 * 成员名单（合并自原来的「在线成员」页）。
 * 这一页**唯一**不可替代的东西就是这份名单：昵称 + 身份 ID 前缀 + 上次心跳。
 * 人数和头像在顶栏和上面的统计行里都有，不重复。
 */
function memberRow(nickname, id, sub) {
  return `
  <div class="member">
    ${avatar(nickname, 'avatar--sm')}
    <div class="member__body">
      <span class="member__name">${U.esc(nickname)}</span>
      <span class="member__sub" title="${U.esc(id)}">${U.esc(sub)}</span>
    </div>
  </div>`;
}

/** 渲染连接状态页。@param host sidebar 单例 @param q 搜索词 */
export function renderStatus(host, q = '') {
  const { items, okCount, cfgCount } = collectRelays();

  const state = host.currentNodeState || { ok: false, text: '启动中', waiting: true };
  const stCls = state.waiting ? 'is-wait' : state.ok ? 'is-ok' : 'is-bad';

  const myId = net.endpoint_id() || '';
  // 64 位 hex 连排几乎读不出，按 8 位一组
  // （⚠️ sidebar-pages.py 会数分组：必须 8 组 × 8 字符，别改这个格式）
  const idGrouped = myId.replace(/(.{8})/g, '$1 ').trim();

  const room = host.currentRoom;
  const alias = room ? store.room(room)?.alias || '' : '';
  const members = host.memberCount();
  const joined = !!room && net.canSend && net._room === room;

  // 筛选（搜索框）：中继按 id/区域/url 命中，统计行按标签文本命中
  const hit = (t) => !q || String(t || '').toLowerCase().includes(q);

  /* ---- 统计行 ----
   * `expand` 不为空时这一行可点开，用来把「在线成员」的名单收在「在线成员」
   * 这一行下面 —— 成员页合并进这一页之后就是这么放的。 */
  const stat = ({ icon, label, right = '', foot = '', keys = '', expand = '' }) => ({
    keys: `${label} ${keys}`,
    expand,
    html:
      `<div class="stat${expand ? ' stat--expand' : ''}"${expand
        ? ` data-expand="${expand}" role="button" tabindex="0" aria-expanded="false"`
        : ''}>
         <div class="stat__l">${ico(icon)}<span class="stat__label">${U.esc(label)}</span></div>
         <div class="stat__r">${right}${expand ? '<span class="stat__chev">›</span>' : ''}</div>
       </div>` + (foot ? `<div class="stat__foot">${foot}</div>` : ''),
  });

  const { anchor, anchorId, others, avatars } = avatarStack(host);

  const roomValue = room
    ? `<span class="room-code">
         <span class="room-code__t">${U.esc(room)}</span>
         <button class="room-code__copy" data-act="copy-room" data-room="${U.esc(room)}" title="复制房间名" type="button">${ico('copy', 'ico-plain')}</button>
       </span>`
    : '<span class="state-pill">未进入</span>';
  const roomFoot = room
    ? `${U.esc(alias || '未设备注名')} · 端到端加密（中继只转发密文）`
    : '还没有进入任何房间';

  const peersN = host.neighbors.size;
  const stats = [
    stat({
      icon: 'sensors', label: '节点状态', keys: state.text,
      right: `<span class="state-pill ${stCls}"><span class="state-pill__dot"></span>${U.esc(state.text)}</span>`,
    }),
    stat({ icon: 'door', label: '当前房间', right: roomValue, foot: roomFoot, keys: `${room} ${alias}` }),
    stat({
      icon: 'people', label: '在线成员', keys: `${members} 人`, expand: 'members',
      // 药丸只放数字：「N 人（含自己）」在 268px 的面板里会把标签挤成竖排（踩过）。
      // "含自己"挪到下面那行说明里，信息一点没少。
      right: `${avatars ? `<span class="avstack">${avatars}</span>` : ''}<span class="state-pill">${members} 人</span>`,
      foot: joined
        ? `${members} 人含自己 · 点这一行看名单（含身份 ID 前缀）`
        : `${members} 人含自己 · 进房成功后才会有成员心跳`,
    }),
    // 「常驻节点」原来在成员页里。它其实是"历史能不能读到"这件事的答案，
    // 属于连接诊断，所以合并时归到这一卡，而不是跟成员混在一起。
    stat({
      icon: 'archive', label: '历史节点', keys: anchor ? '已接入' : '尚未接入',
      right: anchorId
        ? `<span class="state-pill ${anchor ? 'is-ok' : ''}">${anchor ? '已接入' : '尚未接入'}</span>`
        : '<span class="state-pill">未配置</span>',
      foot: !anchorId
        ? '没有配置常驻节点 ⇒ 这个房间不会有历史消息'
        : anchor
          ? `${U.shortId(anchorId, 12)} · 提供本房间的文本历史`
          : '它是被拉历史时才订阅的，通常 10~15 秒内接入（这一段是心跳周期，不是故障）',
    }),
    stat({
      icon: 'radar', label: 'Gossip 邻居发现', keys: `${peersN} 个邻居`,
      right: peersN
        ? `<span class="state-pill is-ok">${peersN} 个直连</span>`
        : '<span class="state-pill">暂无直连邻居</span>',
      foot: peersN ? '邻居是覆盖网的局部视图，不等于房间人数' : '只有自己时是正常的 —— 邻居只是覆盖网的局部视图',
    }),
  ];

  const membersBody =
    (others.length
      ? others.map((p) => memberRow(p.nickname, p.id, `${U.shortId(p.id, 10)} · ${U.relTime(p.lastSeenMs)}`)).join('')
      : '<div class="members__empty">房间里还没有其他人在线</div>') +
    memberRow(store.nick(), myId, `${U.shortId(myId, 10)} · 我自己`);

  const membersHtml = `<div class="members${host._membersOpen ? ' is-open' : ''}" id="status-members">
      <div class="members__hint">依据近期心跳估计，异常退出可能延迟约 45 秒更新。</div>
      ${membersBody}
    </div>`;

  // 统计行与成员名单要**按顺序拼**：名单紧跟「在线成员」那一行
  const parts = [];
  for (const r of stats) {
    if (!hit(r.keys)) continue;
    parts.push(r.html);
    if (r.expand === 'members') parts.push(membersHtml);
  }
  const statHtml = parts.join('') || '<div class="empty">没有匹配的项</div>';

  /* ---- 中继行（设计稿是两行：名称 + 状态，右侧 rtt 药丸） ---- */
  const shown = items.filter((it) => hit(`${it.id} ${it.region} ${it.url}`));
  const relayHtml = shown.length
    ? shown
        .map((it) => {
          const st = relayState(it);
          const rtt = rttOf(it.probe);
          const netCls = it.enabled === false ? '' : it.connected === true ? 'is-ok' : it.connected === false ? 'is-bad' : '';
          return `
          <div class="relay${st.dim ? ' is-dim' : ''}" title="${U.esc(relayTip(it))}">
            <div class="relay__left">
              <i class="relay__net ${netCls}"></i>
              <div class="relay__text">
                <span class="relay__name"><span class="relay__id">${U.esc(it.id)}</span>${
                  it.region ? `<span class="relay__region">${U.esc(regionLabel(it.region))}</span>` : ''
                }</span>
                <span class="relay__state${netCls === 'is-ok' ? ' is-ok' : ''}">${U.esc(st.text)}</span>
              </div>
            </div>
            <span class="relay__rtt ${rtt.cls}">${U.esc(rtt.text)}</span>
          </div>`;
        })
        .join('')
    : `<div class="empty">${q ? '没有匹配的中继' : '暂无中继信息'}</div>`;

  return {
    html:
      `<div class="pcard">
         <div class="section-title section-title--row">
           <span>连接概况</span>
           <span class="pcard__note${state.ok && !state.waiting ? ' is-live' : ''}">
             <i class="pcard__note__dot"></i>${state.ok && !state.waiting ? '信道活跃' : U.esc(state.text)}
           </span>
         </div>
         ${statHtml}
       </div>

       <div class="pcard">
         <div class="section-title section-title--row">
           <span>我的身份凭证</span>
           ${ico('shield', 'stat__ico stat__ico--plain')}
         </div>
         ${myId ? `<div class="id-hex" title="${U.esc(myId)}">${U.esc(idGrouped)}</div>` : '<div class="empty">节点还没起来</div>'}
         ${
           myId
             ? `<button class="btn-block" data-act="copy-id" type="button">${ico('key', 'ico-plain')}<span>复制身份 ID</span></button>`
             : ''
         }
         <div class="stat__foot" style="padding-left:2px">这是<b>公开</b>身份 ID，可以分享用于识别你；身份私钥存在浏览器里，切勿分享。</div>
       </div>

       <div class="pcard">
         <div class="section-title section-title--row">
           <span>中继节点网络 · 已连接 ${okCount} · 配置 ${cfgCount || items.length}</span>
           <span class="pcard__note">${net.probing ? '探测中…' : `${shown.length}/${items.length} 台`}</span>
         </div>
         ${relayHtml}
       </div>

       <div class="pcard">
         <button class="btn-block" data-act="reprobe" type="button">${ico('anchor', 'ico-plain')}<span>重新探测所有中继</span></button>
         ${
           net.phase === 'online'
             ? ''
             : `<button class="btn-block" data-act="reconnect" type="button">${ico('refresh', 'ico-plain')}<span>立即重新连接</span></button>`
         }
       </div>`,

    bind: (root) => {
      // ⚠️ 选择器是 `[data-act]`（不是 `.set-row[data-act]`）——
      //    复制按钮和整宽按钮都不在 `.set-row` 里，用旧选择器它们永远不会被绑定。
      const handler = (el) => (e) => {
        const act = el.dataset.act;
        if (act === 'copy-room') {
          e?.stopPropagation?.();
          const name = el.dataset.room || '';
          if (!name) return;
          navigator.clipboard
            ?.writeText(name)
            .then(() => bus.emit(EV.TIP, '已复制房间名'))
            .catch(() => bus.emit(EV.TIP, '复制失败，请手动复制'));
          return;
        }
        if (act === 'reconnect') {
          net.reconnect();
          bus.emit(EV.TIP, '正在重新连接中继…');
          return;
        }
        if (act === 'reprobe') {
          bus.emit(EV.TIP, '正在探测中继…');
          host.render(); // 立刻显示"探测中…"
          net.probe().then(() => {
            const best = net.probes.filter((pr) => pr.ok).map((pr) => `${pr.id} ${rttOf(pr).plain}`);
            bus.emit(EV.TIP, best.join(' · ') || '全部不可达');
            host.render();
          });
          return;
        }
        host._settingsAction(act, el);
      };
      root.querySelectorAll('[data-act]').forEach((el) => { el.onclick = handler(el); });

      // 「在线成员」那一行：点开/收起名单。
      // ⚠️ 展开态必须记在 `host._membersOpen` 上 —— `render()` 会整段重绘 innerHTML，
      //    而存在心跳（约 15 秒一轮）会让状态页不断重绘；不存的话名单会被反复收起。
      const row = root.querySelector('[data-expand="members"]');
      if (row) {
        const toggle = () => {
          host._membersOpen = !host._membersOpen;
          const box = root.querySelector('#status-members');
          if (box) box.classList.toggle('is-open', host._membersOpen);
          row.classList.toggle('is-open', host._membersOpen);
          row.setAttribute('aria-expanded', String(host._membersOpen));
          // 侧栏变高了，把刚展开的名单滚进视野（否则在面板底部会看不到）
          if (host._membersOpen) box?.querySelector('.member')?.scrollIntoView({ block: 'nearest' });
        };
        row.onclick = toggle;
        row.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        };
        if (host._membersOpen) {
          row.classList.add('is-open');
          row.setAttribute('aria-expanded', 'true');
        }
      }
    },
  };
}
