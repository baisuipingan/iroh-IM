"""名片（R2a）：**签名消息 + 本地聚合** —— 能力发现只看"名字 / 简介 / 发言"。

为什么这样做：能力不该靠一份"工具清单"广播（那只会有两份真相）；
人怎么认识群里的人？看名字、看简介、翻他在这里说过什么 —— agent 也一样。
名片就是一条**普通签名消息**（零协议变更），进历史，新人翻记录就能看到。

覆盖（V6.2：名片 = **状态帧**，广播即达、不进聊天历史）：
  A. 真实路径改名片（设置页 → 我的名片 → 保存）→ **不再**塞进聊天历史；B 侧实时看得到
  B. 它**不是**聊天消息：时间线上没有名片提示行、也没有气泡
  C. 对方（gossip → 状态帧）与**新进房的人**（只能来自常驻节点快照）都能看到  ← 验收标准
  D. 花名册：简介 + 标签可见；"最近说过"能展开他在这房间说过的话
  E. 快照权威：历史里**根本没有**名片（帧不进历史），新人在海量消息之后仍然看得到。
"""
import importlib.util, sys, time, json, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"prof{V % 100000}"
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")
BIO = "能查代码 · 会跑脚本"
TAGS = "ts rust"
SENTENCE = "我先说一句，好让他翻得到"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)


def boot(key, label):
    tab = tt.open_tab(f"{SITE}/?autostart=1&room={ROOM}&key={key}&v={V}{label}")
    p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
    p.ev("window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message)))")
    tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label=label)
    return tab, p


def history(p, limit=50):
    """读房间历史。⚠️ 要定位"老消息"时得放大 limit —— 用 50 条那页是**找不到**它的。"""
    return json.loads(
        p.ev(f"(async () => JSON.stringify(await window.__iroh_net.history('{ROOM}', {limit})))()")
    )


def send(p, text):
    p.ev("(() => { const el = document.getElementById('input'); el.value = %s; "
         "el.setSelectionRange(el.value.length, el.value.length); "
         "el.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()" % json.dumps(text))
    p.ev("document.getElementById('send').click()")
    time.sleep(2.2)


def lines(p):
    return json.loads(p.ev("JSON.stringify([...document.querySelectorAll('.tl-profile')].map(e => e.textContent))"))


def roster_text(p):
    p.ev("document.getElementById('room-members').click()")
    time.sleep(0.7)
    return p.ev("JSON.stringify([...document.querySelectorAll('.roster__row')].map(r => r.textContent))")


tab_a, a = boot('a' * 64, 'a')
tab_b, b = boot('b' * 64, 'b')
tt.wait_until(a, "window.__state().peers.length > 0", 90, label="A sees B")

# ── A. 真实路径改名片 ────────────────────────────────────────────────
a.ev("window.__iroh_openSettings()")
time.sleep(0.9)
tt.check("设置页有「我的名片」入口",
         a.ev("!!document.querySelector('.set-row[data-act=\"profile\"]')") is True)
a.ev("document.querySelector('.set-row[data-act=\"profile\"]').click()")
time.sleep(0.5)
a.ev("(() => { document.getElementById('dlg-bio').value = %s; document.getElementById('dlg-tags').value = %s; return 1; })()"
     % (json.dumps(BIO), json.dumps(TAGS)))
a.ev("document.getElementById('dlg-ok').click()")
time.sleep(2.5)

msgs = [m for m in history(a, 200) if str(m.get("text", "")).startswith('{"t":"profile"')]
tt.check("名片**不再**塞进聊天历史（V6.2 状态帧：广播即达、不进历史）",
         len(msgs) == 0, json.dumps(msgs, ensure_ascii=False)[:220])

# ── B. 它不是聊天消息：时间线上既没有提示行、也没有气泡 ──────────────
bubbles = a.ev("JSON.stringify([...document.querySelectorAll('.bubble')].map(e => e.textContent))")
tt.check("原始 JSON **没有**被画成聊天气泡", '"t":"profile"' not in bubbles, bubbles[:140])
tt.check("时间线上没有'名片提示'行（帧不是聊天消息）", lines(a) == [], json.dumps(lines(a), ensure_ascii=False))

# ── C1. 对方从 gossip 收到状态帧（实时） ─────────────────────────────
ok = False
rows_b = ""
for _ in range(30):
    time.sleep(0.8)
    rows_b = roster_text(b)
    if BIO in rows_b:
        ok = True
        break
tt.check("B 侧实时看到 A 的新名片（V6.2 状态帧）", ok, rows_b[:220])

# ── D. 花名册：简介 / 标签 / 最近说过 ────────────────────────────────
send(a, SENTENCE)
time.sleep(1.5)
rows = roster_text(b)
tt.check("花名册里能看到 A 的简介", BIO in rows, rows[:220])
tt.check("花名册里能看到标签", ('ts' in rows and 'rust' in rows), rows[:220])
# 展开"最近说过"（A 那行）—— 花名册行里唯一带 @他/最近说过 按钮的那个
b.ev("""(() => {
  const row = [...document.querySelectorAll('.roster__row')].find(r => r.textContent.includes(%s));
  row?.querySelector('button[data-act="recent"]')?.click();
  return 1;
})()""" % json.dumps(SENTENCE if False else BIO))
time.sleep(0.8)
recent = b.ev("JSON.stringify([...document.querySelectorAll('.roster__recent')].map(e => e.textContent))")
tt.check("能展开看他在这个房间说过什么", SENTENCE in recent, recent[:220])

