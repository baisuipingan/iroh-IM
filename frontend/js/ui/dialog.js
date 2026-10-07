/* ============================================================================
 * ui/dialog.js · 通用对话框
 * 取代浏览器原生 prompt/confirm，统一视觉与键盘行为（Esc 关闭、Enter 确认）。
 * ==========================================================================*/

import { esc } from '../util.js';

const $ = (id) => document.getElementById(id);
let onOk = null;
let previousFocus = null;
let previousFocusSelector = '';
const inertElements = new Map();

export const dialog = {
  open({ title, body = '', okText = '确定', cancelText = '取消', onOk: cb }) {
    if (!$('modal').classList.contains('is-on')) {
      previousFocus = document.activeElement;
      previousFocusSelector = previousFocus?.id ? `#${CSS.escape(previousFocus.id)}` : '';
      for (const attribute of ['data-act', 'data-room', 'data-toggle']) {
        if (previousFocus?.hasAttribute(attribute)) previousFocusSelector = `[${attribute}="${CSS.escape(previousFocus.getAttribute(attribute))}"]`;
      }
    }
    for (const sibling of document.body.children) {
      if (sibling === $('modal') || sibling.tagName === 'SCRIPT') continue;
      if (!inertElements.has(sibling)) inertElements.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    $('dlg-title').textContent = title;
    $('dlg-body').innerHTML = body;
    const error = document.createElement('div');
    error.id = 'dlg-error';
    error.className = 'dialog__error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    $('dlg-body').appendChild(error);
    $('dlg-ok').textContent = okText;
    $('dlg-cancel').textContent = cancelText;
    onOk = cb || null;
    $('modal').classList.add('is-on');
    // 自动聚焦第一个可输入元素
    $('dlg-ok').disabled = false;
    ($('dlg-body').querySelector('input, select, textarea, button') || $('dlg-ok')).focus();
  },

  close() {
    $('modal').classList.remove('is-on');
    onOk = null;
    for (const [element, wasInert] of inertElements) element.inert = wasInert;
    inertElements.clear();
    const target = previousFocus?.isConnected ? previousFocus : previousFocusSelector && document.querySelector(previousFocusSelector);
    target?.focus();
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
        `<label class="dialog__label" for="dlg-input">${esc(label)}</label>` +
        `<input id="dlg-input" class="dialog__field" value="${esc(value)}" placeholder="${esc(placeholder)}" />` +
        (hint ? `<div class="dialog__hint">${hint}</div>` : ''),
      okText,
      onOk: () => onOk($('dlg-input').value.trim()),
    });
  },

  bind() {
    $('dlg-cancel').onclick = () => dialog.close();
    $('dlg-ok').onclick = async () => {
      const callback = onOk;
      $('dlg-ok').disabled = true;
      try {
        $('dlg-error').hidden = true;
        if (callback && await callback() === false) return;
        if (callback === onOk) dialog.close();
      } catch (error) {
        if (callback !== onOk) return;
        $('dlg-error').textContent = error?.message || '操作失败，请重试';
        $('dlg-error').hidden = false;
      } finally { $('dlg-ok').disabled = false; }
    };
    $('modal').onclick = (e) => {
      if (e.target === $('modal')) dialog.close();
    };
    document.addEventListener('keydown', (e) => {
      if (!$('modal').classList.contains('is-on')) return;
      if (e.key === 'Tab') {
        const controls = [...$('modal').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
        const index = controls.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0) { e.preventDefault(); controls.at(-1)?.focus(); }
        else if (!e.shiftKey && (index < 0 || index === controls.length - 1)) { e.preventDefault(); controls[0]?.focus(); }
        return;
      }
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
