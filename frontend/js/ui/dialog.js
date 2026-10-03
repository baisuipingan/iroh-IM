/* ============================================================================
 * ui/dialog.js · 通用对话框
 * 取代浏览器原生 prompt/confirm，统一视觉与键盘行为（Esc 关闭、Enter 确认）。
 * ==========================================================================*/

import { esc } from '../util.js';

const $ = (id) => document.getElementById(id);
let onOk = null;

export const dialog = {
  open({ title, body = '', okText = '确定', cancelText = '取消', onOk: cb }) {
    $('dlg-title').textContent = title;
    $('dlg-body').innerHTML = body;
    $('dlg-ok').textContent = okText;
    $('dlg-cancel').textContent = cancelText;
    onOk = cb || null;
    $('modal').classList.add('is-on');
    // 自动聚焦第一个可输入元素
    setTimeout(() => $('dlg-body').querySelector('input, select, textarea')?.focus(), 30);
  },

  close() {
    $('modal').classList.remove('is-on');
    onOk = null;
  },

  /** 只读提示 */
  info(title, html) {
    dialog.open({ title, body: `<div class="dialog__hint">${html}</div>`, okText: '知道了' });
  },

  /** 询问一段文本 */
  ask({ title, label, value = '', placeholder = '', hint = '', okText = '保存', onOk }) {
    dialog.open({
      title,
      body:
        `<label class="dialog__label">${esc(label)}</label>` +
        `<input id="dlg-input" class="dialog__field" value="${esc(value)}" placeholder="${esc(placeholder)}" />` +
        (hint ? `<div class="dialog__hint">${hint}</div>` : ''),
      okText,
      onOk: () => onOk($('dlg-input').value.trim()),
    });
  },

  bind() {
    $('dlg-cancel').onclick = () => dialog.close();
    $('dlg-ok').onclick = () => {
      if (onOk && onOk() === false) return;
      dialog.close();
    };
    $('modal').onclick = (e) => {
      if (e.target === $('modal')) dialog.close();
    };
    document.addEventListener('keydown', (e) => {
      if (!$('modal').classList.contains('is-on')) return;
      if (e.key === 'Escape') {
        dialog.close();
        return;
      }
      if (e.key !== 'Enter' || e.target?.id !== 'dlg-input') return;
      // ⚠️ 输入法组字中按 Enter 是"选词"，不能顺手把对话框确认掉
      //    （改昵称/房间名时最容易踩：拼音打到一半对话框直接关了）。
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      $('dlg-ok').click();
    });
  },
};
