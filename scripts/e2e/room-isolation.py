"""验证本轮新增：**文件清单按房间隔离**（syncAvailableFiles 只广播当前房间的文件）。

回归场景（改动前的行为）：
  A 在 R1 发了文件 F。A 切到 R2 后，`syncAvailableFiles()` 会把**全部** outFiles
  广播出去 —— 于是 A 在 R2 的心跳里仍然声称"我能提供 F"，
  R2 的人通过快照就能学到 R1 的 file_id（跨房间信息泄露）。

现在应当：A 在 R2 的心跳里 files 为空（F 只属于 R1）。
"""
import importlib.util, sys, time, json

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time()); R1 = f"iso1{V % 100000}"; R2 = f"iso2{V % 100000}"
def url(room, tag): return f"http://127.0.0.1:8099/?autostart=1&room={room}&testid=1&v={V}{tag}"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)

def boot(u, label, room):
    tab = tt.open_tab(u); p = tt.Page(tab["id"]); p.call("Runtime.enable")
    tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(room)})", 120, label=label)
    return tab, p

def snapshot(p, room):
    """拿常驻节点返回的原始快照（含每个成员的 files 清单）。"""
    raw = p.ev(f"window.__net.client.call('history', {json.dumps(room)}, 5, '')")
    return json.loads(raw)

a_tab, A = boot(url(R1, "a"), "A@R1", R1)
print(f"A 进了 R1={R1}", flush=True)

# A 发一个文件（证明会进 R1 历史）
A.ev("(() => { const u=new Uint8Array(4096); window.__testFile=new File([u],'iso.bin',{type:'application/octet-stream'}); return 1; })()")
A.ev("window.__setStopAfterChunks(0)")
A.ev(f"window.__sendFile(window.__testFile, {json.dumps(R1)})")
time.sleep(5)
t_all = json.loads(A.ev("JSON.stringify(window.__transfers())") or "[]")
fid = t_all[0]["file_id"] if t_all else ""
tt.check("A 在 R1 发出了文件", bool(fid), f"file_id={fid}")

# A 切到 R2
A.ev(f"(() => {{ window.__openRoom({json.dumps(R2)}); return 1; }})()")
tt.wait_until(A, f"!!(window.__state && window.__state().joined === {json.dumps(R2)})", 90, label="A@R2")
print(f"A 已切到 R2={R2}", flush=True)

# 等心跳（成员 10s / 文件清单 3s）把 R2 的状态广播出去
time.sleep(14)

snap = snapshot(A, R2)
members = (snap.get("snapshot") or {}).get("members") or []
mine = [m for m in members if m.get("id", "").startswith("")]
aid = A.ev("window.__state().myId")
me = [m for m in members if m.get("id") == aid]
print(f"  R2 快照里成员数={len(members)}，我自己的条目={'有' if me else '无'}", flush=True)
if me:
    print(f"  我在 R2 声称持有的文件: {me[0].get('files')}", flush=True)

files_in_r2 = (me[0].get("files") if me else []) or []
tt.check("切到 R2 后**不再**对外声称持有 R1 的文件（不泄露 file_id）",
         fid not in files_in_r2, f"files={files_in_r2}")

# 反向确认：R1 的历史里确实有那个文件的证明（说明文件本身没丢，只是不再跨房间广播）
r1 = snapshot(A, R1)
proofs = [m for m in (r1.get("messages") or []) if (m.get("file") or {}).get("file_id") == fid]
tt.check("R1 的历史里仍有该文件的证明（文件没丢，只是不再跨房间声明）",
         bool(proofs), f"找到 {len(proofs)} 条证明")

# 切回 R1 → 应当重新声称持有它
A.ev(f"(() => {{ window.__openRoom({json.dumps(R1)}); return 1; }})()")
tt.wait_until(A, f"!!(window.__state && window.__state().joined === {json.dumps(R1)})", 90, label="A@R1-again")
time.sleep(14)
snap2 = snapshot(A, R1)
me2 = [m for m in ((snap2.get("snapshot") or {}).get("members") or []) if m.get("id") == aid]
files_back = (me2[0].get("files") if me2 else []) or []
tt.check("切回 R1 后重新声称持有该文件（隔离是双向的）",
         fid in files_back, f"files={files_back}")

for t in (a_tab,):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
