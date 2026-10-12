"""@ 按 id 寻址（R1）—— **昵称只给人看，寻址永远是 id**。

为什么单独立一条：按昵称 @ 在同名、改名、昵称为空时都会 @ 错人或 @ 不到；
这条用例把"底层是 id"钉死：线上文本里是 `@<id8>`，chip 上显示的名字是**渲染时**查的。

覆盖四层：
  A. 纯函数（页内 import js/mention.js + 合成名册）：歧义 / 消歧 / 裸 id / 邮箱误伤 / token 规范化
  B. 真实链路（**三个**成员：两个同名 + 一个发送者）：歧义时不改写、显式 id8 时改写、chip 命中正确的人
  C. **改名后历史里的 chip 立即显示新名**（id 寻址的核心收益）
  D. 输入框 `@` 补全（真实 DOM 事件）→ 人话草稿 → 发送时改写成 token

⚠️ 为什么是三个人：presence 的成员表**不含发送者自己**，所以"两个同名"必须是
   两个**别人**，否则发送者会把它当成唯一匹配（那是**对的**行为，不是 bug）。
"""
import importlib.util, sys, time, json, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"mention{V % 100000}"
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")
KA, KB, KC = 'a' * 64, 'b' * 64, 'c' * 64

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

SET_NICK = """(async (nick) => {
  const { store } = await import('./js/store.js');
  store.setNick(nick);
  window.__iroh_net.setNickname(nick);
  document.dispatchEvent(new CustomEvent('nickchange'));
  return store.nick();
})"""


def boot(key, label, nick):
    tab = tt.open_tab(f"{SITE}/?autostart=1&room={ROOM}&key={key}&v={V}{label}")
    p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
    p.ev("window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message)))")
    tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label=label)
    p.ev(f"({SET_NICK})({json.dumps(nick)})")
    return tab, p


def send(p, text):
    p.ev("(() => { const el = document.getElementById('input'); el.value = %s; "
         "el.setSelectionRange(el.value.length, el.value.length); "
         "el.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()" % json.dumps(text))
    p.ev("document.getElementById('send').click()")
    time.sleep(2.2)


def history(p):
    """读房间历史（roomd 的权威副本）—— 验证"线上/历史里存的到底是什么文本"。"""
    return json.loads(p.ev(f"(async () => JSON.stringify(await window.__iroh_net.history('{ROOM}', 20)))()"))


def last_text(p):
    h = history(p)
    return h[-1]["text"] if h else None


def chips(p):
    return json.loads(p.ev(
        "JSON.stringify([...document.querySelectorAll('.mention')].map(el => [el.textContent, el.dataset.mentionId8]))"))


# ── 三个成员进房：A、B 同名，C 是发送者 ──────────────────────────────
tab_a, a = boot(KA, "a", "同名")
tab_b, b = boot(KB, "b", "同名")
tab_c, c = boot(KC, "c", "旁观者")
tt.wait_until(c, "window.__state().peers.split(' / ').filter(n => n === '同名').length === 2", 90,
              label="C 看到两个同名成员")
id_a = a.ev("window.__state().myId")
id8_a = str(id_a)[:8].lower()
tt.check("A 拿到了自己的 id8", len(id8_a) == 8, id8_a)

# ── A. 纯函数（合成名册，不依赖在场成员）─────────────────────────────
pure = json.loads(a.ev("""(async () => {
  const m = await import('./js/mention.js');
  const same = [
    { id: '11111111' + '0'.repeat(56), nickname: '同名' },
    { id: '22222222' + '0'.repeat(56), nickname: '同名' },
  ];
  const one = [{ id: '22222222' + '0'.repeat(56), nickname: '独苗' }];
  return JSON.stringify({
    ambiguous: m.resolveDraft('@同名 你好', same),
    disambig:  m.resolveDraft('@同名#22222222 你好', same),
    bareId:    m.resolveDraft('@33333333 你好', same),
    unique:    m.resolveDraft('@独苗 你好', one),
    email:     m.resolveDraft('写信到 a@b.com 谢谢', one),
    token:     m.tokenFor('AbCdEf12' + '0'.repeat(56)),
    segs:      m.segments('嗨 @22222222 在吗', one, null),
    selfSegs:  m.segments('嗨 @22222222 在吗', [], { id: '22222222' + '0'.repeat(56), nickname: '我自己' }),
  });
})()"""))
tt.check("同名歧义：**不改写**，原样保留并回报",
         pure["ambiguous"]["text"] == "@同名 你好" and pure["ambiguous"]["ambiguous"] == ["同名"],
         json.dumps(pure["ambiguous"], ensure_ascii=False))
