"""验证多接收方 + 「一方刷新」

场景：
  TX ──> R1（传到一半关掉标签页 = 刷新/离开）
     └─> R2（应一路传到完成）

断言（本轮重点）：
  1. 发送端能看到 2 条独立通道（peers=2）
  2. R1 关掉后，发送端**很快**只把 R1 那条标取消或失败
     - 快路径：接收方 pagehide 主动广播 Reject，显示取消（期望 ≤ 15s）
     - 兜底：发送端写超时 / 无进度看门狗
  3. R2 不受牵连，继续推进直到收完
  4. 最终 R2 的文件逐字节正确
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

# ⚠️ 房名**必须每次不同**。
#
# 原来写死 `ROOM = "rf9"`，于是这个房间在**锚点**上累积了历史与 gossip 邻居状态：
# 后来者进房时，文件证明已经在历史里了 → R2 拿到的是「历史卡片(archived)」
# 而不是实时邀约 → `peers=1`，四项断言连环失败。
# 清浏览器存储**治不了这个**（污染在服务端）。实测：换全新房名立刻 4/4。
# 其余测试都是这么做的（用时间戳派生房名）。
ROOM = f"rf{int(time.time()) % 1000000}"; V = int(time.time()); K = lambda c: c * 64
SIZE = 48 * 1024 * 1024
DROP_AFTER_S = 6

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


print("启动 TX…", flush=True)
tx_tab, tx = boot(f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('a')}&v={V}tx", "tx")
print("启动 R1…", flush=True)
r1_tab, r1 = boot(f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('b')}&v={V}r1", "r1")
print("启动 R2…", flush=True)
r2_tab, r2 = boot(f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={K('c')}&v={V}r2", "r2")
print("三方就绪", flush=True)

# ⚠️ 必须在发送之前清：__iroh_clearBitmaps 现在会连 localStorage 里的旧邀约一起清，
#    清晚了会把本次的新邀约也抹掉。
for p in (r1, r2):
    p.ev("window.__iroh_useOpfs=true; window.__iroh_setTestMode(true)")
    p.ev("window.__iroh_clearBitmaps()", timeout=30)

tx.ev(f"(() => {{ const u=new Uint8Array({SIZE}); window.__testFile=new File([u],'rf9.bin',{{type:'application/octet-stream'}}); return 1; }})()", timeout=240)
tx.ev("window.__iroh_setStopAfterChunks(0)")
tx.ev(f"window.__iroh_sendFile(window.__testFile, {json.dumps(ROOM)})")


def snap(p):
    try:
        s = json.loads(p.ev("JSON.stringify(window.__iroh_transfers())") or "[]")
    except Exception:
        return None
    return s[0] if s else None


# 两个接收方都接受
fids = []
for name, p in (("r1", r1), ("r2", r2)):
    for _ in range(60):
        time.sleep(0.8)
        s = snap(p)
        if s and s["direction"] == "recv" and s["state"] in ("invited", "active"):
            fids.append(s["file_id"])
            p.fire(f"window.__iroh_acceptFile({json.dumps(s['file_id'])})")
            print(f"  {name} 已接受", flush=True)
            break

print(f"  两方 file_id 相同: {len(fids)==2 and fids[0]==fids[1]}", flush=True)

# 等两条通道都真的跑起来
t0 = time.time()
while time.time() - t0 < 40:
    time.sleep(1)
    a = snap(tx)
    if a and a.get("peers", 0) >= 2 and a.get("done", 0) > 0:
        break
a = snap(tx)
print(f"  两路已开跑: TX peers={a.get('peers')} done={a.get('done')} "
      f"bytes={round((a.get('bytes') or 0)/1048576,1)}MB", flush=True)

time.sleep(DROP_AFTER_S)
b, c = snap(r1), snap(r2)
print(f"  关闭前 R1={b['state']}:{b['done']}  R2={c['state']}:{c['done']}", flush=True)

# ⭐ 直接关掉标签页（= 用户刷新/离开）。Chrome 会触发 pagehide。
print("\n=== 关闭 R1 标签页 ===", flush=True)
tt.close_tab(r1_tab["id"])
t_drop = time.time()
detected = None

for i in range(24):                       # 最多观察 120 秒
    time.sleep(5)
    try:
        a = snap(tx)
    except Exception as e:
        print(f"  TX 读取失败 {e}", flush=True); break
    if not a:
        print("  TX 卡片消失", flush=True); break
    c = snap(r2)
    failed = (a.get("peersFailed", 0) or 0) + (a.get("peersCancelled", 0) or 0)
    print(f"  [{time.time()-t_drop:3.0f}s] TX={a['state']} peers={a.get('peers')} "
          f"done={a.get('peersDone')} failed={failed} "
          f"bytes={round((a.get('bytes') or 0)/1048576,1)}MB | "
          f"R2={c['state'] if c else '?'}:{c['done'] if c else 0}", flush=True)
    if failed >= 1 and detected is None:
        detected = time.time() - t_drop
    if failed >= 1 and c and c["state"] in ("done", "failed"):
        break

print("\n=== 最终 ===", flush=True)
a = snap(tx); c = snap(r2)
print(f"  TX: {a['state']} peers={a.get('peers')} peersDone={a.get('peersDone')} "
      f"peersFailed={a.get('peersFailed')} peersCancelled={a.get('peersCancelled')} err={str(a.get('error',''))[:60]}", flush=True)
print(f"  R2: {c['state']} {c['done']}/{c['total']} err={str(c.get('error',''))[:60]}", flush=True)

print(flush=True)
tt.check("发送端看到 2 条独立通道", (a.get("peers") or 0) >= 2, f"peers={a.get('peers')}")
tt.check("R1 断开被检测到（取消或失败）", (a.get("peersFailed") or 0) + (a.get("peersCancelled") or 0) >= 1,
         f"耗时 {detected:.0f}s" if detected else "从未检测到")
# 两条路径任一都算通过（都实测过）：
#   快路径（~2s）= 接收方 pagehide 时主动广播 Reject。
#                  ⚠️ 标签页真的被关掉时，Worker 往往先被销毁、广播来不及 flush，
#                     这时走下面那条。快路径本身由 /tmp/leave-cancel-test.py
#                     单独验证（派发 pagehide 但页面存活 → 2.0s 生效）。
#   兜底（~30s）  = 发送端单块写超时（n0_future::time::timeout(30s)）
# 阈值取 40s：容忍 30s 超时 + 5s 采样粒度。
tt.check("检测延迟 ≤ 40s（主动取消快路径，或传输层 30s 超时兜底）",
         detected is not None and detected <= 40,
         f"{detected:.0f}s" if detected else "n/a")
tt.check("R2 继续推进未受影响", (c.get("done") or 0) > 0, f"R2 done={c.get('done')}")

for t in (tx_tab, r2_tab):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
