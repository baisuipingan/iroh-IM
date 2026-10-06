/* ============================================================================
 * sidebar/settings.js · 设置页（侧栏第三个标签）+ 设置项动作处理
 *
 * 版式（对齐设计稿 `stitch_bikini_bottom_chat_ui 2/_2`）：
 *   资料卡 → 工具条 → 小标签分组（资料/外观/通知/连接/数据/危险/关于）→ 页脚
 *
 * ⚠️ 设计稿的配置项**比本项目实际少一位数**（用户已确认：以现有功能为准，
 *    只借用它的版式）。所以这里是"设计稿的版式 + 本项目的全部真实开关"，一件没删：
 *
 *      本项目有、设计稿没有的：连接诊断入口、身份 ID、数据用量、导出本地数据、
 *        清除本地记录、更换身份密钥、清空全部、关于（传输/加密/浏览器/文件传输）
 *      设计稿有、本项目没有的：主题壁纸（**已补**，见 WALLPAPERS。默认"纯净海面"
 *        = 完全不改变现状，否则老用户一升级画布就变了）、
 *        深海消息震动/弹窗（**没补** —— 那要申请系统通知权限，还牵扯"消息内容
 *        要不要显示在锁屏上"，是产品决策不是换皮，见改造报告）
 *
 * 本文件两个导出：
 *   renderSettings(host, q)—— 出 HTML + 绑事件
 *   settingsAction(host, act, el)—— 处理所有 [data-act] 点击
 * ==========================================================================*/

import { bus, EV } from '../../bus.js';
import { net } from '../../net.js';
import { store } from '../../store.js';
import { dialog } from '../dialog.js';
import { theme } from '../theme.js';
import { permission as notifyPermission } from '../notify.js';
import * as U from '../../util.js';
import { avatar, ico, WALLPAPERS } from '../primitives.js';

/* ------------------------------------------------------------------ 行构造器
 *
 * 都返回 `{ keys, html }` —— 多带一个 `keys` 是为了让搜索框能按行文本过滤。
 * -------------------------------------------------------------------- */

const rowToggle = (act, label, on, hint = '') => ({
  keys: `${label} ${hint}`,
  html:
    `<div class="set-row set-row--toggle">
       <div class="set-row__text">
         <div class="set-row__label">${U.esc(label)}</div>
         ${hint ? `<div class="set-row__hint">${U.esc(hint)}</div>` : ''}
       </div>
       <button class="switch ${on ? 'is-on' : ''}" data-toggle="${act}" role="switch"
               aria-checked="${on}" title="${on ? '点击关闭' : '点击开启'}" type="button"><i></i></button>
     </div>`,
});

const rowNav = (act, label, value = '', sub = '') => ({
  keys: `${label} ${sub} ${value}`,
  html:
    `<div class="set-row set-row--nav" data-act="${act}">
       <div class="set-row__text">
         <div class="set-row__label">${U.esc(label)}</div>
         ${sub ? `<div class="set-row__hint">${U.esc(sub)}</div>` : ''}
       </div>
       <div class="set-row__right">
         ${value ? `<span class="set-row__value">${U.esc(value)}</span>` : ''}
         <span class="chev">›</span>
       </div>
     </div>`,
});

const rowField = (label, hint, control) => ({
  keys: `${label} ${hint}`,
  html:
    `<div class="set-row set-row--field">
       <div class="set-row__text">
         <div class="set-row__label">${U.esc(label)}</div>
         ${hint ? `<div class="set-row__hint">${U.esc(hint)}</div>` : ''}
       </div>
       ${control}
     </div>`,
});

const rowDanger = (act, label, sub) => ({
  keys: `${label} ${sub}`,
  html:
    `<div class="set-row set-row--danger" data-act="${act}">
       <div class="set-row__text">
         <div class="set-row__label">${U.esc(label)}</div>
         <div class="set-row__hint">${U.esc(sub)}</div>
       </div>
       <span class="chev">›</span>
     </div>`,
});

const rowKv = (k, v) => ({
  keys: `${k} ${v}`,
  html: `<div class="kv"><span class="kv__k">${U.esc(k)}</span><span class="kv__v">${U.esc(v)}</span></div>`,
});

