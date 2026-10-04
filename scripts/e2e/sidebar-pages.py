"""状态页 / 设置页的针对性回归。

覆盖两件事：
  A. **布局**：本轮修掉的溢出 bug 不再出现
     · 状态页「中继」行里 id 与状态文字**不重叠**（改前 URL 溢出压住"已连接"，
       实测截图出现「iroh1.editor.vi已连接13/」这种叠字）
     · 面板内任何文本元素都不横向溢出面板
     · 身份 ID 按 8 位分组（64 位 hex 连排不可读）
  B. **控件真的接线**：三个"看着真、其实没反应"的地方
     · 设置页资料卡的「复制」按钮（原来 bind 选择器是 `.set-row[data-act]`，
       而这个按钮在 `.set-card` 里 → 从来没被绑定）
     · 「标题显示未读数」开关（原来存了值，但没有任何代码读它）
"""
import importlib.util, sys, time, json

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"ui{V % 100000}"
# 默认打本地；给个环境变量就能打线上（两边的静态资源逐字节一致，
# 所以本地通过 + 哈希一致 ⇒ 线上也通过）。
import os
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")
BASE = f"{SITE}/?autostart=1&room={ROOM}&testid=1"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)


def boot(url, label, wait_join=True):
    tab = tt.open_tab(url)
    p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
    if wait_join:
        tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label=label)
    else:
        tt.wait_until(p, "!!window.__state", 120, label=label)
    return tab, p


tab, P = boot(BASE, "页面")
time.sleep(2)

# ── A1/A2：布局无重叠、无横向溢出 ──────────────────────────────────
P.ev("document.getElementById('tab-status').click()")
time.sleep(1.2)

overlap = P.ev("""(() => {
  const bad = [];
  for (const row of document.querySelectorAll('#panel-body .relay')) {
    const id = row.querySelector('.relay__id');
    const st = row.querySelector('.relay__state');
    if (!id || !st) continue;
    const a = id.getBoundingClientRect(), b = st.getBoundingClientRect();
    // id 的右边界越过 status 的左边界 = 叠字
    if (a.right > b.left + 1) bad.push(id.textContent + ' 与 ' + st.textContent + ' 重叠 ' + Math.round(a.right - b.left) + 'px');
  }
  return JSON.stringify(bad);
})()""")
tt.check("状态页中继行内不出现文字重叠", overlap == "[]", overlap)

n_overflow = P.ev("""(() => {
  const panel = document.getElementById('panel').getBoundingClientRect();
  let n = 0;
  for (const el of document.querySelectorAll('#panel-body *')) {
    if (!el.textContent || !el.textContent.trim()) continue;
    if (el.children.length) continue;              // 只看叶子节点
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > panel.right + 1 || r.left < panel.left - 1) n++;
  }
  return String(n);
})()""")
tt.check("状态页没有元素横向溢出面板", n_overflow == "0", f"溢出元素数={n_overflow}")

# ── A3：身份 ID 分组显示 ──────────────────────────────────────────
ids = P.ev("""(() => {
  const el = document.querySelector('#panel-body .id-hex');
  if (!el) return 'MISSING';
  const t = el.textContent.trim();
  const groups = t.split(/\\s+/);
  return JSON.stringify({ groups: groups.length, lens: [...new Set(groups.map(g => g.length))], chars: t.replace(/\\s/g,'').length });
})()""")
ok_id = False
detail = ids
try:
    d = json.loads(ids)
    # 64 位 hex 按 8 位分组 = 8 组，且每组长度一致
    ok_id = d["groups"] == 8 and d["lens"] == [8] and d["chars"] == 64
except Exception:
    pass
tt.check("身份 ID 按 8 位分组显示（不是一串 64 位）", ok_id, detail)

# ── A4：标题计数与下面行数自洽 ────────────────────────────────────
consistent = P.ev("""(() => {
  const title = [...document.querySelectorAll('#panel-body .section-title')]
    .find(e => e.textContent.includes('中继'));
  if (!title) return 'NO-TITLE';
  const rows = document.querySelectorAll('#panel-body .relay').length;
  const m = title.textContent.match(/配置\\s*(\\d+)/);
  const cfg = m ? Number(m[1]) : -1;
  return JSON.stringify({ rows, cfg, text: title.textContent.trim() });
})()""")
d = json.loads(consistent) if consistent.startswith("{") else {}
tt.check("中继标题的「配置 N」与实际行数一致",
         d.get("rows") == d.get("cfg") and d.get("rows", 0) > 0,
         consistent)

# ── B1：设置页资料卡的「复制」按钮真的绑定了 ──────────────────────
# 先授权剪贴板，好走**成功**分支（headless 默认拒绝 clipboard.writeText，
# 那样只能验证到"有反馈"，验证不了"复制成功 + 按钮变已复制"）。
try:
    P.call("Browser.grantPermissions", {
        "origin": SITE,
        "permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
except Exception:
    pass   # 授权失败就退化成"有反馈即可"的弱断言
P.ev("document.getElementById('tab-settings').click()")
time.sleep(1.2)
P.ev("document.getElementById('composer-tip').textContent = ''")
P.ev("document.getElementById('composer-tip').classList.remove('is-on')")
P.ev("""(() => {
  const b = document.querySelector('.set-card__id button[data-act="copy-id"]');
  if (b) b.click();
  return b ? 'clicked' : 'NO-BUTTON';
})()""")
time.sleep(0.8)
feedback = P.ev("""(() => {
  const b = document.querySelector('.set-card__id button[data-act="copy-id"]');
  return JSON.stringify({
    btn: b ? b.textContent.trim() : null,
    tip: (document.getElementById('composer-tip').textContent || '').trim(),
  });
})()""")
d = json.loads(feedback)
# 成功走「已复制」，失败也会弹 tip —— 两者都说明按钮**被绑定**了；
# 改前这两者都不会发生（点了完全没反应）。
tt.check("设置页「复制」按钮点击后有反馈（说明已绑定）",
         d["btn"] == "已复制" or bool(d["tip"]), feedback)

# ── B2：「标题显示未读数」开关真的生效 ────────────────────────────
def title_with(flash, tag):
    url = f"{BASE}&u={tag}"
    t2, p2 = boot(url, tag, wait_join=False)
    # 在应用启动**之后**写存储再重载，保证 init 读的是我们塞的值
    p2.ev(f"""(() => {{
      localStorage.setItem('iroh.last-room', JSON.stringify('__other__'));
      localStorage.setItem('iroh.unread', JSON.stringify({{ '__unread-room__': 3 }}));
      localStorage.setItem('iroh.prefs', JSON.stringify({{ flashTitle: {str(flash).lower()} }}));
      return 1;
    }})()""")
    p2.call("Page.navigate", {"url": url + "&r=1"})
    tt.wait_until(p2, "!!window.__state", 120, label=tag + "-reload")
    time.sleep(2)
    title = p2.ev("document.title")
    tt.close_tab(t2["id"])
    return title

on = title_with(True, "tf-on")
tt.check("开关打开时标题带未读数", "(3)" in on, f"title={on!r}")
off = title_with(False, "tf-off")
tt.check("开关关闭时标题不带未读数", "(3)" not in off, f"title={off!r}")

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
