"""验证修复：断线时点了房间 → 节点恢复后必须**真的进房**（而不是停在假房间）。

以前的 bug：离线分支只切界面、没记房间，net 的"重连回原房间"依赖 _room，
于是恢复后永远不会 join —— 界面看着正常，但一条消息都收不到。
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

R1 = f"oa{int(time.time()) % 100000}"
R2 = f"ob{int(time.time()) % 100000}"
V = int(time.time())
BASE = "http://127.0.0.1:8099/?autostart=1&testid=1&v=" + str(V)

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(BASE + "&room=" + R1)
p = tt.Page(tab["id"]); p.call("Runtime.enable")
tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(R1)})", 120, label="A")
print(f"已进房 {R1}", flush=True)

print("\n=== 模拟断线，然后在断线状态下点另一个房间 ===", flush=True)
p.ev("window.__net.ready = false; window.__net.phase = 'reconnecting'")
time.sleep(0.3)
p.ev(f"window.__openRoom({json.dumps(R2)})", timeout=30)
time.sleep(2)
s = json.loads(p.ev("JSON.stringify(window.__state())"))
print(f"  phase={s['phase']} joined={s['joined']} room={s['room']} notes={s['notes'][-1:]}",
      flush=True)
tt.check("断线时点房间：界面切过去但确实没进房", s["joined"] is None and s["room"] == R2,
         f"joined={s['joined']} room={s['room']}")

print("\n=== 恢复网络（走真实 reconnect 流程）===", flush=True)
p.ev("window.__net.reconnect()")
time.sleep(5)
s2 = json.loads(p.ev("JSON.stringify(window.__state())"))
print(f"  phase={s2['phase']} joined={s2['joined']} composer={s2['composerEnabled']} "
      f"notes={s2['notes'][-1:]}", flush=True)
tt.check("恢复后真的进入了那个房间（不再停在假房间）", s2["joined"] == R2,
         f"joined={s2['joined']} 期望={R2}")
tt.check("恢复后输入区可用", s2["composerEnabled"] is True, str(s2["composerEnabled"]))

# 真发一条，确认真的在这个房间里（能收到说明确实 join 了）
hi = tt.open_tab(BASE + "&room=" + R2)
hp = tt.Page(hi["id"]); hp.call("Runtime.enable")
tt.wait_until(hp, f"!!(window.__state && window.__state().joined === {json.dumps(R2)})", 120, label="B")
hp.ev("window.__sendText('进房验证')", timeout=20)
time.sleep(4)
msgs = json.loads(p.ev("JSON.stringify(window.__state())"))["messages"]
tt.check("确实已加入房间（能收到该房间的消息）", "进房验证" in msgs, str(msgs))

for t in (tab["id"], hi["id"]):
    tt.close_tab(t)
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