/** 组装分组（顺带做搜索过滤：整组没命中任何行就整组不画） */
function renderGroups(hit) {
  const prefs = store.prefs();
  const themePref = theme.pref;
  const myId = net.endpoint_id();
  const usage = store.usage();
  const wallpaper = WALLPAPERS.some((w) => w.id === prefs.wallpaper) ? prefs.wallpaper : 'none';
  const st = sidebarState();

  const groups = [
    {
      label: '资料', icon: 'card',
      rows: [
        rowNav('nick', '昵称', store.nick(), '房间里别人看到的名字'),
        rowField(
          '发送快捷键', '回车直接发送',
          `<select class="mini-select" data-pref="sendKey">
             <option value="enter" ${prefs.sendKey !== 'ctrl' ? 'selected' : ''}>Enter</option>
             <option value="ctrl" ${prefs.sendKey === 'ctrl' ? 'selected' : ''}>Ctrl + Enter</option>
           </select>`,
        ),
        rowNav('newroom', '新建 / 加入房间', '', '同名即同房间'),
      ],
    },
    {
      label: '外观', icon: 'palette',
      rows: [
rowField(
            '主题', themeHint(),
            // ⚠️ 选项文案**仍然**要短，但原因变了。
            //    以前 `.mini-select` 是 width:auto —— `<select>` 的宽度由**最宽的 option**
            //    撑出来，写「浅色（比奇堡清晨）」会把 select 撑到 ~150px，把左边的 hint
            //    只剩 100px，必然折行（实测）。
            //    现在 `.mini-select` 有了固定宽度预算 108px（见 components.css），
            //    但**弹出的菜单宽度仍跟着 option 走** —— 文案太长会让菜单横向溢出面板。
            //    所以：短标签 + 说明放 hint，这条规则继续有效。
            `<select class="mini-select" data-theme-pref>
             <option value="auto" ${themePref === 'auto' ? 'selected' : ''}>跟随系统</option>
             <option value="light" ${themePref === 'light' ? 'selected' : ''}>浅色</option>
             <option value="dark" ${themePref === 'dark' ? 'selected' : ''}>深色</option>
           </select>`,
          ),
        rowField(
          '消息密度', '紧凑模式更省空间',
          `<select class="mini-select" data-pref="density">
             <option value="cozy" ${prefs.density !== 'compact' ? 'selected' : ''}>标准</option>
             <option value="compact" ${prefs.density === 'compact' ? 'selected' : ''}>紧凑</option>
           </select>`,
        ),
        // 主题壁纸 —— 设计稿有、本项目原来没有，自行补的设计。
        // 只改对话区的背景光，不动气泡的底色/对比度（改气泡会让正文读不清）。
        {
          keys: `主题壁纸 背景 对话区 ${WALLPAPERS.map((w) => w.label).join(' ')}`,
          html:
            `<div class="set-row set-row--block">
               <div class="set-row__text">
                 <div class="set-row__label">主题壁纸</div>
                 <div class="set-row__hint">只改对话区的水下光，不影响气泡对比度</div>
               </div>
               <div class="wl-grid">
                 ${WALLPAPERS.map(
                   (w) => `<button class="wl-tile ${w.id === wallpaper ? 'is-on' : ''}" data-wallpaper="${w.id}"
                             type="button" title="${U.esc(w.label)}" aria-pressed="${w.id === wallpaper}">
                             <span class="wl-tile__bg" data-wl="${w.id}"></span>
                             <span class="wl-tile__t">${U.esc(w.label)}</span>
                           </button>`,
                 ).join('')}
               </div>
             </div>`,
        },
      ],
    },
    {
      label: '通知', icon: 'bell',
      rows: [
        // ⚠️ 设计稿的提示音说明是"海螺短号音效"——那是氛围文案，我们合成的是正弦"叮"。
        rowToggle('sound', '新消息提示音', prefs.sound !== false, '需先有一次操作（浏览器策略）'),
        rowToggle('flashTitle', '标题显示未读数', prefs.flashTitle !== false, '标签页标题前加 (N)'),
        // 桌面通知（设计稿的「深海消息震动/弹窗」）。
        // ⚠️ 提示里显示**真实权限**，而不是笼统的"需要授权" ——
        //    最常见的坑是开关是开的、系统里却一直是拒绝，用户以为能收到。
        rowToggle(
          'notify',
          '桌面通知',
          prefs.notify === true,
          {
            unsupported: '这个浏览器不支持桌面通知',
            denied: '权限被拒绝（见站点设置）',
            granted: '切走页面时才会弹（已授权）',
            default: '打开时会请求系统通知权限',
          }[notifyPermission()] || '切走页面时才会弹',
        ),
        rowToggle(
          'notifyContent',
          '通知里显示消息内容',
          prefs.notifyContent !== false,
          '关闭后只提示「新消息」',
        ),
      ],
    },
    {
      label: '连接', icon: 'radar',
      rows: [
        rowNav('status', '连接诊断', st.ok && !st.waiting ? '在线' : st.text, '中继、延迟、邻居、重连'),
        rowNav('probecopy', '我的身份 ID', myId ? `${U.shortId(myId, 10)}…` : '—', '私钥需保密'),
      ],
    },
    {
      label: '数据', icon: 'terminal',
      rows: [
        rowKv('本地配置占用', U.humanSize(usage.bytes)),
        rowKv('房间数', String(store.rooms().length)),
        rowNav('export', '导出本地数据', '', '房间列表、会话预览、偏好为 JSON'),
        rowNav('clearlocal', '清除本地记录', '', '退出当前房间并清理配置（不动身份）'),
      ],
    },
    {
      label: '危险操作', icon: 'terminal', danger: true,
      rows: [
        rowDanger('rotatekey', '更换身份密钥', 'EndpointId 会变，别人看到另一个你'),
        rowDanger('resetall', '清空全部数据并换身份', '等于重装一个新账号'),
      ],
    },
    {
      label: '关于', icon: 'shield',
      rows: [
        rowKv('传输', 'iroh · QUIC over 自建中继'),
        rowKv('加密', '端到端；中继看不到内容'),
        rowKv('浏览器', '永久 relay-only（不能打洞）'),
        rowKv('文件传输', typeof window.showSaveFilePicker === 'function' ? '可用（Chrome / Edge）' : '不支持（需 Chrome / Edge）'),
        {
          keys: '关于 说明 常驻节点 历史 隐私',
          html:
            `<div class="set-row set-row--field">
               <div class="dialog__hint" style="margin:0">
                 传输端到端加密，中继只转发密文；常驻节点作为房间成员读取并保存文本历史，历史数据库未做额外静态加密。
                 知道房间名即可进入（没有成员审批）。只订阅当前房间，
                 切走后不会收到其他房间的新消息。
               </div>
             </div>`,
        },
      ],
    },
  ];

  return groups
    .map((g) => {
      const rows = g.rows.filter((r) => hit(r.keys));
      if (!rows.length) return '';
      return (
        `<section class="set-group${g.danger ? ' set-group--danger' : ''}">` +
        `<div class="section-title">${ico(g.icon, 'ico-inline')}<span>${U.esc(g.label)}</span></div>` +
        `<div class="set-group__body">${rows.map((r) => r.html).join('')}</div>` +
        `</section>`
      );
    })
    .join('');
}

