/* ============================================================================
 * ui/roster.js · 花名册与成员名片（R2a）
 *
 * 房间是场地、成员是它的内容 —— 这里给"看人"一个地方：
 *   **名字 / id8 / 名片（简介 + 标签）/ 他在这房间说过什么 / 一键 @ 他**
 *
 * 这就是"能力发现"的全部：不看任何 manifest，只看这三样（名字、简介、发言）。
 *
 * A4：还显示**成员状态** —— 在线（此刻在场）/ 忙碌（名片标签里带「忙碌」，约定，
 * 零协议变更）/ 离线（最近说过话但不在场；@ 他会插入带 id 的草稿）。
 *
 * ⚠️ 名片内容来自**别人签名的消息**，渲染一律 `U.esc` —— 简介是任何人都能写的自由文本。
 * ⚠️ "最近说过什么"只覆盖**本次会话加载到的历史**（timeline 里那份 200 条的滑动窗口），
 *    卡片上如实写明，别让人以为这是全量记录。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { dialog } from './dialog.js';
import { timeline } from './timeline.js';
import { avatar } from './primitives.js';
import { encodeProfile, of as profileOf } from '../profile.js';
import { currentMembers, id8Of } from '../mention.js';
import * as U from '../util.js';

const $ = (id) => document.getElementById(id);

/** 展开状态：点了"最近说过"的成员 id（重开对话框不保留） */
const expanded = new Set();

/** A4：名片标签里的"忙碌"约定（不进协议 —— 花名册据此显示忙碌状态） */
export const BUSY_TAG = '忙碌';

function statusHtml(id) {
  const busy = (profileOf(timeline.room, id)?.tags ?? []).includes(BUSY_TAG);
  return `<span class="roster__status" data-status="${busy ? 'busy' : 'online'}">${busy ? '忙碌' : '在线'}</span>`;
}

function recentBy(id, limit = 5) {
  return timeline._recent.filter((m) => m.from === id).slice(-limit);
}

function bioLine(id) {
  const p = profileOf(timeline.room, id);
  if (!p || (!p.bio && !p.tags.length)) return '<span class="roster__none">还没写简介</span>';
  const tags = p.tags.length
    ? `<span class="roster__tags">${p.tags.map((t) => `<i class="roster__tag">${U.esc(t)}</i>`).join('')}</span>`
    : '';
  const bio = p.bio ? `<span class="roster__bio">${U.esc(p.bio)}</span>` : '';
  return bio + tags;
}

function rowHtml(p) {
  const id = p.id;
  const isOpen = expanded.has(id);
  const recent = isOpen
    ? recentBy(id)
        .map(
          (m) =>
            `<div class="roster__msg">${m.text ? U.esc(m.text.slice(0, 160)) : '<i>（文件）</i>'}</div>`,
        )
        .join('') || '<div class="roster__msg roster__none">本次加载的历史里他还没说话</div>'
    : '';
  return (
    `<div class="roster__row" data-member="${U.esc(id)}">` +
    avatar(p.nickname || '?', 'avatar--sm') +
    `<div class="roster__main">` +
    `<div class="roster__top"><b class="roster__name">${U.esc(p.nickname || '(无名)')}</b>` +
    `<span class="roster__id">${id8Of(id)}</span>` +
    statusHtml(id) +
    `</div>` +
    `<div class="roster__bio-line">${bioLine(id)}</div>` +
    (isOpen ? `<div class="roster__recent">${recent}</div>` : '') +
    `</div>` +
    `<div class="roster__acts">` +
    `<button class="link-btn" data-act="mention" type="button">@他</button>` +
    `<button class="link-btn" data-act="recent" type="button">${isOpen ? '收起' : '最近说过'}</button>` +
    `</div>` +
    `</div>`
  );
}

/**
 * A4：最近在这个房间说过话、此刻不在场的人（离线）。
 * 来源只能是本次会话加载到的历史窗口（`timeline._recent`）—— 软状态，不是权威名册。
 */
function offlineMembers(limit = 8) {
  const present = new Set(currentMembers().map((p) => p.id));
  const list = [];
  for (const m of timeline._recent) {
    if (!m.from || present.has(m.from) || (timeline.me && m.from === timeline.me)) continue;
    const at = list.findIndex((x) => x.id === m.from);
    if (at >= 0) list.splice(at, 1);
    list.push({ id: m.from, nickname: m.nickname || '' });
  }
  return list.reverse().slice(0, limit);
}

function offlineRowHtml(p) {
  return (
    `<div class="roster__row roster__row--offline" data-offline="${U.esc(p.id)}">` +
    avatar(p.nickname || '?', 'avatar--sm') +
    `<div class="roster__main">` +
    `<div class="roster__top"><b class="roster__name">${U.esc(p.nickname || '(无名)')}</b>` +
    `<span class="roster__id">${id8Of(p.id)}</span>` +
    `<span class="roster__status" data-status="offline">离线</span></div>` +
    `</div>` +
    `<div class="roster__acts">` +
    `<button class="link-btn" data-act="mention-offline" type="button">@他</button>` +
    `</div>` +
    `</div>`
  );
}

