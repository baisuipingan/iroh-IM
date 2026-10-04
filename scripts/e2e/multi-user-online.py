"""线上多用户模拟：在 im.pinkstar.cc 上开 4 个独立身份的浏览器标签，
验证消息归属、互相可见、历史持久化（SQLite 后端）、刷新恢复。

用真实线上站点 + 真实中继 + 真实 roomd（新 SQLite 版）。
"""
import importlib.util, sys, time, json, base64, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

# 线上多用户模拟：真站点 + 真中继 + 真 roomd。
#
# ⚠️ 为什么每个用户都要**固定 key**：
#    不带 `?key=<64 位 hex>` 的话，每次开页/刷新都会生成新身份 ——
#    刷新后那条"自己发的"消息就成了"别人发的"（靠左），
#    测试会把它误判成 bug。踩过一次。
SITE = os.environ.get("E2E_SITE", "https://im.pinkstar.cc")
V = int(time.time())
ROOM = f"mu{V % 100000}"
print(f"房间: {ROOM}  站点: {SITE}", flush=True)

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)

KEYS = {}  # 每个用户一个固定身份 key（64 位 hex），刷新后必须还是同一个人

def boot(tag, room=ROOM):
    # ⚠️ **必须带固定 key**：不带的话每次开页/刷新都会生成新身份，
    #    刷新后那条自己发的消息就成了"别人发的"（测试会误判成 bug）。
    base = tag.rstrip("0123456789") or tag   # boot 时 tag 带了时间戳后缀，取姓名部分做键
    key = KEYS.setdefault(base, (base.encode().hex() * 32)[:64])
    url = f"{SITE}/?autostart=1&room={room}&key={key}&v={V}{tag}"
    tab = tt.open_tab(url)
    p = tt.Page(tab["id"]); p.call("Runtime.enable")
    tt.wait_until(p, f"!!(window.__state && window.__state().joined === {json.dumps(room)})",
                  150, label=tag)
    return tab, p

# ── 1) 三个用户依次进房 ────────────────────────────────────────
print("\n=== 1) 三个用户进房 ===", flush=True)
tabs = {}
for name in ("小明", "小红", "小刚"):
    tk = f"{name}{V%1000}"
    tab, p = boot(tk)
    tabs[name] = (tab, p)
    st = json.loads(p.ev("JSON.stringify(window.__state())"))
    print(f"  ✅ {name} 已进房 myId={st['myId'][:8]}", flush=True)
    time.sleep(1)

# 等待互相看见（心跳 10s）
print("\n=== 2) 等待互相可见 ===", flush=True)
for i in range(10):
    time.sleep(3)
    seen = {n: p.ev("(window.__state().peers||'')") for n, (_, p) in tabs.items()}
    if all(seen.values()): break
for n, v in seen.items():
    print(f"  {n} 看到: {v!r}", flush=True)
tt.check("三方互相可见", all(len(v) > 5 for v in seen.values()), f"{seen}")

# ── 3) 各自发消息，验证归属（自己靠右、别人靠左）────────────────
print("\n=== 3) 各自发消息 + 验证归属 ===", flush=True)
texts = {"小明": "我是小明", "小红": "我是小红", "小刚": "我是小刚"}
for n, txt in texts.items():
    tabs[n][1].ev(f"window.__sendText({json.dumps(txt)})")
    time.sleep(1.5)

time.sleep(4)
for n, (_, p) in tabs.items():
    st = json.loads(p.ev("JSON.stringify(window.__state())"))
    mine = st["mine"]; others = st["messages"]
    want_mine = texts[n]
    others_texts = [t for k, t in texts.items() if k != n]
    ok_mine = want_mine in mine
    ok_others = all(o in others for o in others_texts)
    tt.check(f"{n}: 自己发的靠右显示", ok_mine, f"mine={mine}")
    tt.check(f"{n}: 别人的消息靠左显示", ok_others, f"others={others}")

