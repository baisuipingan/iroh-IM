"""端到端验证「文件历史 + 能力清单 + 离开即过期 + 可逆恢复」。

场景（含常驻节点，房间随用随建）：
  1. A(发送方) 与 B(接收方) 进房，A 发一个文件 → B 收发正常（回归）
  2. **C 后进房** → 应当看到文件卡片，且状态是"可接收"（发送方还在）
  3. C 点接收 → 拿到邀约 → 收完（走真实 P2P）
  4. A **主动切到别的房间**（可靠的离开广播时机）→ B/C 的卡片**很快**变"已过期"
  5. A **切回来** → 卡片**自动恢复可接收**（验证"过期是可逆的派生状态"）

断言用 `window.__transfers()` 里导出的 `avail`（UI 文案就是同一个值渲染的）。
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = f"fh{int(time.time()) % 100000}"
ROOM2 = f"fhx{int(time.time()) % 100000}"   # A 用来"离开"的另一个房间
V = int(time.time())
# A 用**固定身份**：否则刷新后它变成"另一个人"，就没法验证
# "发送方刷新后看不到自己的历史文件卡片"（那本该是同一个人的视图）。
KEY_A = "a" * 64
T = lambda n: f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&testid=1&v={V}{n}"
TA = f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&key={KEY_A}&v={V}a"

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


def snap(p):
    try:
        return json.loads(p.ev("JSON.stringify(window.__transfers())") or "[]")
    except Exception:
        return []


def card(p, pred):
    for t in snap(p):
        if pred(t):
            return t
    return None


SIZE = 1024 * 1024   # 1MB，够快又不至于瞬时完成

print("=== 1) A、B 进房 ===", flush=True)
a_tab, A = boot(TA, "A")
b_tab, B = boot(T("b"), "B")
print("  A、B 已进房", flush=True)

# ⚠️ 必须等常驻节点**订阅上这个房间**，否则它收不到 gossip 消息，
#    文件证明不会进历史，后进房的人自然看不到（实测栽过两次）。
#
#    它的订阅是"有人来拉历史时"异步发起的，所以刚进房就发消息很可能赶不上。
#    可靠判据：发一条**探针消息**，然后轮询历史直到能看到它 ——
#    看到就说明"消息能进历史"这条链路完全通了。
print("  探针：验证消息能落进常驻节点…", flush=True)
A.ev("window.__sendText('__probe__')", timeout=30)
persisted = False
for i in range(30):
    time.sleep(2)
    got = A.ev(
        f"window.__net.history({json.dumps(ROOM)}, 10, '')"
        f".then(m => JSON.stringify(m.some(x => x.text === '__probe__')))"
        f".catch(() => 'false')",
        timeout=30,
    )
    if i % 3 == 0:
        print(f"    [{i*2:4.1f}s] 历史里能看到探针吗: {got}", flush=True)
    if got == "true":
        persisted = True
        break
tt.check("消息能落进常驻节点（gossip 链路通）", persisted,
         "30 次轮询后历史里仍看不到探针")
if not persisted:
    print("  ⚠️ 链路不通，后续断言会连环失败 —— 继续跑完看整体", flush=True)

# ⚠️ 必须在发文件**之前**清：__clearBitmaps() 里 `transfers.clear()` 会把卡片也删掉，
#    放到后面调就会把刚收到的邀约一并清没（我第一版就这么错，导致 6 项连环失败）。
B.ev("window.__useOpfs=true; window.__setTestMode(true)")
B.ev("window.__clearBitmaps()", timeout=30)
A.ev(f"(() => {{ const u=new Uint8Array({SIZE}); window.__testFile=new File([u],'h.bin',{{type:'application/octet-stream'}}); return 1; }})()", timeout=60)
A.ev("window.__setStopAfterChunks(0)")
A.ev(f"window.__sendFile(window.__testFile, {json.dumps(ROOM)})")

fid = None
for _ in range(40):
    time.sleep(0.5)
    t = card(B, lambda x: x["direction"] == "recv" and x["state"] == "invited")
    if t:
        fid = t["file_id"]; break
tt.check("B 收到实时邀约", bool(fid), str(fid))

B.fire(f"window.__acceptFile({json.dumps(fid)})")
for _ in range(60):
    time.sleep(1)
    t = card(B, lambda x: x["file_id"] == fid)
    if t and t["state"] == "done":
        break
tb = card(B, lambda x: x["file_id"] == fid)
tt.check("B 完整收完（回归）", tb and tb["state"] == "done", f"state={tb and tb['state']}")

print("\n=== 2) C 后进房，应当看到文件卡片 ===", flush=True)
c_tab, C = boot(T("c"), "C")
seen = None
for _ in range(40):
    time.sleep(1)
    seen = card(C, lambda x: x["file_id"] == fid)
    # 等 avail 从 unknown 收敛出结论
    if seen and seen.get("avail") in ("live", "expired"):
        break
print(f"  C 看到的卡片: state={seen and seen.get('state')} avail={seen and seen.get('avail')} "
      f"name={seen and seen.get('name')}", flush=True)
tt.check("C 能看到这个文件（历史里的证明）", bool(seen), "没看到")
tt.check("C 看到的是历史卡片（不是实时邀约）",
         bool(seen and seen.get("fromProof")), str(seen and seen.get("fromProof")))
tt.check("C 的卡片显示为「可接收」", bool(seen and seen.get("avail") == "live"),
         f"avail={seen and seen.get('avail')}")

print("\n=== 2.5) D 进房：只旁观、不接收（用来验证发送方离开后过期）===", flush=True)
# ⚠️ 不能用 B 来验证过期：B 已经把文件**收完了**，文件就在他磁盘上，
#    发送方离开不该影响"我已经收到的文件"。所以需要一个"只看没收"的旁观者。
# ⚠️⚠️ D 必须在 C 点接收**之前**进房：C 点历史卡片会让发送方重发邀约，
#    而那是**广播** —— 如果 D 在那之后才进房，就测不到"旁人的点击不该
#    劫持我的卡片"这个 bug（实测会看到 D 的卡片莫名变成 invited，
#    于是 avail 永远为 null、发送方刷新后也永远不显示过期）。
d_tab, D = boot(T("d"), "D")
seen_d = None
for _ in range(40):
    time.sleep(1)
    seen_d = card(D, lambda x: x["file_id"] == fid)
    if seen_d and seen_d.get("avail") in ("live", "expired"):
        break
print(f"  D: state={seen_d and seen_d.get('state')} avail={seen_d and seen_d.get('avail')}",
      flush=True)
tt.check("D 看到历史卡片且为「可接收」", bool(seen_d and seen_d.get("avail") == "live"),
         f"avail={seen_d and seen_d.get('avail')}")

print("\n=== 3) C 点「接收」→ 应拿到邀约并收完 ===", flush=True)
C.ev("window.__useOpfs=true; window.__setTestMode(true)")
# ⚠️ 这里**不能**调 __clearBitmaps()：它会 `transfers.clear()`，
#    把刚看到的文件卡片一起清掉，后面的断言就全断了。
#    位图清不清对这次验证没影响（只影响"是否从断点续传"）。
C.fire(f"window.__openArchived({json.dumps(fid)})")
got_invite = False
for _ in range(30):
    time.sleep(1)
    t = card(C, lambda x: x["file_id"] == fid)
    if t and t["state"] == "invited":
        got_invite = True
        C.fire(f"window.__acceptFile({json.dumps(fid)})")
        break
tt.check("点了之后收到发送方重发的邀约", got_invite, "5 秒内没收到")

# ⚠️ 关键回归：C 的点击会让发送方**广播**一次重发邀约，D 也会收到。
#    D 从没点过，它的历史卡片必须仍然是 archived（继续追踪可用性）——
#    一旦被改成 invited，_refreshArchived 就不再管它，发送方刷新后
#    这张卡片永远不会显示"已过期"（这是实测踩到过的真实缺陷）。
time.sleep(3)
d_after = card(D, lambda x: x["file_id"] == fid)
print(f"  C 点击后 D: state={d_after and d_after.get('state')} "
      f"avail={d_after and d_after.get('avail')}", flush=True)
tt.check("C 点接收不会把旁观者 D 的历史卡片劫持成待确认（防广播串扰）",
         bool(d_after and d_after.get("state") == "archived"),
         f"D.state={d_after and d_after.get('state')}")
tt.check("D 的卡片仍在追踪可用性（avail 有值）",
         bool(d_after and d_after.get("avail") in ("live", "expired")),
         f"D.avail={d_after and d_after.get('avail')}")

if got_invite:
    for _ in range(60):
        time.sleep(1)
        t = card(C, lambda x: x["file_id"] == fid)
        if t and t["state"] == "done":
            break
    tc = card(C, lambda x: x["file_id"] == fid)
    tt.check("C 完整收完", tc and tc["state"] == "done", f"state={tc and tc['state']}")

print("\n=== 4) A 主动切到别的房间（可靠的离开广播）===", flush=True)
t0 = time.time()
A.fire(f"window.__openRoom({json.dumps(ROOM2)})")
detected = None
for i in range(20):
    time.sleep(1)
    d = card(D, lambda x: x["file_id"] == fid)
    if i % 3 == 0 or (d and d.get("avail") == "expired"):
        print(f"  [{time.time()-t0:4.1f}s] D.avail={d and d.get('avail')}", flush=True)
    if d and d.get("avail") == "expired":
        detected = time.time() - t0
        break
tt.check("A 离开后 D 的卡片变「已过期」", detected is not None,
         f"{detected:.1f}s" if detected else "20 秒内没变")
tt.check("离开广播是「即时」的（≤ 5s，不是等 25~45s 心跳超时）",
         detected is not None and detected <= 5,
         f"{detected:.1f}s" if detected else "n/a")
# 已经收完的人不该受影响
tb_done = card(B, lambda x: x["file_id"] == fid)
tt.check("已收完的 B 不受影响（仍是「已完成」）",
         bool(tb_done and tb_done["state"] == "done"),
         f"B.state={tb_done and tb_done['state']}")

print("\n=== 5) A 切回来 → 卡片应自动恢复 ===", flush=True)
A.fire(f"window.__openRoom({json.dumps(ROOM)})")
time.sleep(1)
tt.wait_until(A, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
              60, label="A 回到房间")
restored = None
t0 = time.time()
for i in range(25):
    time.sleep(1)
    d = card(D, lambda x: x["file_id"] == fid)
    if i % 4 == 0:
        print(f"  [{time.time()-t0:4.1f}s] D.avail={d and d.get('avail')}", flush=True)
    if d and d.get("avail") == "live":
        restored = time.time() - t0
        break
tt.check("A 回来后卡片自动恢复「可接收」（过期是可逆的）",
         restored is not None, f"{restored:.1f}s" if restored else "25 秒内没恢复")

print("\n=== 6) A 刷新页面（文件随之失效）===", flush=True)
A.call("Page.navigate", {"url": TA + "&r=1"})
time.sleep(2)
tt.wait_until(A, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
              120, label="A 刷新后")
gone = None
t0 = time.time()
for i in range(20):
    time.sleep(1)
    d = card(D, lambda x: x["file_id"] == fid)
    if i % 3 == 0:
        print(f"  [{time.time()-t0:4.1f}s] D.avail={d and d.get('avail')}", flush=True)
    if d and d.get("avail") == "expired":
        gone = time.time() - t0
        break
tt.check("A 刷新后卡片变「已过期」", gone is not None,
         f"{gone:.1f}s" if gone else "20 秒内没变")
sa = json.loads(A.ev("JSON.stringify(window.__transfers())"))
mine_after = [x for x in sa if x.get("fromProof")]
tt.check("发送方刷新后不再看到自己的历史文件卡片（避免点不动）",
         len(mine_after) == 0, f"{len(mine_after)} 张")

for t in (a_tab, b_tab, c_tab, d_tab):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