/* ------------------------------------------------------------------ 依赖注入
 *
 * settings.js 不 import sidebar.js —— 那样又变成横向依赖了。
 * sidebar 在 init 时把两个只读取值器塞进来（见 sidebar.js 的 _wireDeps）。
 * -------------------------------------------------------------------- */
let stateReader = () => ({ ok: false, text: '启动中', waiting: true });
let themeHintReader = () => '';

function sidebarState() {
  return stateReader();
}
function themeHint() {
  return themeHintReader();
}

/** 由 sidebar.js 在 init() 里调用一次 */
export function provideSettingsDeps(readers) {
  if (readers.state) stateReader = readers.state;
  if (readers.themeHint) themeHintReader = readers.themeHint;
}

/* ------------------------------------------------------------------ 渲染 */

export function renderSettings(host, q = '') {
  const st = sidebarState();
  const stCls = st.waiting ? 'is-wait' : st.ok ? 'is-ok' : 'is-bad';
  const myId = net.endpoint_id();

  // 搜索：按行的文本命中（设置项多，找起来比滚动快）
  const hit = (t) => !q || String(t || '').toLowerCase().includes(q);

  const body = renderGroups(hit);
  const noHit = !body
    ? `<div class="empty">没有匹配的设置项<br />换个词试试</div>`
    : '';

  return {
    html:
      // 资料卡：头像 + 昵称 + 连接状态 + 公开 ID + 复制
      // （设计稿在昵称旁边有个"称号"chip —— 我们没有称号这个概念，
      //   那个位置换成**真实的节点状态**，比放一个假称号有用）
      `<div class="pcard set-card">
         <div class="set-card__av">
           ${avatar(store.nick(), 'avatar--lg')}
           <span class="dot ${st.ok && !st.waiting ? 'is-on' : ''}"></span>
         </div>
         <div class="set-card__body">
           <div class="set-card__name">${U.esc(store.nick())}
             <span class="state-pill ${stCls}"><span class="state-pill__dot"></span>${U.esc(st.text)}</span>
           </div>
           <div class="set-card__id" title="${U.esc(myId)}">
             <code>ID: ${U.esc(U.shortId(myId, 12))}…</code>
             ${myId ? `<button class="mini-btn" data-act="copy-id" type="button">复制</button>` : ''}
           </div>
         </div>
       </div>

       <div class="set-tools">
         <button class="set-tools__btn" data-act="testsound" type="button" title="试听新消息提示音">${ico('speaker', 'ico-plain')}<span>试听</span></button>
         <button class="set-tools__btn" data-act="resetdefaults" type="button" title="恢复默认设置（不动身份与聊天记录）">${ico('restart', 'ico-plain')}<span>恢复默认</span></button>
         <span class="set-tools__saved">${ico('check', 'ico-plain')}<span>自动保存</span></span>
       </div>

       ${body}
       ${noHit}

       <div class="set-foot">
         <span>端到端加密 · 浏览器版永久 relay-only</span>
         <code>iroh · QUIC</code>
       </div>`,

    bind: (root) => {
      // ⚠️ 用 `[data-act]` 而不是 `.set-row[data-act]`：资料卡里的「复制」是个裸
      //    `<button>`（在 .set-card__id 里，不是 .set-row），按旧选择器永远绑不上 ——
      //    用户点「复制」毫无反应。
      root.querySelectorAll('[data-act]').forEach((el) => {
        el.onclick = () => settingsAction(host, el.dataset.act, el);
      });
      root.querySelectorAll('[data-toggle]').forEach((el) => {
        el.onclick = () => host._togglePref(el.dataset.toggle);
      });
      root.querySelectorAll('[data-pref]').forEach((el) => {
        el.onchange = () => {
          store.setPref(el.dataset.pref, el.value);
          host._applyPrefs();
          host.render();
          bus.emit(EV.TIP, '已保存');
        };
      });
      // 主题单独一条通路：它存在 `iroh.theme`（不是 prefs），
      // 且要通知 theme 模块重算（可能从 auto 切到固定、或反过来）
      const themeSelect = root.querySelector('[data-theme-pref]');
      if (themeSelect) {
        themeSelect.onchange = () => {
          theme.apply(themeSelect.value);
          bus.emit(EV.TIP, '已保存');
        };
      }
      // 壁纸：立即生效 + 落盘 + 就地更新选中态
      root.querySelectorAll('[data-wallpaper]').forEach((el) => {
        el.onclick = () => {
          const id = el.dataset.wallpaper;
          store.setPref('wallpaper', id);
          host._applyPrefs();
          root.querySelectorAll('[data-wallpaper]').forEach((t) => {
            const on = t.dataset.wallpaper === id;
            t.classList.toggle('is-on', on);
            t.setAttribute('aria-pressed', String(on));
          });
          bus.emit(EV.TIP, `壁纸：${WALLPAPERS.find((w) => w.id === id)?.label || id}`);
        };
      });
    },
  };
}

