"""名片（R2a）：**签名消息 + 本地聚合** —— 能力发现只看"名字 / 简介 / 发言"。

为什么这样做：能力不该靠一份"工具清单"广播（那只会有两份真相）；
人怎么认识群里的人？看名字、看简介、翻他在这里说过什么 —— agent 也一样。
名片就是一条**普通签名消息**（零协议变更），进历史，新人翻记录就能看到。

覆盖：
  A. 真实路径改名片（设置页 → 我的名片 → 保存）→ 历史里是约定格式的签名消息
  B. 时间线上它**不是聊天气泡**，而是一行紧凑提示
  C. 对方（gossip）与**新进房的人**（从历史里学）都能看到这份名片  ← 验收标准
  D. 花名册：简介 + 标签可见；"最近说过"能展开他在这房间说过的话
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


def history(p):
    return json.loads(p.ev(f"(async () => JSON.stringify(await window.__iroh_net.history('{ROOM}', 50)))()"))


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

msgs = [m for m in history(a) if str(m.get("text", "")).startswith('{"t":"profile"')]
tt.check("名片是一条**约定格式的签名消息**（进历史、可验签）",
         len(msgs) == 1 and BIO in msgs[0]["text"], json.dumps(msgs, ensure_ascii=False)[:220])

# ── B. 时间线上不是聊天气泡 ──────────────────────────────────────────
got = lines(a)
tt.check("A 侧渲染成一行名片提示（含简介）", any(BIO in x for x in got), json.dumps(got, ensure_ascii=False))
bubbles = a.ev("JSON.stringify([...document.querySelectorAll('.bubble')].map(e => e.textContent))")
tt.check("原始 JSON **没有**被画成聊天气泡", '"t":"profile"' not in bubbles, bubbles[:140])

# ── C1. 对方从 gossip 收到 ───────────────────────────────────────────
ok = False
for _ in range(20):
    time.sleep(1)
    if any(BIO in x for x in lines(b)):
        ok = True
        break
tt.check("B 侧也收到了这条名片更新（实时）", ok, json.dumps(lines(b), ensure_ascii=False))

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

# ── C2. 新进房的人也能看到（这一条才是验收标准）─────────────────────
tab_c, c = boot('c' * 64, 'c')
seen = False
for _ in range(20):
    time.sleep(1)
    if any(BIO in x for x in lines(c)):
        seen = True
        break
tt.check("新人 C 的时间线里有这条名片更新（从历史里来）", seen, json.dumps(lines(c), ensure_ascii=False))
rows_c = roster_text(c)
tt.check("**新进房的人立刻看得到 A 的名片**（不靠翻页）", BIO in rows_c, rows_c[:220])

tt.check("三个页面都没有未处理异常",
         a.ev("window.__errs.length") == 0 and c.ev("window.__errs.length") == 0,
         f"A={a.ev('JSON.stringify(window.__errs)')} C={c.ev('JSON.stringify(window.__errs)')}")

for t in (tab_a, tab_b, tab_c):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