# ── 4) 验证排序：消息按时间正序 ─────────────────────────────────
print("\n=== 4) 消息顺序 ===", flush=True)
p = tabs["小明"][1]
allmsgs = json.loads(p.ev("JSON.stringify([...document.querySelectorAll('.msg:not(.msg--failed)')].map(e=>{const b=e.querySelector('.bubble');return b?b.textContent:''}))"))
print(f"  小明的消息流: {allmsgs}", flush=True)
idx = [allmsgs.index(texts[n]) for n in ("小明", "小红", "小刚") if texts[n] in allmsgs]
tt.check("消息按发送顺序排列", idx == sorted(idx), f"顺序索引={idx}")

# ── 5) 第四个用户后进房，应能从历史看到前面 3 条 ─────────────────
print("\n=== 5) 第四个用户后进房（验证 SQLite 历史）===", flush=True)
tab4, p4 = boot("小美")
tabs["小美"] = (tab4, p4)
hist = None
for i in range(20):
    time.sleep(2)
    st = json.loads(p4.ev("JSON.stringify(window.__state())"))
    hist = st["messages"]
    if all(texts[n] in hist for n in texts):
        break
print(f"  小美看到的历史: {hist}", flush=True)
tt.check("后进房者能看到全部 3 条历史（SQLite 落库成功）",
         all(texts[n] in hist for n in texts), f"hist={hist}")

# ── 6) 小美发言，其他人都应收到 ────────────────────────────────
print("\n=== 6) 小美发言，其他人收到 ===", flush=True)
p4.ev(f"window.__sendText('我是小美')")
got = 0
for n, (_, pp) in tabs.items():
    if n == "小美": continue
    for i in range(12):
        time.sleep(1.5)
        if "我是小美" in (pp.ev("(window.__state().messages||[]).join('|')") or ""):
            got += 1; break
tt.check("3 个老用户都收到了小美的消息", got == 3, f"收到人数={got}/3")

# ── 7) 刷新其中一个，历史应仍在（SQLite 持久化）────────────────
print("\n=== 7) 小明刷新，历史应仍在 ===", flush=True)
tab_m, p_m = tabs["小明"]
key_m = KEYS["小明refresh"]  if False else KEYS["小明"]
url_m = f"{SITE}/?autostart=1&room={ROOM}&key={key_m}&v={V}refresh"
p_m.call("Page.navigate", {"url": url_m})
tt.wait_until(p_m, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})", 150, label="小明刷新")
after = None
for i in range(20):
    time.sleep(2)
    st = json.loads(p_m.ev("JSON.stringify(window.__state())"))
    after = st["messages"] + st["mine"]
    if all(texts[n] in after for n in texts) and "我是小美" in after:
        break
print(f"  刷新后（分方向看 mine/messages）: {after}", flush=True)
# 注意：不要用 mine + messages 拼出来的数组断言顺序。
# 那是两个 class 的分别取数，拼起来本来就不是全局时间序。
# 要验顺序就读 DOM 的全局序列。
dom_order = json.loads(p_m.ev("""JSON.stringify([...document.querySelectorAll('.msg:not(.msg--failed)')]
    .map(e=>{const b=e.querySelector('.bubble');return b?b.textContent:''}).filter(Boolean))"""))
print(f"  刷新后 DOM 全局顺序: {dom_order}", flush=True)
tt.check("刷新后历史完整（4 条消息都在）",
         all(texts[n] in after for n in texts) and "我是小美" in after, f"after={after}")
expect_order = ["我是小明", "我是小红", "我是小刚", "我是小美"]
tt.check("刷新后 DOM 全局顺序仍按时间正序",
         dom_order == expect_order, f"got={dom_order} want={expect_order}")
st_m = json.loads(p_m.ev("JSON.stringify(window.__state())"))
tt.check("刷新后自己的消息仍靠右", "我是小明" in st_m["mine"], f"mine={st_m['mine']}")

for tab, _ in tabs.values():
    try: tt.close_tab(tab["id"])
    except Exception: pass

print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