/* ------------------------------------------------------------------ 动作 */

/** 处理设置页/状态页的所有 [data-act] 点击 */
export function settingsAction(host, act, el) {
  // 试听提示音（设计稿 _2 的「测试消息音效」）。
  // `force = true` —— 提示音关着也要响，否则用户点了没反应会以为坏了。
  if (act === 'testsound') {
    host.ding(true);
    return;
  }
  // 恢复默认偏好（设计稿 _2 的「恢复默认」）。
  // ⚠️ 只重置**偏好**，不动身份、不动房间列表、不动服务器历史 ——
  //    那三样是「危险操作」和「清除本地记录」的事，别混在一起。
  if (act === 'resetdefaults') {
    return dialog.open({
      title: '恢复默认设置',
      body:
        '<div class="dialog__hint">会把外观与通知的偏好恢复成默认值：<br />' +
        '· 主题：跟随系统<br />· 消息密度：标准<br />· 主题壁纸：纯净海面<br />' +
        '· 发送快捷键：Enter<br />· 新消息提示音、标题显示未读数：开启<br /><br />' +
        '<b>不会动</b>：你的身份、房间列表、聊天记录与草稿。</div>',
      okText: '恢复默认',
      onOk: () => {
        for (const key of ['density', 'wallpaper', 'sendKey', 'sound', 'flashTitle', 'notify', 'notifyContent']) {
          store.setPref(key, null);
        }
        theme.apply('auto');
        host._applyPrefs();
        host.render();
        document.dispatchEvent(new CustomEvent('prefchange', { detail: { key: 'reset' } }));
        bus.emit(EV.TIP, '已恢复默认设置');
      },
    });
  }
  if (act === 'copy-id') {
    const id = net.endpoint_id();
    // 就地反馈：按钮短暂变成「已复制」，比只弹 toast 更容易确认点到了
    const flash = (text) => {
      if (!el || !el.classList.contains('mini-btn')) return;
      const old = el.textContent;
      el.textContent = text;
      el.disabled = true;
      setTimeout(() => {
        el.textContent = old;
        el.disabled = false;
      }, 1200);
    };
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        bus.emit(EV.TIP, '已复制我的身份 ID');
        flash('已复制');
      })
      .catch(() => bus.emit(EV.TIP, '复制失败，请手动选中复制'));
    return;
  }
  if (act === 'probecopy') {
    dialog.open({
      title: '我的身份 ID',
      body:
        `<div class="id-box"><code>${U.esc(net.endpoint_id())}</code></div>` +
        `<div class="dialog__hint">这是你的<b>公开身份 ID</b>，可以分享用于识别你，仅凭它不能冒充你。身份私钥保存在浏览器中，切勿分享私钥。<br />` +
        `换身份请用下面的「更换身份密钥」。</div>`,
      okText: '知道了',
    });
    return;
  }
  if (act === 'status') return host.show('status');
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
        const characters = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].length : [...name].length;
        if (characters > 24) {
          bus.emit(EV.TIP, '昵称太长了（最多 24 字）');
          return false;
        }
        store.setNick(name);
        net.setNickname(name);
        document.dispatchEvent(new CustomEvent('nickchange'));
        host.render();
        bus.emit(EV.TIP, '昵称已更新');
      },
    });
  }
  if (act === 'newroom') return host.newRoom();
  if (act === 'theme') {
    document.getElementById('btn-theme').click();
    host.render();
    return;
  }
  if (act === 'clearlocal') {
    return dialog.open({
      title: '清除本地记录',
      body:
        '<div class="dialog__hint">会退出当前房间，丢弃草稿，并清掉房间列表、会话预览、未读计数、隐藏消息标记和偏好设置。<br />' +
        '<b>保留</b>：身份密钥、服务器上的历史消息。<br />' +
        '想要连身份一起换，用下面的「清空全部数据」。</div>',
      okText: '清除',
      onOk: async () => {
        await host.leaveCurrentRoom();
        store.clearLocal();
        host.unread.clear();
        host.previews.clear();
        host._applyPrefs();
        host.paintBadge();
        host.render();
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
}
