/* ============================================================================
 * ui/composer.js · 输入区（对齐微信交互）
 *
 * ## 待发送区（pending）
 *
 * 微信的行为是：**粘贴 / 拖拽 / 选择的文件先落在输入框上方，不立刻发送**，
 * 用户可以逐个移除，也可以配一段文字一起发。
 *
 * 之前的问题是「粘贴图片直接发送」——用户想配文字或后悔都来不及。
 * 现在统一收口到待发送区：
 *
 *   粘贴 / 拖拽 / 点图标选  →  进 pending 列表（可移除）
 *                                    ↓ 点「发送」或 Enter
 *                             文字 + 所有附件一起发出
 *
 * ## 发送顺序
 *
 * 文字先走消息通道（即时可见），随后**逐个**发起文件邀约（P2P 直传）。
 * 之所以逐个而不是并发：一次弹多个"保存位置"对话框体验很糟，
 * 而且多个大文件并发会互相抢带宽。
 *
 * ## 图片
 *
 * 图片也走 P2P（不再 base64 内联）。base64 会把大图塞进广播消息里，
 * 撑爆 gossip 通道、且同一张图会复制给房间里每个人。
 * ==========================================================================*/

import { bus, EV } from '../bus.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { dialog } from './dialog.js';
import { fileTransfer, canTransferFiles } from './filetransfer.js';
import * as U from '../util.js';

const $ = (id) => document.getElementById(id);

const EMOJIS = (
  '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 ' +
  '🤗 🤭 🤔 🤐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🥳 🥺 😢 😭 😤 😠 😡 🤬 🤯 ' +
  '😳 🥵 🥶 😱 😨 😰 😥 😓 🤝 👍 👎 👏 🙏 🙌 👋 💪 ✌️ 🤞 👌 🖐️ ❤️ 🧡 💛 💚 💙 💜 🖤 ' +
  '🤍 🔥 ✨ 🎉 🎊 🎁 🌟 ⭐ 💯 ✅ ❌ ⚠️ ❓ ❗ 🚀 🛠️ ⚙️ 📌 📎 📁 📷 🎵 🍵 ☕ 🍺 🍻 🥂 ' +
  '🍜 🍚 🍎 🍉 🐛 🐧 🐱 🐶 🤖'
).split(' ');

/** 单个附件的大小上限：超过就提示（不是不能传，是提醒别误发） */
const BIG_FILE_WARN = 2 * 1024 * 1024 * 1024;

