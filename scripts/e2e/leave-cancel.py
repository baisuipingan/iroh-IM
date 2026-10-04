"""单独验证「刷新方主动取消」这条快路径本身是否有效。

做法：不真的关标签页（那样 Worker 会被销毁、广播可能来不及发），
而是**手动派发 pagehide 事件**并让页面继续存活 —— 这样能把
"逻辑是否对" 和 "广播来不来得及发" 两件事分开判断。

预期：派发后几秒内发送端就把该用户标为取消（peersCancelled → 1）。
若 10 秒都没反应，说明 pagehide → Reject 这条链路真的坏了。
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = f"lc{int(time.time()) % 100000}"; V = int(time.time())
SIZE = 48 * 1024 * 1024
K = lambda c: c * 64

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)


def boot(url, label):
    tab = tt.open_tab(url)
    p = tt.Page(tab["id"]); p.call("Runtime.enable")
    tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
                  120, label=label)
    return tab, p


tx_tab, tx = boot(f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('a')}&v={V}tx", "tx")
rx_tab, rx = boot(f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('b')}&v={V}rx", "rx")
rx.ev("window.__useOpfs=true; window.__setTestMode(true)")
rx.ev("window.__clearBitmaps()", timeout=30)
tx.ev(f"(() => {{ const u=new Uint8Array({SIZE}); window.__testFile=new File([u],'lc.bin',{{type:'application/octet-stream'}}); return 1; }})()", timeout=240)
tx.ev("window.__setStopAfterChunks(0)")
tx.ev(f"window.__sendFile(window.__testFile, {json.dumps(ROOM)})")

def snap(p):
    try:
        s = json.loads(p.ev("JSON.stringify(window.__transfers())") or "[]")
    except Exception:
        return None
    return s[0] if s else None

for _ in range(60):
    time.sleep(0.8)
    s = snap(rx)
    if s and s["direction"] == "recv" and s["state"] in ("invited", "active"):
        rx.fire(f"window.__acceptFile({json.dumps(s['file_id'])})")
        break

t0 = time.time()
while time.time() - t0 < 30:
    time.sleep(1)
    a = snap(tx)
    if a and a.get("peers", 0) >= 1 and (a.get("done") or 0) > 0:
        break
a = snap(tx)
print(f"已开跑: TX peers={a.get('peers')} done={a.get('done')} failed={a.get('peersFailed')}", flush=True)

print("\n=== 在接收端派发 pagehide（页面保持存活）===", flush=True)
t_drop = time.time()
rx.ev("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
detected = None
for i in range(10):
    time.sleep(1)
    a = snap(tx)
    f = a.get("peersCancelled", 0) or 0
    print(f"  [{time.time()-t_drop:4.1f}s] TX peers={a.get('peers')} cancelled={f}", flush=True)
    if f >= 1:
        detected = time.time() - t_drop
        break

print(flush=True)
tt.check("pagehide 后发送端很快显示该用户取消（快路径有效）",
         detected is not None and detected <= 8,
         f"{detected:.1f}s" if detected else "10 秒内无反应")

for t in (tx_tab, rx_tab):
    tt.close_tab(t)
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
