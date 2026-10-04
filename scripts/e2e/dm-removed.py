"""验证「私聊 + 联系人簿」已干净移除，且其余交互改进仍在。

检查：
  1. 成员页是只读「在线成员」，没有联系人/私聊痕迹
  2. 设置页仍然是真实控件（资料卡 + 开关 + 可点行），且不含"联系人"
  3. 会话列表里没有「私聊」标签
  4. 无 console 错误
"""
import importlib.util, time, json, sys

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = f"rm{int(time.time()) % 100000}"; V = int(time.time())
URL = f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&testid=1&v={V}"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(URL)
p = tt.Page(tab["id"]); p.call("Runtime.enable")
tap = tt.LogTap(tab["id"])
tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})", 120, label="A")
print(f"已进房 {ROOM}", flush=True)

# ---- 1. 成员页 ----
p.ev("document.getElementById('tab-people').click()")
time.sleep(1)
body = p.ev("document.getElementById('panel-body').innerText") or ""
print("--- 成员页文本 ---\n" + body[:300], flush=True)
html = p.ev("document.getElementById('panel-body').innerHTML") or ""
tt.check("成员页标题是「在线成员」", "在线成员" in body, body[:40])
tt.check("成员页不含「联系人」", "联系人" not in body, "")
tt.check("成员页不含「私聊」", "私聊" not in body, "")
tt.check("成员页没有加好友按钮 (data-add)", 'data-add' not in html, "")
tt.check("成员页没有私聊按钮 (data-dm)", 'data-dm' not in html, "")
tt.check("成员页没有联系人行 (row--contact)", 'row--contact' not in html, "")

# ---- 2. 设置页 ----
p.ev("document.getElementById('tab-settings').click()")
time.sleep(1)
sbody = p.ev("document.getElementById('panel-body').innerText") or ""
shtml = p.ev("document.getElementById('panel-body').innerHTML") or ""
print("--- 设置页文本（前 300）---\n" + sbody[:300], flush=True)
tt.check("设置页仍渲染资料卡", "set-card" in shtml, "")
tt.check("设置页仍有开关控件", "switch" in shtml, "")
tt.check("设置页仍有可点行", "set-row--nav" in shtml or "data-act" in shtml, "")
tt.check("设置页不含「联系人」", "联系人" not in sbody, "")
tt.check("设置页显示本地配置占用（usage 还在）", "本地配置占用" in sbody, "")

# ---- 3. 会话列表 ----
p.ev("document.getElementById('tab-chats').click()")
time.sleep(1)
cbody = p.ev("document.getElementById('panel-body').innerText") or ""
c1 = p.ev("document.querySelectorAll('#panel-body .tag-dm').length")
tt.check("会话列表没有 tag-dm 标签", c1 == 0, f"{c1} 个")
tt.check("会话列表不含「私聊」字样", "私聊" not in cbody, "")

# ---- 4. console ----
time.sleep(1)
tap.pump()
bad = [x for x in tap.lines if ("[exception]" in x or "[error]" in x) and "do_holepunching" not in x]
if bad:
    print("--- console ---", flush=True)
    for x in bad[:10]:
        print("   ", x[:190], flush=True)
tt.check("无 console 错误", not bad, f"{len(bad)} 条")

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