tt.check("显式 `@昵称#id8` → 规范 token",
         pure["disambig"]["text"] == "@22222222 你好", json.dumps(pure["disambig"], ensure_ascii=False))
tt.check("裸 `@id8` → 规范 token",
         pure["bareId"]["text"] == "@33333333 你好", json.dumps(pure["bareId"], ensure_ascii=False))
tt.check("唯一昵称 → 规范 token",
         pure["unique"]["text"] == "@22222222 你好", json.dumps(pure["unique"], ensure_ascii=False))
tt.check("邮箱里的 @ 不是提及（原样不动）",
         pure["email"]["text"] == "写信到 a@b.com 谢谢", json.dumps(pure["email"], ensure_ascii=False))
tt.check("token 统一小写、取前 8 位",
         pure["token"] == "@abcdef12", pure["token"])
tt.check("segments：命中名册 → 显示昵称",
         pure["segs"][1]["nickname"] == "独苗", json.dumps(pure["segs"], ensure_ascii=False))
tt.check("segments：名册里没有我时，self 兜底显示我的名字",
         pure["selfSegs"][1]["nickname"] == "我自己", json.dumps(pure["selfSegs"], ensure_ascii=False))

# ── B. 真实链路 ─────────────────────────────────────────────────────
send(c, "@同名 你好")
tt.check("歧义时消息原样发出（不猜人）", last_text(c) == "@同名 你好", repr(last_text(c)))
tip = c.ev("document.getElementById('composer-tip').textContent")
tt.check("歧义时给了可见提示", "没能确定到唯一成员" in tip, repr(tip))

send(c, f"@同名#{id8_a} 你好A")
tt.check("消歧形式在发送时被改写成规范 token",
         last_text(c) == f"@{id8_a} 你好A", repr(last_text(c)))

time.sleep(1.5)
hit = [x for x in chips(a) if x[1] == id8_a]
tt.check("A 侧渲染成指向自己的 chip（名字按 id 查出来）",
         bool(hit) and hit[-1][0] == "@同名", json.dumps(chips(a), ensure_ascii=False))

# ── C. 改名后历史立即显示新名（id 寻址的核心收益）───────────────────
a.ev(f"({SET_NICK})('新名字')")
ok = False
for _ in range(30):
    time.sleep(1)
    hit = [x for x in chips(c) if x[1] == id8_a]
    if hit and hit[-1][0] == "@新名字":
        ok = True
        break
tt.check("对方改名后，**历史里的 chip** 立即显示新名", ok, json.dumps(chips(c), ensure_ascii=False))

# ── D. 输入框 `@` 补全（真实 DOM 交互）──────────────────────────────
c.ev("(() => { const el = document.getElementById('input'); el.value = '@新'; "
     "el.setSelectionRange(2, 2); el.dispatchEvent(new Event('input', {bubbles: true})); return 1; })()")
time.sleep(0.4)
menu = c.ev("(() => { const m = document.getElementById('mention-menu'); "
            "return JSON.stringify({ hidden: m?.hidden, rows: [...(m?.querySelectorAll('.mention-menu__row') ?? [])].map(r => r.textContent) }); })()")
tt.check("打 `@` 出补全菜单，列出候选（昵称 + id8）", "新名字" in menu and id8_a in menu, menu)

c.ev("document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))")
time.sleep(0.3)
draft = c.ev("document.getElementById('input').value")
tt.check("回车接受候选 → 输入框里是人话（昵称），不是十六进制", draft.strip() == "@新名字", repr(draft))

c.ev("document.getElementById('send').click()")
time.sleep(2.2)
tt.check("补全出来的草稿在发送时同样被改写成 token",
         last_text(c) == f"@{id8_a}", repr(last_text(c)))

tt.check("三个页面都没有未处理异常",
         a.ev("window.__errs.length") == 0 and c.ev("window.__errs.length") == 0,
         f"A={a.ev('JSON.stringify(window.__errs)')} C={c.ev('JSON.stringify(window.__errs)')}")

for t in (tab_a, tab_b, tab_c):
    tt.close_tab(t["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