# ── F. A4：成员状态（在线 / 忙碌 / 离线）在花名册可见 ────────────────
rows = json.loads(roster_text(b))
row_a = next((r for r in rows if BIO in r), "")
tt.check("花名册把在场成员标成「在线」", "在线" in row_a, row_a[:200])

# B 把名片标签加上「忙碌」→ A 的花名册里 B 那行显示"忙碌"（标签约定，零协议变更）
b.ev("window.__iroh_openSettings()")
time.sleep(0.9)
b.ev("document.querySelector('.set-row[data-act=\"profile\"]').click()")
time.sleep(0.5)
b.ev("(() => { document.getElementById('dlg-bio').value = %s; document.getElementById('dlg-tags').value = %s; return 1; })()"
     % (json.dumps("在跑任务，回复会慢"), json.dumps("忙碌 ts")))
b.ev("document.getElementById('dlg-ok').click()")
time.sleep(2.5)
row_b = ""
for _ in range(20):
    rows = json.loads(roster_text(a))
    row_b = next((r for r in rows if "在跑任务，回复会慢" in r), "")
    if "忙碌" in row_b:
        break
    time.sleep(1)
tt.check("名片的「忙碌」标签 → 花名册显示忙碌状态", "忙碌" in row_b, row_b[:200])

# 离线：E 说一句后离开（广播 leaveRoom）→ A 的花名册出现"离线"分组 + 一键 @
tab_e, e = boot('e' * 64, 'e')
E_SAY = "我说一句就走"
send(e, E_SAY)
e_msg = None
for _ in range(20):
    time.sleep(1)
    e_msg = next((m for m in history(a) if m.get("text") == E_SAY), None)
    if e_msg:
        break
tt.check("前提：离线前的话题已经到达 A 的时间线", e_msg is not None)
E_ID8 = str((e_msg or {}).get("from", ""))[:8].lower()
e.ev("(async () => { await window.__iroh_net.client.call('leaveRoom'); return 1; })()", timeout=30)

offline_row = ""
rows = []
for _ in range(60):
    time.sleep(1)
    rows = json.loads(roster_text(a))
    offline_row = next((r for r in rows if "离线" in r and E_ID8 in r), "")
    if offline_row:
        break
tt.check("离线成员出现在花名册（状态=离线）", bool(offline_row),
         json.dumps(rows, ensure_ascii=False)[:220])
tt.check("在线分组里没有把他算进去", not any("在线" in r and E_ID8 in r for r in rows))

# 一键 @ 离线成员：插入带 #id8 的草稿（发送前会被归一成规范 token）
a.ev("(() => { const row = [...document.querySelectorAll('.roster__row')].find(r => r.dataset.offline && r.textContent.includes(%s)); "
     "row?.querySelector('button[data-act=\"mention-offline\"]')?.click(); return 1; })()" % json.dumps(E_ID8))
time.sleep(0.5)
draft = a.ev("document.getElementById('input').value")
tt.check("离线成员可以一键 @（草稿带 #id8，发送时归一成 token）", E_ID8 in draft and "#" in draft, draft)
a.ev("document.getElementById('input').value = ''")

# ── C2. 新进房的人也能看到（这一条才是验收标准）─────────────────────
tab_c, c = boot('c' * 64, 'c')
seen = False
rows_c = ""
for _ in range(30):
    time.sleep(1)
    rows_c = roster_text(c)
    if BIO in rows_c:
        seen = True
        break
tt.check("**新进房的人立刻看得到 A 的名片**（历史里没有名片消息 —— 只能来自常驻节点快照）",
         seen, rows_c[:220])

# ── E. 快照权威（V6.2）：海量消息之后的新人，仍然看得到（唯一来源=快照）──
# 前提变了：名片**根本不在历史里**（状态帧）——所以"新人看得到"只能来自快照。
all_msgs = history(c, 500)
tt.check("前提：历史里没有任何名片消息（帧不进历史）",
         not any(str(m.get("text", "")).startswith('{"t":"profile"') for m in all_msgs),
         json.dumps([str(m.get("text", ""))[:24] for m in all_msgs])[:220])

fillers = 55
# ⚠️ 数字要**内联**在表达式里：`Page.ev` 不传参数，写成 `(async (n) => …)` 会让 n 是
#    undefined、循环一次都不跑（踩过 —— 而且它会**静默**不报错）。
c.ev(
    f"(async () => {{ for (let i = 1; i <= {fillers}; i++) await window.__iroh_net.send('补历史 ' + i); "
    f"return {fillers}; }})()",
    timeout=180,
)

# 等最后一条真的落进 roomd（异步追加），再让新人进房 —— 别睡固定秒数。
landed = False
for _ in range(40):
    time.sleep(1)
    if any(m.get("text") == f"补历史 {fillers}" for m in history(c, 200)):
        landed = True
        break
tt.check("前提：补历史已经落到常驻节点", landed)

tab_d, d = boot('d' * 64, 'd')
seen_d = False
rows_d = ""
for _ in range(30):
    time.sleep(1)
    rows_d = roster_text(d)
    if BIO in rows_d:
        seen_d = True
        break
tt.check("★ 快照权威：新人（视野里只有后 55 条）仍然看得到 A 的名片", seen_d, rows_d[:220])
tt.check("前提：新人的时间线里没有名片提示行", lines(d) == [], json.dumps(lines(d), ensure_ascii=False))

tt.check("三个页面都没有未处理异常",
         a.ev("window.__errs.length") == 0 and d.ev("window.__errs.length") == 0,
         f"A={a.ev('JSON.stringify(window.__errs)')} D={d.ev('JSON.stringify(window.__errs)')}")

for t in (tab_a, tab_b, tab_c, tab_d):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