/** 生成一个像微信的图片文件名 */
function pastedImageName(mime) {
  const ext = (mime || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `图片-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}.${ext}`;
}

/** 判断是不是图片（用于决定渲染成缩略图还是文件条目） */
const isImage = (f) => (f.type || '').startsWith('image/');

export const composer = {
  room: '',
  /** 待发送的附件：{ id, file, url }  —— url 仅图片有，用于缩略图预览 */
  pending: [],
  drafts: new Map(),
  _roomVersion: 0,
  _seq: 0,
  /** 发送中（防止连点，也用于禁用发送按钮） */
  sending: false,
  /** 输入区是否可用（进房成功 且 节点在线） */
  enabled: false,
  /** 底部提示的自动消失计时器 */
  _tipTimer: null,

  init() {
    $('send').onclick = () => this.send();
    $('input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // ⚠️ 中文输入法组字期间（拼音还没上屏）按 Enter 是"选词"，不是"发送"。
      //    少了这个判断，用户拼到一半按选词键就会把 `nihao` 这种拼音缓冲发出去。
      //    `isComposing` 是标准属性；部分浏览器/输入法只给 keyCode 229，两个都判。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey) return;               // Shift+Enter 换行
      // 发送快捷键可配：默认 Enter，勾了设置里的"Ctrl + Enter"后
      // Enter 只换行（更适合单手打字/写多行的场景）。
      if (store.prefs().sendKey === 'ctrl' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.send();
    });
    $('input').addEventListener('compositionend', () => {
      // 组字结束后同步一次按钮状态（组字期间 input 事件的值不可信）
      this._syncSendBtn();
    });
    $('input').addEventListener('input', () => {
      this._autoGrow();
      this._syncSendBtn();
    });
    // 粘贴：图片和文件都进待发送区（**不再直接发送**）
    $('input').addEventListener('paste', (e) => this._onPaste(e));

    this._buildEmoji();
    $('tb-emoji').onclick = (e) => {
      e.stopPropagation();
      $('emoji-pop').classList.toggle('is-on');
    };
    document.addEventListener('click', (e) => {
      const pop = $('emoji-pop');
      if (pop.classList.contains('is-on') && !pop.contains(e.target) && e.target.id !== 'tb-emoji') {
        pop.classList.remove('is-on');
      }
    });

    $('tb-file').onclick = () => this._pick('file');
    $('tb-shot').onclick = () => this._pick('file-img');
    $('tb-voice').disabled = true;
    $('tb-voice').title = '语音消息尚未支持';

    this._bindDrop();
    this._inputObserver?.disconnect();
    let inputWidth = null;
    this._inputObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === inputWidth) return;
      inputWidth = width;
      cancelAnimationFrame(this._resizeFrame);
      this._resizeFrame = requestAnimationFrame(() => this._autoGrow());
    });
    this._inputObserver.observe($('input'));
    this._autoGrow(); // 初始就按内容定高（不加这句会停在 CSS 默认值）
  },

  /**
   * 开关输入区。
   * @param on 是否允许输入
   * @param placeholder 未进房/离线时给出原因（别让用户对着一个不动的输入框发呆）
   */
  setEnabled(on, placeholder) {
    this.enabled = !!on;
    $('input').disabled = !on;
    $('input').placeholder =
      placeholder || (on ? `输入消息，${store.prefs().sendKey === 'ctrl' ? 'Ctrl/⌘+Enter' : 'Enter'} 发送 · Shift+Enter 换行` : '不可用');
    // 工具条在不可用时也要跟着灰掉，否则用户点了没反应
    for (const id of ['tb-emoji', 'tb-file', 'tb-shot']) $(id).disabled = !on;
    this._syncSendBtn();
    if (on) {
      this._autoGrow();
      $('input').focus();
    }
  },

  setRoom(room) {
    if (room === this.room) return;
    if (this.room) this.drafts.set(this.room, { text: $('input').value, pending: this.pending });
    this._roomVersion++;
    this.room = room;
    const draft = this.drafts.get(room);
    $('input').value = draft?.text || '';
    this.pending = draft?.pending || [];
    this._renderPending();
    this._syncSendBtn();
    this._autoGrow();
  },

  clearDrafts() {
    for (const draft of this.drafts.values()) {
      for (const pending of draft.pending) if (pending.url) URL.revokeObjectURL(pending.url);
    }
    this.drafts.clear();
    this.clearPending();
    $('input').value = '';
    this._autoGrow();
  },

  focus() {
    $('input').focus();
  },

  /**
   * 底部一行提示。
   * ⚠️ 之前只有 `textContent = text`，从不消失：一条"连接中继超时"会一直挂着，
   * 后面成功了也不清，看起来像"仍然有问题"。现在带自动消失 + 同名去重。
   */
  tip(text, { sticky = false, bad = false } = {}) {
    const el = $('composer-tip');
    if (this._tipText === text && this._tipBad === bad) return;   // 同文案不重复计时
    this._tipText = text;
    this._tipBad = bad;
    el.textContent = text || '';
    el.classList.toggle('is-on', !!text);
    el.classList.toggle('is-bad', !!bad);
    clearTimeout(this._tipTimer);
    if (text && !sticky) {
      this._tipTimer = setTimeout(() => composer.tip(''), 5000);
    }
  },

  /* ================================================================== 待发送区 */

  /** 加一批文件进待发送区（粘贴 / 拖拽 / 选择 都走这里） */
  addFiles(files, opts = {}) {
    if (!this.room) {
      dialog.info('还没有房间', '先进一个房间再发文件。');
      return;
    }
    if (!canTransferFiles()) {
      return dialog.info(
        '当前浏览器不支持发文件',
        '需要 <b>Chrome / Edge</b>（依赖文件系统访问 API，才能做到"边收边写盘、不吃内存"）。<br />' +
          'Firefox 与 Safari 暂不支持 —— 与其给一个会把内存吃满的降级方案，不如明确不支持。',
      );
    }
    let added = 0;
    let tooBig = 0;
    let empty = 0;
    for (const f of files) {
      if (!f) continue;
      if (!f.size) { empty++; continue; }
      if (f.size > BIG_FILE_WARN) tooBig++;
      this.pending.push({
        id: `p${++this._seq}`,
        file: f,
        // 只有图片才生成缩略图（普通文件用图标，不必读进内存）
        url: isImage(f) ? URL.createObjectURL(f) : '',
        // 数据在不在内存里。**必须在主线程就判定并随参数传过去**：
        // File 是结构化克隆进 Worker 的，挂在它身上的自定义属性会丢。
        // 见 iroh-worker.js 的 `isMemoryBacked`。
        mem: !!opts.memoryBacked,
      });
      added++;
    }
    if (empty) this.tip(`有 ${empty} 个空文件未添加：暂不支持零字节文件`, { bad: true });
    if (!added) return;
    this._renderPending();
    this._syncSendBtn();
    if (tooBig) this.tip(`有 ${tooBig} 个文件超过 2GB，传输会比较慢`);
    else if (!empty) this.tip('');
  },

  removePending(id) {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.pending.splice(i, 1);
    if (p.url) URL.revokeObjectURL(p.url);
    this._renderPending();
    this._syncSendBtn();
  },

  clearPending() {
    for (const p of this.pending) if (p.url) URL.revokeObjectURL(p.url);
    this.pending = [];
    this._renderPending();
    this._syncSendBtn();
  },

  _renderPending() {
    const box = $('pending');
    if (!this.pending.length) {
      box.classList.remove('is-on');
      box.innerHTML = '';
      return;
    }
    box.classList.add('is-on');
    box.innerHTML = '';
    for (const p of this.pending) {
      const el = document.createElement('div');
      el.className = `pending__item${p.url ? ' is-img' : ''}`;
      if (p.url) {
        el.innerHTML = `
          <img src="${p.url}" alt="" />
          <button class="pending__x" title="移除">×</button>`;
      } else {
        el.innerHTML = `
          <span class="pending__icon">${U.fileIcon(p.file.name)}</span>
          <span class="pending__body">
            <span class="pending__name">${U.esc(p.file.name)}</span>
            <span class="pending__size">${U.humanSize(p.file.size)}</span>
          </span>
          <button class="pending__x" title="移除">×</button>`;
      }
      el.querySelector('.pending__x').onclick = () => this.removePending(p.id);
      box.appendChild(el);
    }
  },

  _syncSendBtn() {
    const hasText = !!$('input').value.trim();
    const hasFile = this.pending.length > 0;
    $('send').disabled = this.sending || !this.room || !this.enabled || (!hasText && !hasFile);
  },

  /* ================================================================== 发送 */

  /**
   * 统一发送出口。
   *
   * 顺序：**先发文字**（走消息通道，立刻在双方出现），
   * 再**逐个**发起文件邀约（弹保存对话框的是对方，不是我们）。
   *
   * ⚠️ 失败时**必须把文字放回输入框**：之前是无条件 `input.value = ''`，
   * 一旦发送失败（离线、节点掉了）用户的输入就直接消失了 —— 属于静默丢数据。
   * 现在改成"先试着发，成功才清空；失败留在框里并标红提示"。
   */
  async send() {
    const input = $('input');
    const text = input.value;
    const trimmed = text.trim();
    const files = this.pending.slice();
    if (!trimmed && !files.length) return;
    if (!this.room) {
      this.tip('还没有进入房间');
      return;
    }
    if (this.sending) return;   // 防连点
    if (new TextEncoder().encode(trimmed).length > 64 * 1024) {
      this.tip('文本最多 64 KiB（按 UTF-8 计算），请缩短或作为文件发送', { bad: true, sticky: true });
      return;
    }

    this.sending = true;
    const sendBtn = $('send');
    sendBtn.disabled = true;
    sendBtn.textContent = '发送中…';

    let failReason = '';
    // 失败气泡的 DOM 引用：重发成功后要能把它撤掉。
    // 用一个可变对象当"回传通道" —— pushFailed 会在同一个对象上挂 `.el`。
    const failed = { el: null };
    // ⚠️ **在第一个 await 之前**把房间定下来（复检 P3-14）。
    //    发送要等好几秒（附件还要算哈希），期间用户可能切房间 ——
    //    若在 await 之后才读 `this.room`，就会出现"文字发进 A、
    //    附件邀约发进 B"。Rust 侧现在会对房间不一致直接报错，
    //    但正确做法是这一条消息自始至终用同一个房间。
    const room = this.room;
    const roomVersion = this._roomVersion;
    try {
      // ① 文字先走
      //
      // ⚠️ 文字和附件要**分开记成败**。合成一个 `ok` 会出一个很难看的问题：
      //    文字发成功了、但随后某个附件发起失败 → `ok=false` →
      //    于是把**已经发出去的文字**塞回输入框，还多弹一个"发送失败"的
      //    红色气泡（同一条消息在时间线上出现两次，一次正常一次标红）。
      let textOk = true;
      if (trimmed) {
        const r = await this._push(trimmed, room);
        textOk = r.ok;
        if (!r.ok) {
          failReason = r.reason;
        }
      }

      // ② 附件逐个发起邀约
      let filesOk = true;
      if (files.length) {
        for (const p of files) {
          this.tip(`正在准备 ${p.file.name}…`);
          try {
            await fileTransfer.pickAndSend(p.file, room, p.mem);
            const draft = this.room === room ? { pending: this.pending } : this.drafts.get(room);
            if (draft) {
              const index = draft.pending.findIndex((item) => item.id === p.id);
              if (index >= 0) draft.pending.splice(index, 1);
            }
            if (p.url) URL.revokeObjectURL(p.url);
          } catch (e) {
            filesOk = false;
            failReason = e?.message ?? String(e);
            this.tip(`发起失败：${failReason}`);
          }
        }
        if (filesOk) this.tip('');
      }

      // 文字成功就清空（附件失败不影响"文字已经发出去了"这个事实）
      if (textOk) {
        if (this.room === room && this._roomVersion === roomVersion && input.value === text) input.value = '';
        else if (this.room !== room && this.drafts.get(room)?.text === text) this.drafts.get(room).text = '';
      } else {
        // 只有**文字本身**没发出去，才把它放回输入框并留失败气泡
        if (trimmed) bus.emit(EV.SEND_FAILED, { room, text: trimmed, reason: failReason, failed });
      }
      this._renderPending();
      this._autoGrow();
      // 文字发成功、只有附件没发出去时，用底部提示说明（不误导成"消息没发出去"）
      if (textOk && !filesOk) this.tip(`附件未发出：${failReason}`);
    } finally {
      this.sending = false;
      sendBtn.textContent = '发送';
      this._syncSendBtn();
    }
  },

  /** 兼容旧调用点 */
  async sendText() {
    await this.send();
  },

  /** 直接发一段文字（重发气泡用），成功返回 true */
  async pushText(text) {
    const r = await this._push(text);
    if (!r.ok) {
      bus.emit(EV.SEND_FAILED, { text, reason: r.reason, failed: { el: null } });
      return false;
    }
    // ⚠️ 重发成功后要把输入框里那份原文清掉。
    //    发送失败时我们把原文留在了输入框（这是对的），但用户改用
    //    「重新发送」按钮补发之后，那份原文还留在框里 ——
    //    再顺手按一次 Enter 就会**重复发一条**。
    const input = $('input');
    if (input && input.value.trim() && input.value.trim() === String(text).trim()) {
      input.value = '';
      this._autoGrow();
      this._syncSendBtn();
    }
    return true;
  },

  /**
   * 发出去 + 立刻本地渲染（乐观插入，靠 id 去重）。
   *
   * `room` 由调用方传入并**在 await 之前定好**：这一步要等网络往返，
   * 期间用户可能已经切房间，用 `this.room` 会把消息渲染进错误的时间线（P3-14）。
   */
  async _push(payload, room) {
    try {
      const m = await net.send(payload);
      bus.emit(EV.MSG, { room: room ?? this.room, message: m, mine: true, isHistory: false });
      return { ok: true, reason: '' };
    } catch (e) {
      const reason = e?.message ?? String(e);
      bus.emit(EV.TIP, `发送失败：${reason}`);
      return { ok: false, reason };
    }
  },

  /* ================================================================== 表情 */

  _buildEmoji() {
    const pop = $('emoji-pop');
    pop.innerHTML = EMOJIS.map((e) => `<button data-e="${e}">${e}</button>`).join('');
    pop.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const input = $('input');
        // ⚠️ 必须插在**光标处**，不能 `value += emoji` —— 那样不管光标在哪
        //    都会追加到末尾，用户在中间插表情的意图被无视。
        const e = b.dataset.e;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = input.value.slice(0, start) + e + input.value.slice(end);
        const pos = start + e.length;
        input.focus();
        input.setSelectionRange(pos, pos);
        // 表情是点出来的，不会触发 input 事件 → 必须手动同步高度和按钮状态
        this._autoGrow();
        this._syncSendBtn();
      };
    });
  },

  /* ================================================================== 选择文件 */

  /** 走隐藏的 <input type=file>：`kind` 是元素 id（file / file-img） */
  _pick(kind) {
    if (!this.room) return dialog.info('还没有房间', '先进一个房间再发文件。');
    const input = $(kind);
    input.value = '';
    input.onchange = () => {
      if (input.files?.length) this.addFiles([...input.files]);
    };
    input.click();
  },

  /* ================================================================== 粘贴 */

  /**
   * 粘贴：**只把它放进待发送区，不发送**。
   *
   * 微信的行为就是这样 —— 截图后 Ctrl+V，图片出现在输入框上方，
   * 你可以再打字、也可以删掉。之前的实现是"粘贴即发送"，没法后悔。
   */
  _onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [];
    // ① 图片（截图 / 复制的图）
    for (const item of dt.items || []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    // ② 从文件管理器复制的文件（某些系统会走 files）
    if (!files.length && dt.files?.length) files.push(...dt.files);
    if (!files.length) return; // 普通文本粘贴，交给浏览器默认行为

    e.preventDefault();
    // 剪贴板里的图片常常没有文件名（或叫 image.png），给个体面的名字
    const named = files.map((f) =>
      f.name && f.name !== 'image.png'
        ? f
        : new File([f], pastedImageName(f.type), { type: f.type || 'image/png' }),
    );
    // 剪贴板里的内容一定在内存里（没有对应的磁盘文件）
    this.addFiles(named, { memoryBacked: true });
  },

  /* ================================================================== 拖拽 */

  _bindDrop() {
    // 需要计数：dragenter/dragleave 会在子元素间反复触发
    let depth = 0;
    const zone = $('dropzone');
    const show = () => zone.classList.add('is-on');
    const hide = () => zone.classList.remove('is-on');

    window.addEventListener('dragenter', (e) => {
      if (!this.room) return;
      // 只在拖"文件"时提示（拖选中文本不该弹）
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      depth++;
      show();
    });
    window.addEventListener('dragover', (e) => {
      if (!this.room) return;
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!this.room) return;
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    });
    window.addEventListener('drop', (e) => {
      if (!this.room) return;
      e.preventDefault();
      depth = 0;
      hide();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.addFiles(files);
    });
    // 兜底：拖出窗口外再松手时清掉提示
    window.addEventListener('dragend', () => {
      depth = 0;
      hide();
    });
  },

  /* ================================================================== 其它 */

  /**
   * 按内容定高。
   *
   * ⚠️ **绝对不要"先归零再量"**（老写法：`style.height='0px'` → 量 scrollHeight → 写回）。
   *    那个"塌下去再撑回来"的中间态会让浏览器跟着调整时间线的 scrollTop ——
   *    实测**每敲一个字**时间线就被顶走 26px 再弹回来，肉眼是"抖一下"，
   *    而内容高度一个像素都没变。
   *
   * 也不赌浏览器的 `field-sizing: content`：实测 Chrome 154 虽然
   * `CSS.supports()` 返回 true，但高度**真的不随内容变**（1 行和 12 行都是 26px）。
   *
   * 所以用一个**离屏克隆体**测高度：它不参与真实布局，测量过程零副作用，
   * 只有确定要改高度时才写一次 `style.height`。
   */
  _autoGrow() {
    const ta = $('input');
    const MIN = 26;
    const MAX = 132;

    let probe = document.getElementById('grow-probe');
    if (!probe) {
      probe = document.createElement('textarea');
      probe.id = 'grow-probe';
      probe.setAttribute('aria-hidden', 'true');
      probe.tabIndex = -1;
      document.body.appendChild(probe);
    }
    // 测量用的样式必须和真输入框一致，否则 scrollHeight 不可比。
    // className 走同一套样式表（padding / line-height / box-sizing），
    // width 用计算值 —— 两者 box-sizing 相同，宽度就等效。
    const cs = getComputedStyle(ta);
    probe.className = ta.className;
    // ⚠️ `rows` 必须一起复制：textarea 默认 rows=2，克隆体哪怕 1 行内容
    //    也会量出 2 行的高度（实测 1 行被量成 54px）。
    probe.rows = ta.rows || 1;
    probe.style.cssText = '';
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.width = cs.width;
    probe.style.height = 'auto';
    probe.style.minHeight = '0';
    probe.style.maxHeight = 'none';
    probe.value = ta.value;

    const need = probe.scrollHeight;
    const h = Math.min(Math.max(need, MIN), MAX);
    if (ta.style.height !== `${h}px`) ta.style.height = `${h}px`;   // 只在真变了才写
    const wantOverflow = need > MAX ? 'auto' : 'hidden';
    if (ta.style.overflowY !== wantOverflow) ta.style.overflowY = wantOverflow;
  },

  /** 打开系统选择器（供外部按钮调用） */
  pickAndSend(imagesOnly) {
    this._pick(imagesOnly ? 'file-img' : 'file');
  },
};
