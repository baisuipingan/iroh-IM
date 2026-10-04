"""验证「上来就失败」的修复：陈旧邀约不再诈尸。

做法（不依赖真实传输，最干净）：
  1. 单独开一个页面进房，读出自己的 endpoint id
  2. 往 localStorage 注入两条邀约记录：
     - `fakestale`：11 分钟前（超过 10 分钟 TTL）→ **不该被恢复**
     - `fakelive` ：刚刚（TTL 内），但发送方 id 是虚构的、不在房间里
                   → 先恢复，等 presence 到了应变「发送方已离开房间」
  3. 重新加载页面
  4. 断言：`fakestale` 不在 transfers 里；`fakelive` 最终变 expired
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = "st9"; V = int(time.time()); K = lambda c: c * 64
URL = f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('b')}&v={V}"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(URL)
p = tt.Page(tab["id"]); p.call("Runtime.enable")
tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
              120, label="rx")
my_id = p.ev("window.__state().myId")
print(f"已进房，myId={my_id[:16]}…", flush=True)

# 注入三条记录
p.ev(f"""(() => {{
  const anchor = (window.__net && window.__net.config && window.__net.config.anchor)
    ? window.__net.config.anchor.id : '';
  const mk = (fid, ts, sender) => ({{
    room: {json.dumps(ROOM)}, ts, owner: {json.dumps(my_id)}, senderId: sender,
    meta: {{
      file_id: fid, name: fid + '.bin', size: 1048576, mime: '',
      chunk_size: 16384, root_hash: 'deadbeef', sender, sender_relay: '', ts: 0,
    }},
  }});
  const now = Date.now();
  localStorage.setItem('iroh.pending-invites', JSON.stringify({{
    ver: 3,
    items: [
      mk('fakestale',   now - 11 * 60 * 1000, 'aabbccdd'),
      mk('fakelive',    now,                   'eeff0011'),
      mk('fakepresent', now,                   anchor),
    ],
  }}));
  return anchor;
}})()""")
print("已注入 fakestale(11分钟前) / fakelive(发送方不在房间) / fakepresent(发送方=常驻节点，在房间里)",
      flush=True)

# 重新加载
p.call("Page.navigate", {"url": URL})
time.sleep(3)
tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
              120, label="reload")
print("已重新加载并进房", flush=True)


def snapshot():
    return json.loads(p.ev("JSON.stringify(window.__transfers())") or "[]")


# 立刻看一次（presence 可能还没到）
time.sleep(1)
early = {t["file_id"]: t["state"] for t in snapshot()}
print(f"  加载后立刻: {early}", flush=True)

print("等待 presence（最多 40 秒）…", flush=True)
final = early
t0 = time.time()
while time.time() - t0 < 40:
    time.sleep(3)
    final = {t["file_id"]: t["state"] for t in snapshot()}
    print(f"  [{time.time()-t0:3.0f}s] {final}", flush=True)
    # fakepresent 稳定在 interrupted 且 fakelive 已经有结论，就够判定了
    if final.get("fakepresent") == "interrupted" and "fakelive" not in final:
        break

print(flush=True)
tt.check("TTL 过期的旧邀约不再被恢复", "fakestale" not in final,
         f"实际状态={final.get('fakestale')!r}")
# 发送方已离开：要么直接不显示，要么降级成 expired —— 两者都不误导用户。
# 具体走哪条取决于 presence 与 restoreInvites 的先后（都是允许的）。
tt.check("发送方已离开的邀约不会变成可点的「继续接收」",
         final.get("fakelive") in (None, "expired"),
         f"实际={final.get('fakelive')!r}")
tt.check("发送方仍在房间时必须能恢复（证明恢复链路没坏）",
         final.get("fakepresent") == "interrupted",
         f"实际={final.get('fakepresent')!r}")

# --- DOM 层：卡片上的按钮应当是「移除」，不能是「重新发送」（↻） ---
try:
    btns = p.ev("""(() => {
      const el = document.querySelector('[data-file-id="fakelive"]')
              || document.querySelector('[data-file-id="fakepresent"]');
      if (!el) return 'NO_CARD';
      const b = el.querySelector('.filecard__btn');
      return JSON.stringify({
        fid: el.dataset.fileId, dir: el.dataset.dir,
        cls: b ? b.className : null, title: b ? b.title : null,
      });
    })()""")
    print(f"  卡片按钮: {btns}", flush=True)
    import json as _j
    info = _j.loads(btns) if btns and btns != "NO_CARD" else {}
    tt.check("接收卡片不会出现「重发」按钮",
             "is-again" not in (info.get("cls") or ""), f"cls={info.get('cls')}")
except Exception as e:
    tt.check("接收卡片不会出现「重发」按钮", False, f"异常 {e}")

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
