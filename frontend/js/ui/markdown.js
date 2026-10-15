/* ============================================================================
 * ui/markdown.js · 气泡里的极简 Markdown 渲染（2026-10-15）
 *
 * 为什么自己写而不是上 marked/markdown-it：
 *   1. 消息是**他人可控的签名内容**——引一个解析库（+转义管线）进来，供应链和
 *      XSS 面都要重新审；这里全部用 DOM API 建节点，**任何字符都只能成为文本**，
 *      安全边界和 `_fillMentions` 完全一致（零 innerHTML）。
 *   2. 聊天场景只需要一个很小的子集（见下），完整 CommonMark 是杀鸡用牛刀。
 *
 * 支持：围栏代码块 ```、行内代码 `x`、**粗体**、*斜体*、#~###### 标题、
 *      - / * / 1. 列表（单层，缩进忽略）、> 引用、--- 分隔线、
 *      [文字](https://…) 与裸链接。表格/图片/原始 HTML **不支持**（一律当文本，
 *      图片另有 `[img]` 白名单通道）。
 *
 * 什么时候渲染：`looksLikeMarkdown()` 探测到上述特征才渲染——普通聊天
 * （"2*3=6"、"- 好的"）保持原样；只有像 Markdown 的消息才换排版。
 * 气泡右上角的「原文/排版」开关（timeline.js 挂）负责随时切回原文复制。
 * ==========================================================================*/

const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.+)$/;
const OL_RE = /^(\s*)\d{1,3}[.)]\s+(.+)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一行是不是"块级起点"（段落收集时用来断行） */
function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

/** 这条消息像不像 Markdown（决定要不要渲染 + 出「原文」开关） */
export function looksLikeMarkdown(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return (
    /(^|\n)\s*(```|~~~)/.test(t) ||
    /(^|\n)#{1,6}\s+\S/.test(t) ||
    /(^|\n)\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(t) ||
    /(^|\n)\s*>\s?\S/.test(t) ||
    /\*\*[^*\n]+\*\*/.test(t) ||
    /`[^`\n]+`/.test(t) ||
    /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(t)
  );
}

/** 只允许 http/https 的链接；其余一律当纯文本（`javascript:` 到不了这里） */
function mkLink(href, label) {
  const a = document.createElement('a');
  a.className = 'md-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  a.textContent = label;
  return a;
}

/** 行内：`code` / **粗** / *斜* / [文字](https) / 裸链接；其余全是文本节点 */
function renderInline(parent, text) {
  const s = String(text ?? '');
  const SPECIAL = /`|\*\*?|\[|https?:\/\//g;
  let i = 0;
  const push = (chunk) => {
    if (chunk) parent.appendChild(document.createTextNode(chunk));
  };
  while (i < s.length) {
    SPECIAL.lastIndex = i;
    const found = SPECIAL.exec(s);
    if (!found) {
      push(s.slice(i));
      return;
    }
    const at = found.index;
    if (at > i) push(s.slice(i, at));
    const rest = s.slice(at);
    let m;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      const code = document.createElement('code');
      code.textContent = m[1];
      parent.appendChild(code);
      i = at + m[0].length;
      continue;
    }
    if ((m = /^\*\*([^*\n]+)\*\*/.exec(rest))) {
      const strong = document.createElement('strong');
      renderInline(strong, m[1]);
      parent.appendChild(strong);
      i = at + m[0].length;
      continue;
    }
    if ((m = /^\*([^*\n]+)\*/.exec(rest))) {
      const em = document.createElement('em');
      renderInline(em, m[1]);
      parent.appendChild(em);
      i = at + m[0].length;
      continue;
    }
    if ((m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      parent.appendChild(mkLink(m[2], m[1]));
      i = at + m[0].length;
      continue;
    }
    if ((m = /^https?:\/\/[^\s<>"'）”、，。；：！？]+/.exec(rest))) {
      let url = m[0].replace(/[.,;:!?)\]]+$/, '');
      if (url.length <= 'https://'.length) {
        push(found[0]);
        i = at + found[0].length;
        continue;
      }
      parent.appendChild(mkLink(url, url));
      i = at + url.length;
      continue;
    }
    // 命中了特殊字符但没构成语法（比如单个 `*`）：当普通文本推进一格
    push(s[at]);
    i = at + 1;
  }
}

/** 块级：把 text 渲染进 box（box 由调用方负责先清空/加类） */
export function renderMarkdownInto(box, text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const markerRe = new RegExp(`^\\s*${escapeRe(fence[1])}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !markerRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 收尾围栏（没有就当到结尾）
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[2]) code.dataset.lang = fence[2];
      code.textContent = body.join('\n');
      pre.appendChild(code);
      box.appendChild(pre);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const el = document.createElement('div');
      el.className = `md-h md-h${heading[1].length}`;
      renderInline(el, heading[2]);
      box.appendChild(el);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      box.appendChild(document.createElement('hr'));
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const parts = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        parts.push(q[1]);
        i += 1;
      }
      const bq = document.createElement('blockquote');
      parts.forEach((part, idx) => {
        if (idx) bq.appendChild(document.createElement('br'));
        renderInline(bq, part);
      });
      box.appendChild(bq);
      continue;
    }

    const firstUl = UL_RE.exec(line);
    const firstOl = firstUl ? null : OL_RE.exec(line);
    if (firstUl || firstOl) {
      const ordered = !!firstOl;
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const u = UL_RE.exec(lines[i]);
        const o = u ? null : OL_RE.exec(lines[i]);
        if (!u && !o) break;
        if (!!o !== ordered) break; // - 和 1. 混排：拆成两段列表，别硬塞
        const item = document.createElement('li');
        renderInline(item, (u ?? o)[2]);
        list.appendChild(item);
        i += 1;
      }
      box.appendChild(list);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    const p = document.createElement('p');
    para.forEach((ln, idx) => {
      if (idx) p.appendChild(document.createElement('br'));
      renderInline(p, ln);
    });
    box.appendChild(p);
  }
}