export const roster = {
  /** 打开花名册（含"我的名片"入口与"连接状态"入口） */
  open() {
    if (!timeline.room) {
      bus.emit(EV.TIP, '还没进房间');
      return;
    }
    const peers = currentMembers();
    const offline = offlineMembers();
    const body =
      `<div class="roster">` +
      `<div class="roster__hint">房间里的人（含常驻节点与 agent）。状态：在线 = 此刻在场；忙碌 = 名片标签里写了「忙碌」。点「最近说过」看他在这个房间说过什么。</div>` +
      (peers.length ? peers.map(rowHtml).join('') : '<div class="roster__none">此刻没有其他人在场</div>') +
      (offline.length
        ? `<div class="roster__hint">最近说过话、现在不在场（离线）—— @ 他发送后，房间里若有召唤器就会把人叫回来。</div>` +
          offline.map(offlineRowHtml).join('')
        : '') +
      `</div>`;
    dialog.open({
      title: `房间成员（${peers.length + 1}）`,
      body,
      okText: '我的名片',
      cancelText: '关闭',
      onOk: () => {
        roster.editMine();
        return false; // 不关对话框
      },
    });
    roster._bind();
  },

  /** 事件绑定（对话框是 innerHTML 重绘的，每次打开都要重新绑） */
  _bind() {
    const box = $('dlg-body');
    for (const row of box.querySelectorAll('.roster__row')) {
      const id = row.dataset.member ?? row.dataset.offline;
      const p =
        currentMembers().find((x) => x.id === id) ?? offlineMembers().find((x) => x.id === id);
      for (const btn of row.querySelectorAll('button[data-act]')) {
        btn.onclick = () => {
          if (btn.dataset.act === 'mention' || btn.dataset.act === 'mention-offline') {
            dialog.close();
            roster._mention(p, btn.dataset.act === 'mention-offline');
            return;
          }
          if (expanded.has(id)) expanded.delete(id);
          else expanded.add(id);
          roster.open(); // 就地重画
        };
      }
    }
  },

  /**
   * 把 `@某人` 插进输入框（**草稿里是人话**；发送时才改写成 token —— 见 js/mention.js）。
   * 离线的人不在补全名册里，所以要带 `#id8` —— `resolveDraft` 会把它归一成规范 token。
   */
  _mention(p, offline = false) {
    if (!p) return;
    const el = $('input');
    if (!el) return;
    const prefix = el.value && !/\s$/.test(el.value) ? ' ' : '';
    const name = p.nickname || id8Of(p.id);
    let text;
    if (offline) {
      text = `${prefix}@${name}#${id8Of(p.id)} `;
      bus.emit(EV.TIP, `已插入「${name}」的引用（他不在场；房间里有召唤器的话，发送就会把他叫来）`);
    } else {
      const dup =
        currentMembers().filter((x) => (x.nickname ?? '') === (p.nickname ?? '')).length > 1;
      text = `${prefix}@${name}${dup ? `#${id8Of(p.id)}` : ''} `;
    }
    el.value = `${el.value}${text}`;
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  },

  /** 编辑我自己的名片：简介 + 标签 → 发一条**签名消息**（见 js/profile.js） */
  editMine() {
    if (!timeline.room) {
      bus.emit(EV.TIP, '还没进房间');
      return;
    }
    const mineProfile = profileOf(timeline.room, timeline.me) ?? { bio: '', tags: [] };
    dialog.open({
      title: '我的名片',
      body:
        `<label class="dialog__label" for="dlg-bio">简介</label>` +
        `<input id="dlg-bio" class="dialog__field" value="${U.esc(mineProfile.bio)}" placeholder="一句话说明你能做什么（房间里的人看得到）" maxlength="160" />` +
        `<label class="dialog__label" for="dlg-tags">标签（空格或逗号分隔，最多 8 个）</label>` +
        `<input id="dlg-tags" class="dialog__field" value="${U.esc(mineProfile.tags.join(' '))}" placeholder="如：ts rust 设计" maxlength="80" />` +
        `<div class="dialog__hint">名片会作为一条**签名的房间消息**发出去（进历史，新人翻记录就能看到）。` +
        `房间里任何人都能看到它 —— 别写不该公开的东西。标签里写「忙碌」→ 花名册里显示忙碌状态。</div>`,
      okText: '保存',
      async onOk() {
        const bio = $('dlg-bio').value.trim();
        const tags = $('dlg-tags')
          .value.split(/[\s,，]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        try {
          const m = await net.send(encodeProfile({ bio, tags }));
          // ⚠️ 必须自己补一条**本地回显**：这条消息没走 composer，
          //    而"自己发的消息"是靠 composer 那边 emit 的 —— 少了这一行，
          //    改完名片**自己看不见那行提示**（对方却能收到），实测踩到。
          bus.emit(EV.MSG, { room: timeline.room, message: m, mine: true, isHistory: false });
          bus.emit(EV.TIP, '名片已更新');
          return true;
        } catch (e) {
          bus.emit(EV.TIP, `名片没发出去：${e?.message ?? e}`);
          return false;
        }
      },
    });
  },
};

/** 名片表更新 → 若花名册开着就刷新（别人刚改了简介） */
bus.on(EV.PROFILES, ({ room }) => {
  if (room === timeline.room && $('modal')?.classList.contains('is-on')) {
    // 只在花名册自己开着的时候重画 —— 别把用户正在填的"我的名片"对话框顶掉
    const body = $('dlg-body');
    if (body?.querySelector('.roster')) roster.open();
  }
});
