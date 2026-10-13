"""昵称兜底：空昵称的消息/成员不能再显示成"空白名字 + `?` 头像"。

背景（线上实测）：一条 `nickname=""` 的消息（外部/老客户端以空昵称进房，
昵称是**发送方签进消息里**的）渲染出来是空白名字行 + 棕色 `?` 头像，
根本认不出是谁 —— 截图里就是一个 `?` 配一条 "🙂"。

寻址永远用 EndpointId、昵称只给人看（见 `mention.js` 顶注），所以这里
只兜**显示名**：空昵称 → `用户+id8`（和浏览器端进房自动昵称 `用户4810` 同风格）。
不动协议、不动签名。

覆盖：
  A. 收到的消息 nickname="" → 名字行 `用户+id8`、头像不再是 `?`
  B. 花名册（room-members）里空昵称成员 → `用户+id8`
  C. 连接状态页成员行 → `用户+id8`
  D. 桌面通知正文 → `用户+id8`
  E. 回归面：有昵称的消息/成员照旧显示昵称（没有被兜底改掉）

注入走 `window.__iroh_net._dispatch`：和 Worker 推事件是同一条路径
（`net._dispatch` → `EV.MSG`/`EV.PRESENCE`），不是测试专用旁路。
"""
import importlib.util, sys, time, json, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"nick{V % 100000}"
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")
EMPTY_ID = "c0980ecf" + "0" * 56          # 昵称为空的成员（真实故障身份的前缀）
EMPTY_ID8 = EMPTY_ID[:8]
NAMED_ID = "a5d3997a" + "0" * 56
FALLBACK = f"用户{EMPTY_ID8}"

# 共享 CDP 里别的标签页会互相干扰（presence/存储），先清场
for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(f"{SITE}/?autostart=1&room={ROOM}&key={'a' * 64}&v={V}")
p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label="joined")
# ⚠️ 错误钩子必须在**进房之后**装：open_tab 返回时页面可能还在导航，
#    导航会冲掉刚挂到旧文档上的 `window.__errs`（线上跑实测踩到 → 末条检查报 undefined）。
p.ev("window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message)))")

dispatch = (
    "(() => { window.__iroh_net._dispatch(%s); return 1; })()"
)


def inject_message(mid, sender, nickname, text):
    p.ev(dispatch % json.dumps(
        {"type": "message", "room": ROOM, "mine": False,
         "message": {"id": mid, "from": sender, "nickname": nickname,
                     "text": text, "ts": int(time.time() * 1000)}}))
    time.sleep(0.5)


def metas():
    return json.loads(p.ev(
        "JSON.stringify([...document.querySelectorAll('.msg:not(.msg--me) .msg__meta')]"
        ".map(e => e.textContent))"))


def avatars():
    return json.loads(p.ev(
        "JSON.stringify([...document.querySelectorAll('.msg:not(.msg--me) .avatar')]"
        ".map(e => e.textContent))"))


# ── A. 空昵称消息 ──────────────────────────────────────────────────────
inject_message("nk-empty", EMPTY_ID, "", "🙂")
names = metas()
avs = avatars()
tt.check("空昵称消息：名字行显示 用户+id8（不再是空白）",
         bool(names) and names[-1].startswith(FALLBACK), json.dumps(names[-1] if names else None, ensure_ascii=False))
tt.check("空昵称消息：头像不再是 `?`",
         bool(avs) and avs[-1] not in ("?", ""), json.dumps(avs[-1] if avs else None, ensure_ascii=False))

# ── E. 有昵称的消息照旧 ────────────────────────────────────────────────
inject_message("nk-named", NAMED_ID, "派大星", "我名字好好的")
names = metas()
avs = avatars()
tt.check("回归：有昵称的消息照旧显示昵称", names[-1].startswith("派大星"), json.dumps(names[-1], ensure_ascii=False))
tt.check("回归：有昵称的消息头像照旧是首字", avs[-1] == "派", json.dumps(avs[-1], ensure_ascii=False))

# ── B. 花名册 ──────────────────────────────────────────────────────────
def inject_presence():
    p.ev(dispatch % json.dumps(
        {"type": "presence", "room": ROOM,
         "peers": [{"id": EMPTY_ID, "nickname": "", "lastSeenMs": int(time.time() * 1000)},
                   {"id": NAMED_ID, "nickname": "派大星", "lastSeenMs": int(time.time() * 1000)}]}))


inject_presence()
time.sleep(0.3)
p.ev("document.getElementById('room-members').click()")
time.sleep(0.7)
rows = p.ev("JSON.stringify([...document.querySelectorAll('.roster__row')].map(r => r.textContent))")
tt.check("花名册：空昵称成员显示 用户+id8", FALLBACK in rows, rows[:220])
tt.check("花名册：有昵称成员照旧（回归）", "派大星" in rows, "")
p.ev("document.getElementById('dlg-cancel')?.click()")
time.sleep(0.3)

# ── C. 连接状态页 ──────────────────────────────────────────────────────
inject_presence()          # 心跳 3 秒一次，重进前再补一针，防真实 presence 覆盖
time.sleep(0.2)
p.ev("document.getElementById('tab-status').click()")
time.sleep(0.6)
member_names = p.ev("JSON.stringify([...document.querySelectorAll('.member__name')].map(e => e.textContent))")
tt.check("连接状态页：空昵称成员显示 用户+id8", FALLBACK in member_names, member_names[:220])
p.ev("document.getElementById('tab-chats')?.click()")
time.sleep(0.2)

# ── D. 桌面通知正文 ────────────────────────────────────────────────────
body = p.ev("JSON.stringify(window.__iroh_notifyBody(%s, {nickname: '', from: %s, text: 'hi'}, {}))"
            % (json.dumps(ROOM), json.dumps(EMPTY_ID)))
nb = json.loads(body)
tt.check("桌面通知正文：空昵称显示 用户+id8", FALLBACK in nb.get("body", ""), body)

tt.check("页面没有未处理异常",
         p.ev("typeof window.__errs === 'undefined' || window.__errs.length === 0"),
         p.ev("JSON.stringify(window.__errs ?? null)"))

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
