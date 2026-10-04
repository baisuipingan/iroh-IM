"""review 前端改动（第 2 版）：唯一房间 + 覆盖刚修的两个缺陷。

覆盖：
  1. 两个独立身份进房：phase=online、输入区可用、空房间有空态
  2. 真·双端收发文字
  3. IME 组字态按 Enter 不发送
  4. 离线发送失败 → 保留原文 + 红色失败气泡（且不混进正常消息）
  5. 重发：气泡撤掉、对端收到、**输入框被清空**（防重复发）
  6. 文字发成功但附件失败 → 输入框清空、不出现假失败气泡（本轮新修）
  7. 无 console 错误
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = f"rv{int(time.time()) % 100000}"   # ⚠️ 必须每轮唯一，否则旧历史会把空态挡掉
V = int(time.time())
URL = f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&testid=1&v={V}"

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


tabs = []
for name in ("A", "B"):
    tab, p = boot(URL + name, name)
    tabs.append((name, tab, p, tt.LogTap(tab["id"])))
print(f"两个标签已进房（房间 {ROOM}）", flush=True)
A, B = tabs[0][2], tabs[1][2]
st = lambda p: json.loads(p.ev("JSON.stringify(window.__state())"))


def inp(p):
    return p.ev("document.getElementById('input').value")


# ---- 1 ----
sa = st(A)
print(f"  phase={sa['phase']} canSend={sa['canSend']} composerEnabled={sa['composerEnabled']} "
      f"emptyState={sa['emptyState']}", flush=True)
tt.check("进房后 phase=online", sa["phase"] == "online", sa["phase"])
tt.check("进房后输入区可用", sa["composerEnabled"] is True, str(sa["composerEnabled"]))
tt.check("全新房间显示空态", sa["emptyState"] is True, str(sa["emptyState"]))

# ---- 2 ----
A.ev("window.__sendText('你好-A')", timeout=20)
time.sleep(3)
tt.check("B 收到 A 的消息", "你好-A" in st(B)["messages"], str(st(B)["messages"]))
tt.check("有消息后空态消失", st(B)["emptyState"] is False)
B.ev("window.__sendText('收到-B')", timeout=20)
time.sleep(3)
tt.check("A 收到 B 的回复", "收到-B" in st(A)["messages"], str(st(A)["messages"]))

# ---- 3 IME ----
A.ev("document.getElementById('input').value = 'nihao'")
A.ev("""(() => {
  const el = document.getElementById('input');
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true,
    bubbles: true, cancelable: true }));
  return 1;
})()""")
time.sleep(2)
sa = st(A)
tt.check("IME 组字时 Enter 不发送", "nihao" not in sa["mine"], str(sa["mine"][-2:]))
tt.check("IME 组字后输入框保留", inp(A) == "nihao", repr(inp(A)))

# ---- 4 离线发送失败 ----
A.ev("window.__net.phase = 'offline'")
time.sleep(0.3)
A.ev("window.__sendText('会失败的消息')", timeout=20)
time.sleep(2)
fa = st(A)
tt.check("失败时出现红色失败气泡", any("会失败的消息" in x for x in fa["failed"]), str(fa["failed"]))
tt.check("失败时输入框保留原文", inp(A) == "会失败的消息", repr(inp(A)))
tt.check("失败气泡不混进正常消息", "会失败的消息" not in fa["mine"], str(fa["mine"]))

# ---- 5 重发 ----
A.ev("window.__net.phase = 'online'")
time.sleep(0.3)
A.ev("document.querySelector('.msg--failed .msg__retry .link-btn')?.click()", timeout=20)
time.sleep(3)
fa2, mb2 = st(A), st(B)
tt.check("重发后失败气泡被撤掉", len(fa2["failed"]) == 0, str(fa2["failed"]))
tt.check("重发的消息到达对端", "会失败的消息" in mb2["messages"], str(mb2["messages"]))
tt.check("重发成功后输入框被清空（防重复发）", inp(A) == "", repr(inp(A)))

# ---- 6 文字成功 + 附件失败（本轮修的缺陷）----
A.ev("""(() => {
  window.__addFiles([new File(['x'], 'attach.txt', {type: 'text/plain'})]);
  return 1;
})()""")
time.sleep(0.5)
# 让附件一定失败：换掉 pickAndSend（与 main.js 用的是同一个模块实例）
A.ev("""import('./js/ui/filetransfer.js').then(m => {
  m.fileTransfer.pickAndSend = async () => { throw new Error('模拟附件失败'); };
  return 1;
})""", timeout=20)
time.sleep(1)
A.ev("document.getElementById('input').value = '带附件的文字'")
A.ev("""(() => {
  const b = document.getElementById('send');
  b.disabled = false;
  b.click();
  return 1;
})()""", timeout=20)
time.sleep(3)
sa = st(A)
mbA = st(B)["messages"]
print(f"  mine={sa['mine']} failed={sa['failed']} input={inp(A)!r}", flush=True)
tt.check("文字已发成功（对端收到）", "带附件的文字" in mbA, str(mbA))
tt.check("附件失败不产生假失败气泡", not any("带附件的文字" in x for x in sa["failed"]),
         str(sa["failed"]))
tt.check("附件失败时输入框已清空（文字确实发出去了）", inp(A) == "", repr(inp(A)))

# ---- 7 console ----
time.sleep(1)
bad_all = {}
for name, tab, p, tap in tabs:
    tap.pump()
    bad = [x for x in tap.lines if ("[exception]" in x or "[error]" in x)
           and "do_holepunching" not in x]
    bad_all[name] = bad
    if bad:
        print(f"\n--- {name} console ---", flush=True)
        for x in bad[:10]:
            print("   ", x[:190], flush=True)
tt.check("A 无 console 错误", not bad_all["A"], f"{len(bad_all['A'])} 条")
tt.check("B 无 console 错误", not bad_all["B"], f"{len(bad_all['B'])} 条")

for _, tab, _, _ in tabs:
    tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
