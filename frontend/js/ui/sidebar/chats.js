/* ============================================================================
 * sidebar/chats.js · 会话列表页（侧栏第一个标签）
 *
 * 从 sidebar.js 拆出来的**视图函数**。约定：
 *   - 接收 `host`（= 那个 sidebar 单例本身），要读状态就 `host.xxx`，
 *     要触发重绘就 `host.render()`。
 *   - 只负责「算数据 + 出 HTML + 绑事件」，不持有任何自己的状态。
 *   - 统一返回 `{ html, bind? }`，由 sidebar.render() 统一套用。
 *
 * 为什么拆：三个视图（会话/状态/设置）原本挤在同一个 1415 行文件里，
 * 改设置页要翻到会话列表的代码。现在一页一个文件。
 * ==========================================================================*/

import { bus, EV } from '../../bus.js';
import { net } from '../../net.js';
import { store } from '../../store.js';
import * as U from '../../util.js';
import { avatar } from '../primitives.js';

/** 渲染会话列表。@param host sidebar 单例 @param q 搜索词（已 trim + lower） */
export function renderChats(host, q) {
  const hit = (s) => !q || String(s || '').toLowerCase().includes(q);
  let list = store.roomsSorted().filter((r) => hit(r.name) || hit(r.alias));

  // 筛选 chips（真实维度，见 roomFilter 的注释）
  const filter = host.roomFilter || 'all';
  if (filter === 'pinned') list = list.filter((r) => !!r.pinned);

  if (!list.length) {
    const hint = {
      pinned: '还没有置顶的房间<br />右键（或长按）房间 → 置顶',
      // ⚠️ 这里曾有一个 `unread: '没有未读消息'` 分支 —— 「未读」筛选已删（见 roomFilter）。
      //    `roomFilter` 只在内存里（刷新即回 'all'），所以老用户不会卡在一个不存在的筛选上。
    }[filter] || (q
      ? '没有匹配的房间'
      : '还没有房间<br />点右上角 + 新建，或让别人把房间名告诉你');
    return { html: `<div class="empty">${hint}</div>` };
  }

  const html =
    list
      .map((r) => {
        const last = host.previews.get(r.name);
        const un = host.unread.get(r.name) || 0;
        const name = r.alias || r.name;
        // 微信的会话预览**不写"我:"**，靠气泡左右区分说话人；这里保持一致。
        const preview = last ? last.text : '还没有消息';
        // ⚠️ 在线光点只给**当前真的加入了的房间**。
        //    presence 只覆盖已加入的房间 —— 给别的房间画绿点就是在编数据
        //    （设计稿每个房间都有点，但我们的协议拿不到那个信息）。
        const live = r.name === host.currentRoom && net.canSend && net._room === r.name;
        return `
        <div class="row ${r.name === host.currentRoom ? ' is-active' : ''}" data-room="${U.esc(r.name)}">
          <div class="row__avatar">
            ${avatar(name)}
            ${live ? '<span class="row__dot radar-ring"></span>' : ''}
          </div>
          <div class="row__meta">
            <div class="row__line1">
              <span class="row__name">${U.esc(name)}</span>
              ${r.pinned ? '<span class="row__tag">置顶</span>' : ''}
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
          if (U.isNarrow()) host.closePanel();
          bus.emit(EV.ROOM_OPEN, room);
        };
        el.oncontextmenu = (e) => {
          e.preventDefault();
          host.roomMenu(room);
        };
      });
    },
  };
}