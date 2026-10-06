"""验证本轮修复 F15：发送方重发邀约后，接收方**已失效的卡片要复活**。

改动前的行为（报告 F15）：
  `_onInvite` 走"新建卡片"事件，而卡片层对同一 file_id 是幂等去重的 ——
  DOM 卡片既不重建、也收不到 FILE_CARD_UPDATE，于是**停在旧的"已失效"状态与
  "移除这条记录"按钮上**。用户点下去会删掉一个**有效**邀约。

现在应当：重发后卡片回到 invited（按钮变回 ✓/✗）。
"""
import importlib.util, sys, time, json

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time()); R = f"rv{V % 100000}"; R2 = f"rvx{V % 100000}"
def url(room, tag): return f"http://127.0.0.1:8099/?autostart=1&room={room}&testid=1&v={V}{tag}"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)

def boot(u, label, room):
    tab = tt.open_tab(u); p = tt.Page(tab["id"]); p.call("Runtime.enable")
    tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(room)})", 120, label=label)
    return tab, p

def card(p, fid):
    for x in json.loads(p.ev("JSON.stringify(window.__iroh_transfers())") or "[]"):
        if x["file_id"] == fid:
            return x
    return None

def dom_buttons(p, fid):
    """从 DOM 里读这张卡片的按钮文案（这才是用户实际看到的）。"""
    return p.ev(f"""(() => {{
      const el = [...document.querySelectorAll('.msg--file')].find(e => e.dataset.fileId === {json.dumps(fid)});
      if (!el) return 'NO-CARD';
      const btns = [...el.querySelectorAll('button')].map(b => (b.textContent||'').trim() || b.title || '');
      const st = el.querySelector('.filecard__state')?.textContent?.trim() || '';
      return JSON.stringify({{ st, btns }});
    }})()""")

a_tab, A = boot(url(R, "a"), "A", R)
b_tab, B = boot(url(R, "b"), "B", R)

A.ev("(() => { const u=new Uint8Array(4096); window.__testFile=new File([u],'rev.bin',{type:'application/octet-stream'}); return 1; })()")
A.ev("window.__iroh_setStopAfterChunks(0)")
A.ev(f"window.__iroh_sendFile(window.__testFile, {json.dumps(R)})")

fid = ""
for _ in range(40):
    time.sleep(0.5)
    c = card(B, "") # placeholder
    for x in json.loads(B.ev("JSON.stringify(window.__iroh_transfers())") or "[]"):
        if x["direction"] == "recv" and x["state"] == "invited":
            fid = x["file_id"]; break
    if fid: break
tt.check("B 收到实时邀约", bool(fid), f"file_id={fid}")
print(f"  初始 DOM: {dom_buttons(B, fid)}", flush=True)

# A 离开 → B 的卡片应变"已失效"
A.ev(f"(() => {{ window.__iroh_openRoom({json.dumps(R2)}); return 1; }})()")
gone = None
for _ in range(60):
    time.sleep(1)
    c = card(B, fid)
    if c and c.get("state") == "expired":
        gone = time.time(); break
c = card(B, fid)
tt.check("A 离开后卡片变 expired", bool(c and c.get("state") == "expired"),
         f"state={c and c.get('state')}")
st_exp = dom_buttons(B, fid)
print(f"  失效后 DOM: {st_exp}", flush=True)

# A 回到 R 并**重发**（这正是修复 F15 的场景）
A.ev(f"(() => {{ window.__iroh_openRoom({json.dumps(R)}); return 1; }})()")
tt.wait_until(A, f"!!(window.__state && window.__state().joined === {json.dumps(R)})", 90, label="A 回房")
A.ev(f"window.__iroh_net.client.call('resend', {json.dumps(fid)})")

revived = None
for _ in range(30):
    time.sleep(1)
    c = card(B, fid)
    if c and c.get("state") == "invited":
        revived = True; break
c = card(B, fid)
tt.check("重发后 B 的卡片复活为 invited（F15）",
         bool(c and c.get("state") == "invited"), f"state={c and c.get('state')}")

st_now = dom_buttons(B, fid)
print(f"  重发后 DOM: {st_now}", flush=True)
try:
    dom = json.loads(st_now)
    has_accept = any(("接收" in b) or ("✓" in b) for b in dom["btns"])
    is_stale = any("移除" in b for b in dom["btns"])
    tt.check("DOM 按钮回到「接收」而不再是「移除这条记录」",
             has_accept and not is_stale, f"btns={dom['btns']} state_txt={dom['st']}")
except Exception as e:
    tt.check("能解析 DOM 按钮状态", False, f"{e} raw={st_now}")

for t in (a_tab, b_tab): tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
