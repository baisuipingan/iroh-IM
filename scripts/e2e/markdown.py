#!/usr/bin/env python3
"""Markdown 气泡：渲染 + 「原文」开关 + XSS 安全 + 普通消息不被误渲染。

覆盖（2026-10-15）：
  A. 像 Markdown 的消息渲染：标题 / 列表（行内 code、粗体）/ 围栏代码块 /
     链接（含裸链），且结构正确；
  B. 气泡右上角「原文」开关：点一下变原文（textContent 与原文**逐字一致**），
     再点回排版；
  C. 安全：`<img onerror>` / `javascript:` 链接只能变成文本，绝不产生元素；
  D. 普通聊天（"2*3=6"、句子中间的 "- "）**不**渲染、没有开关；
  E. 带 @ 提及的消息仍走 chip 路径（Markdown 与 chip 不混排）。

注入走 `net._dispatch`（和 Worker 推事件同一条路径，不是测试旁路）。
"""
import importlib.util, sys, time, json, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"md{V % 100000}"
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(f"{SITE}/?autostart=1&room={ROOM}&key={'a' * 64}&v={V}")
p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label="joined")
p.ev("window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message)))")

dispatch = "(() => { window.__iroh_net._dispatch(%s); return 1; })()"


def inject(mid, text, nickname="甲"):
    p.ev(dispatch % json.dumps(
        {"type": "message", "room": ROOM, "mine": False,
         "message": {"id": mid, "from": "d" * 64, "nickname": nickname,
                     "text": text, "ts": int(time.time() * 1000)}}))
    time.sleep(0.5)


MD_DOC = """## 环境信息

- 目录：`/Users/patrick/Downloads`
- 版本：**v4.1**

```bash
echo hi
```

看这里 [文档](https://example.com/docs) 和裸链 https://example.com/plain。
"""

XSS = '**ok** <img src=x onerror="window.__xss=1"> [坏](javascript:window.__xss=2)'
PLAIN = "你好，2*3=6，还有 - 这个不是列表"
MENTION = "@deadbeef **不该渲染**"

inject("md-1", MD_DOC)
inject("md-xss", XSS)
inject("plain-1", PLAIN, nickname="乙")
inject("md-mention", MENTION, nickname="丙")

sel = lambda mid: f'.msg[data-id="{mid}"]'

# ── A. 渲染结构 ────────────────────────────────────────────────────────
tt.check("Markdown 消息带 bubble--md",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} .bubble--md\')') is True)
tt.check("二级标题渲染为 .md-h2",
         p.ev(f'document.querySelector(\'{sel("md-1")} .md-h2\')?.textContent') == "环境信息")
lis = json.loads(p.ev(f'JSON.stringify([...document.querySelectorAll(\'{sel("md-1")} li\')].map(e=>e.textContent))'))
tt.check("列表渲染为两个 li（含行内 code / strong）",
         lis == ["目录：/Users/patrick/Downloads", "版本：v4.1"],
         json.dumps(lis, ensure_ascii=False))
tt.check("列表里是真正的 code 与 strong 元素",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} li code\')') is True and
         p.ev(f'!!document.querySelector(\'{sel("md-1")} li strong\')') is True)
tt.check("围栏代码块：pre>code 内容与语言标记",
         p.ev(f'document.querySelector(\'{sel("md-1")} pre code\')?.textContent') == "echo hi" and
         p.ev(f'document.querySelector(\'{sel("md-1")} pre code\')?.dataset.lang') == "bash")
tt.check("md 链接：href/文字/rel/target",
         p.ev(f'document.querySelector(\'{sel("md-1")} a[href="https://example.com/docs"]\')?.textContent') == "文档" and
         "noopener" in (p.ev(f'document.querySelector(\'{sel("md-1")} a[href="https://example.com/docs"]\')?.rel') or "") and
         p.ev(f'document.querySelector(\'{sel("md-1")} a[href="https://example.com/docs"]\')?.target') == "_blank")
tt.check("裸链接自动成链",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} a[href="https://example.com/plain"]\')') is True)

# ── B. 原文开关 ────────────────────────────────────────────────────────
tt.check("渲染态有「原文」开关",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} .bubble__md-toggle\')') is True)
p.ev(f'document.querySelector(\'{sel("md-1")} .bubble__md-toggle\').click()')
time.sleep(0.3)
tt.check("切原文：textContent 与原文逐字一致",
         p.ev(f'document.querySelector(\'{sel("md-1")} .bubble\').textContent') == MD_DOC)
tt.check("切原文：bubble--md 类被摘掉、没有 strong 元素",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} .bubble--md\')') is False and
         p.ev(f'!!document.querySelector(\'{sel("md-1")} strong\')') is False)
p.ev(f'document.querySelector(\'{sel("md-1")} .bubble__md-toggle\').click()')
time.sleep(0.3)
tt.check("再点回排版：strong 回来了",
         p.ev(f'!!document.querySelector(\'{sel("md-1")} strong\')') is True)

# ── C. 安全 ────────────────────────────────────────────────────────────
tt.check("XSS：<img onerror> 不产生元素（只有文本）",
         p.ev(f'document.querySelector(\'{sel("md-xss")} .bubble\').querySelectorAll("img").length') == 0 and
         p.ev(f'document.querySelector(\'{sel("md-xss")} .bubble\').textContent.includes("<img src=x onerror=")') is True)
tt.check("XSS：javascript: 链接不产生 <a>",
         p.ev(f'document.querySelector(\'{sel("md-xss")} .bubble\').querySelectorAll("a").length') == 0)
tt.check("XSS：onerror 没有被执行",
         p.ev("window.__xss === undefined") is True)

# ── D. 普通消息不渲染 ──────────────────────────────────────────────────
tt.check("普通消息：不加 bubble--md、没有开关、内容逐字一致",
         p.ev(f'document.querySelector(\'{sel("plain-1")} .bubble\').textContent') == PLAIN and
         p.ev(f'!!document.querySelector(\'{sel("plain-1")} .bubble--md\')') is False and
         p.ev(f'!!document.querySelector(\'{sel("plain-1")} .bubble__md-toggle\')') is False)

# ── E. @ 提及仍走 chip，不与 Markdown 混排 ─────────────────────────────
tt.check("带 @ 的消息：chip 正常、无 Markdown 渲染、无开关",
         p.ev(f'!!document.querySelector(\'{sel("md-mention")} .mention\')') is True and
         p.ev(f'!!document.querySelector(\'{sel("md-mention")} .bubble--md\')') is False and
         p.ev(f'!!document.querySelector(\'{sel("md-mention")} .bubble__md-toggle\')') is False)

tt.check("页面没有未处理异常", p.ev("window.__errs.length") == 0, p.ev("JSON.stringify(window.__errs)"))

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
