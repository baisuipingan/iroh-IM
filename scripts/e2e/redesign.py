"""比奇堡（Bikini Bottom）视觉改造的针对性回归。

一次跑完五组断言，覆盖的都是**这次改造新引入、且改坏了不容易被发现**的东西：

  A. 结构就位      —— 环境气泡层 / 水滴水印 / 筛选 chips / 顶栏操作 / 成员药丸
  B. 令牌与尺寸    —— 64 / 300 / 56 三个设计稿尺寸、激活指示条、选中 chip 配色
  C. 连接信息真实  —— 列表底部、信道指示、输入区页脚三处都得是真数据（不是氛围文案）
  D. 对比度        —— 浅/深两套主题逐对量 WCAG。**这条最值钱**：改造中途真的踩到
                      "药丸底色用了固定浅色，深色下文字糊成一团"，肉眼漏了、量出来才发现。
  E. 图片卡片硬约束 —— `.imgcard__ph` 未接收占位必须 116px、图片不得越框且 ≤220px。
                      因为 `image-layout.mjs` 依赖 playwright（本机未安装、不在 run.sh 里），
                      这里用 CDP 复刻一遍，免得那条约束在无人看守的情况下被改掉。

前置同其它 e2e：dev-serve 在 8099、Chrome 带 --remote-debugging-port=9222。
"""
import base64
import importlib.util
import json
import re
import subprocess
import sys
import time

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"bb{V % 100000}"
SITE = "http://127.0.0.1:8099"
URL = f"{SITE}/?autostart=1&room={ROOM}&testid=1&v={V}"

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)
subprocess.run([sys.executable, "scripts/e2e/clear-storage.py"], check=False,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

tab = tt.open_tab(URL)
p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
tap = tt.LogTap(tab["id"])
tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label="进房")
p.call("Emulation.setDeviceMetricsOverride",
       {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
time.sleep(1.5)

# ⚠️ 主题必须**显式定成浅色**再量尺寸/配色。
#    默认是 follow-system，而无头 Chrome 的 prefers-color-scheme 跟着宿主机器走 ——
#    同一份用例在浅色机器上过、在深色机器上挂（实测踩到：图标栏底色读成 #06131f）。
#    凡是要断言具体色值的用例都必须先把主题钉死（image-layout.mjs 也是这么做的）。
p.ev("window.__iroh_theme('light')")
time.sleep(0.8)

# 一条自己的消息 + 一条"对方发来的"（走真实渲染路径，好量收到气泡的对比度）
p.ev("window.__iroh_sendText('改造回归用消息')", timeout=20)
time.sleep(1.5)
p.ev("""(async () => {
  const { timeline } = await import('./js/ui/timeline.js');
  timeline.push({ id: 'redesign-recv', ts: Date.now(), nickname: '回归邻居',
                  text: '对方发来的消息', from: 'redesign-peer' }, false, false);
  const { store } = await import('./js/store.js');
  const { sidebar } = await import('./js/ui/sidebar.js');
  store.upsertRoom(sidebar.currentRoom, { pinned: true });
  sidebar.render();
  return 1;
})()""", timeout=30)
time.sleep(2)

# ── A 结构就位 ──────────────────────────────────────────────────────────
a = json.loads(p.ev("""JSON.stringify({
  bubbles: document.querySelectorAll('.ambient__b').length,
  watermark: !!document.querySelector('.chat-watermark svg'),
  chips: [...document.querySelectorAll('#panel-tabs .tab-chip')].map(c => c.textContent),
  chipOn: document.querySelector('#panel-tabs .tab-chip.is-on')?.textContent,
  headBtns: document.querySelectorAll('.chat-head__actions .head-btn').length,
  members: (document.getElementById('room-members-text') || {}).textContent || '',
  connFoot: (document.getElementById('conn-foot-text').textContent || '').trim(),
  panelFoot: (document.getElementById('panel-foot-text').textContent || '').trim(),
  channel: (document.getElementById('channel-text').textContent || '').trim(),
  jumpText: (document.getElementById('jump-btn').textContent || '').trim(),
  pinnedTag: document.querySelectorAll('#panel-body .row__tag').length,
})"""))
tt.check("环境气泡层渲染 7 颗", a["bubbles"] == 7, str(a["bubbles"]))
tt.check("中央水滴水印存在", a["watermark"] is True)
# 只有「全部 / 置顶」两个：「未读」筛选已删 ——
# 它只在页面开着时计数、回到页面就清零，而这个产品不是 IM（没好友/私信/群组），
# 用户不会"忘了"某个房间有人在等。徽标和标题数字仍保留。
tt.check("房间筛选 chips = 全部/置顶（未读筛选已删）", a["chips"] == ["全部", "置顶"], str(a["chips"]))
tt.check("默认选中「全部」", a["chipOn"] == "全部", str(a["chipOn"]))
tt.check("顶栏三个快捷操作齐备", a["headBtns"] == 3, str(a["headBtns"]))
tt.check("成员药丸显示真实人数（含自己）", a["members"].endswith("人") and a["members"] != "0 人", a["members"])
tt.check("置顶房间有「置顶」标签", a["pinnedTag"] == 1, str(a["pinnedTag"]))
tt.check("回到最新文案未变", a["jumpText"] == "回到最新", a["jumpText"])

# ── B 令牌与尺寸 ────────────────────────────────────────────────────────
b = json.loads(p.ev("""JSON.stringify((() => {
  const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const indicator = getComputedStyle(document.querySelector('.rail-btn.is-active'), '::before');
  return {
    rail: box('.rail')[0], panel: box('.panel')[0], head: box('.chat-head')[1],
    railBg: getComputedStyle(document.querySelector('.rail')).backgroundColor,
    indicator: [indicator.backgroundColor, indicator.width],
    chipBg: getComputedStyle(document.querySelector('#panel-tabs .tab-chip.is-on')).backgroundColor,
  };
})())"""))
# ⚠️ 这两条是**产品决定**，不是设计稿的值：DESIGN.md 写的是 64 / 300，
#    但负责人要求沿用项目原本的比例（56 / 268，仿微信那版），总宽从 364 收到 324。
#    要改回设计稿的尺寸，先改 tokens.css，再改这里 —— 两处必须一起动。
tt.check("图标栏 56px（沿用原版的仿微信比例）", b["rail"] == 56, str(b["rail"]))
tt.check("列表面板 268px（沿用原版的仿微信比例）", b["panel"] == 268, str(b["panel"]))
tt.check("顶栏 56px", b["head"] == 56, str(b["head"]))
tt.check("图标栏底色 = 深海蓝 #0E2439", b["railBg"] == "rgb(14, 36, 57)", b["railBg"])
tt.check("激活项有金色左侧 3px 指示条",
         b["indicator"] == ["rgb(253, 216, 53)", "3px"], str(b["indicator"]))
tt.check("选中 chip 底色 = 海绵金 #FDD835",
         b["chipBg"] == "rgb(253, 216, 53)", b["chipBg"])

# ── C 三处连接信息都是真数据（不是设计稿那种氛围文案） ──────────────────
# ⚠️ 判"是不是编造的量"要按**词**匹配，不能按字符。设计稿的氛围文案里有
#    "104.5 MHz / 304 kPa"，一开始我写成 `any(ch in v for ch in "MHzkPa…")`，
#    结果普通中继 id 里的 `k`（hk-1）被当成 kPa 的 `k`，把真数据判成了假数据。
FAKE = ("MHz", "kHz", "kPa", "声纳", "深度压强", "太平洋", "深海", "专线")
for key, label in (("channel", "信道指示"), ("panelFoot", "列表底部"), ("connFoot", "输入区页脚")):
    v = a[key]
    real = bool(v) and "…" not in v and not any(term in v for term in FAKE)
    tt.check(f"{label}显示真实连接信息（无占位/无编造量）", real, f"{v!r}")
tt.check(f"信道指示是状态词而非数字", a["channel"] in ("信道稳定", "连接中", "已断开"), a["channel"])
# ⚠️ 不能要求两处文案**逐字相等**：列表底部是简写（`中继 hk-1`），
#    输入区页脚会多带一个延迟（`中继 hk-1 · 延迟 60ms`），而且延迟是探测
#    异步回来后才出现的 —— 比字符串等于必然会偶发失败。比"是不是同一台"才有意义。
foot = re.search(r"中继\s+(\S+)", a["panelFoot"] or "")
conn = re.search(r"中继\s+(\S+)", a["connFoot"] or "")
tt.check("列表底部与输入区页脚指向同一台中继",
         bool(foot and conn and foot.group(1) == conn.group(1)),
         f"{a['panelFoot']!r} vs {a['connFoot']!r}")

# ── D 对比度（两套主题） ────────────────────────────────────────────────
PROBE = r"""(() => {
  const norm = c => {
    const m = String(c).match(/[\d.]+/g) || [];
    // Chrome 把 color-mix() 的结果算成 `color(srgb r g b / a)`，分量是 0~1 浮点；
    // 按 0~255 解析会把金色读成接近全黑（改造中途这么误报过一次）。
    const s = /^color\(/.test(String(c)) ? 255 : 1;
    return { r: (+m[0]) * s, g: (+m[1]) * s, b: (+m[2]) * s, a: m.length > 3 ? +m[3] : 1 };
  };
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 255, g: 255, b: 255, a: 0 };
    return { r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
             g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
             b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a, a };
  };
  const bgOf = el => {
    let n = el, acc = { r: 255, g: 255, b: 255, a: 0 };
    while (n) {
      const c = norm(getComputedStyle(n).backgroundColor);
      if (c.a > 0) { acc = over(acc, c); if (acc.a >= .999) return acc; }
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
    return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
  };
  const ratio = (fg, bg) => { const x = lum(fg), y = lum(bg);
    return Math.round(((Math.max(x, y) + .05) / (Math.min(x, y) + .05)) * 100) / 100; };
  const t = { '正文': 'body', '房间名': '#panel-body .row__name', '房间预览': '#panel-body .row__preview',
    '置顶标签': '#panel-body .row__tag', 'chip选中': '#panel-tabs .tab-chip.is-on',
    '信道文字': '#channel-text', '房间标题': '.chat-head__title', '成员药丸': '#room-members',
    '节点药丸': '#node-pill', '收到气泡': '.msg:not(.msg--me) .bubble',
    '页脚连接': '#conn-foot-text', '列表页脚': '#panel-foot-text' };
  const out = {};
  for (const [k, sel] of Object.entries(t)) {
    const el = document.querySelector(sel);
    if (!el) { out[k] = null; continue; }
    out[k] = ratio(norm(getComputedStyle(el).color), bgOf(el));
  }
  const bub = document.querySelector('.msg--me .bubble');
  out['发送气泡'] = bub ? ratio(norm(getComputedStyle(bub).color), { r: 255, g: 213, b: 79, a: 1 }) : null;
  return out;
})()"""
EXPECT = {"light": "#061d31", "dark": "#e9f1ff"}
for theme in ("light", "dark"):
    p.ev(f"document.documentElement.dataset.theme = {theme!r}")
    time.sleep(0.9)
    got = p.ev("getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()")
    tt.check(f"{theme} 主题已生效", got == EXPECT[theme], f"--fg={got!r}")
    r = json.loads(p.ev(f"JSON.stringify({PROBE})"))
    for k, v in r.items():
        if v is None:
            tt.check(f"{theme}/{k} 元素存在", False); continue
        need = 3.0 if k == "信道文字" else 4.5
        tt.check(f"{theme}/{k} 对比度 ≥ {need}", v >= need, f"{v}")

p.ev("document.documentElement.dataset.theme = 'light'")
time.sleep(0.6)

# ── E 图片卡片硬约束（复刻 image-layout.mjs） ──────────────────────────
p.ev("""(async () => {
  const { timeline } = await import('./js/ui/timeline.js');
  const shapes = [{ n: 'portrait', w: 600, h: 900 }, { n: 'square', w: 480, h: 480 }, { n: 'wide', w: 1200, h: 80 }];
  for (const [i, s] of shapes.entries()) {
    const c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
    const x = c.getContext('2d'); x.fillStyle = '#81c9f2'; x.fillRect(0, 0, s.w, s.h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    timeline.pushFileCard({ room: timeline.room, meta: { file_id: s.n, name: s.n + '.png', size: blob.size,
      mime: blob.type, chunk_size: 16384 }, direction: 'recv', state: 'done',
      previewUrl: URL.createObjectURL(blob), ts: Date.now() + i });
  }
  timeline.pushFileCard({ room: timeline.room, meta: { file_id: 'pend', name: 'pend.png', size: 128,
    mime: 'image/png', chunk_size: 16384 }, direction: 'recv', state: 'invited' });
  return 1;
})()""", timeout=30)
time.sleep(2.5)

for theme in ("light", "dark"):
    p.ev(f"document.documentElement.dataset.theme = {theme!r}")
    for width in (1440, 320):
        p.call("Emulation.setDeviceMetricsOverride",
               {"width": width, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
        if width == 320:
            p.ev("document.getElementById('panel').classList.remove('is-open')")
        time.sleep(0.8)
        rows = json.loads(p.ev("""JSON.stringify((() => {
          const out = [];
          for (const name of ['portrait', 'square', 'wide']) {
            const card = document.querySelector(`.msg--img[data-file-id="${name}"]`);
            if (!card) { out.push({ name, missing: 1 }); continue; }
            card.scrollIntoView({ block: 'center' });
            const f = card.querySelector('.imgcard__ph').getBoundingClientRect();
            const im = card.querySelector('img').getBoundingClientRect();
            const tl = document.getElementById('timeline');
            out.push({ name, inside: im.left >= f.left - 1 && im.right <= f.right + 1 &&
                       im.top >= f.top - 1 && im.bottom <= f.bottom + 1,
                       fills: Math.abs(f.height - im.height) <= 1, hOK: im.height <= 220.1,
                       noX: tl.scrollWidth <= tl.clientWidth + 1 });
          }
          const pend = document.querySelector('.msg--img[data-file-id="pend"] .imgcard__ph');
          out.push({ name: 'pend', h: pend ? Math.round(pend.getBoundingClientRect().height) : null });
          return out;
        })())"""))
        for it in rows:
            if it.get("missing"):
                tt.check(f"{theme}/{width}/{it['name']} 卡片存在", False); continue
            if it["name"] == "pend":
                tt.check(f"{theme}/{width}/未接收占位框 116px", abs(it["h"] - 116) < 1, str(it["h"]))
                continue
            tt.check(f"{theme}/{width}/{it['name']} 图片在框内、≤220px、无横向滚动",
                     it["inside"] and it["fills"] and it["hOK"] and it["noX"], json.dumps(it))

# ── F 两张新设计稿：连接状态页（_1）+ 设置页（_2） ──────────────────────
p.call("Emulation.setDeviceMetricsOverride",
       {"width": 1440, "height": 1200, "deviceScaleFactor": 1, "mobile": False})
p.ev("window.__iroh_theme('light')")
time.sleep(0.8)
# 给房间一个备注名：顶栏徽标只在"备注名 ≠ 房间名"时出现（否则和标题重复）
p.ev("""(async () => {
  const { store } = await import('./js/store.js');
  const { sidebar } = await import('./js/ui/sidebar.js');
  store.upsertRoom(sidebar.currentRoom, { alias: '蟹堡王后厨研讨室' });
  sidebar.render();
  return 1;
})()""")
time.sleep(1.4)

# ⚠️ 面板内容都不许横向溢出（给"新增卡片/长中继名/长 id"用的兜底检查）
OVER_PROBE = """(() => {
  const body = document.getElementById('panel-body');
  const panel = document.getElementById('panel').getBoundingClientRect();
  let n = 0;
  for (const el of body.querySelectorAll('*')) {
    if (!el.textContent || !el.textContent.trim() || el.children.length) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > panel.right + 1 || r.left < panel.left - 1) n++;
  }
  return n;
})()"""

# ---- 连接状态页 ----
p.ev("document.getElementById('tab-status').click()")
time.sleep(1.6)
st = json.loads(p.ev("""JSON.stringify((() => {
  const body = document.getElementById('panel-body');
  const relays = [...body.querySelectorAll('.relay')];
  return {
    cards: body.querySelectorAll('.pcard').length,
    relays: relays.length,
    twoLine: relays.every(r => !!r.querySelector('.relay__id') && !!r.querySelector('.relay__state')),
    rttPills: body.querySelectorAll('.relay__rtt').length,
    states: [...body.querySelectorAll('.relay__state')].map(e => e.textContent.trim()),
    idGroups: (body.querySelector('.id-hex')?.textContent || '').trim().split(/\\s+/).filter(Boolean).length,
    hasReprobe: !!body.querySelector('[data-act="reprobe"]'),
    hasCopyId: !!body.querySelector('[data-act="copy-id"]'),
    hasCopyRoom: !!body.querySelector('[data-act="copy-room"]'),
    stats: body.querySelectorAll('.stat').length,
    text: body.innerText,
  };
})())"""))
tt.check("状态页是卡片式（≥4 张卡）", st["cards"] >= 4, str(st["cards"]))
# 节点状态 / 当前房间 / 在线成员 / 历史节点 / Gossip 邻居
# （「在线成员」原来是独立一页，合并后它和「历史节点」都成了这里的行）
tt.check("状态页有 5 条实时统计行", st["stats"] == 5, str(st["stats"]))
tt.check("中继行存在且是两行式（名称 + 状态）", st["relays"] >= 1 and st["twoLine"], f"{st['relays']} 行")
tt.check("每台中继都有 rtt 药丸", st["rttPills"] == st["relays"], f"{st['rttPills']}/{st['relays']}")
tt.check("中继状态是人话（在用/未使用/已禁用/异常）",
         bool(st["states"]) and all(any(k in x for k in ("在用", "未使用", "已禁用", "异常")) for x in st["states"]),
         str(st["states"]))
tt.check("身份 ID 仍按 8 位分组", st["idGroups"] == 8, str(st["idGroups"]))
tt.check("三个动作都在（重新探测 / 复制身份 ID / 复制房间名）",
         st["hasReprobe"] and st["hasCopyId"] and st["hasCopyRoom"], "")
tt.check("状态页没有横向溢出", p.ev(OVER_PROBE) == 0, str(p.ev(OVER_PROBE)))

# ---- 成员名单合并进状态页 ----
tt.check("左栏只剩三个入口（聊天 / 连接 / 设置）",
         p.ev("document.querySelectorAll('.rail-btn').length") == 4,   # 3 个 tab + 1 个重新探测
         str(p.ev("document.querySelectorAll('.rail-btn').length")))
tt.check("左栏不再有独立的成员入口", p.ev("!document.getElementById('tab-people')") is True, "")
mem0 = json.loads(p.ev("""JSON.stringify({
  row: !!document.querySelector('[data-expand="members"]'),
  open: !!document.querySelector('#status-members.is-open'),
  expanded: document.querySelector('[data-expand="members"]')?.getAttribute('aria-expanded'),
})"""))
tt.check("「在线成员」是可展开的一行，默认收起",
         mem0["row"] and mem0["open"] is False and mem0["expanded"] == "false", json.dumps(mem0))
p.ev("document.querySelector('[data-expand=\"members\"]').click()")
time.sleep(0.9)
mem1 = json.loads(p.ev("""JSON.stringify({
  open: !!document.querySelector('#status-members.is-open'),
  expanded: document.querySelector('[data-expand="members"]')?.getAttribute('aria-expanded'),
  rows: document.querySelectorAll('#status-members .member').length,
  hasId: /[0-9a-f]{8}/.test(document.querySelector('#status-members .member__sub')?.textContent || ''),
})"""))
tt.check("点开后名单展开、且带了身份 ID 前缀",
         mem1["open"] and mem1["expanded"] == "true" and mem1["rows"] >= 1 and mem1["hasId"],
         json.dumps(mem1, ensure_ascii=False))
# ★ 展开态必须扛得住重绘（presence 心跳约 15 秒一轮就会整段重建 innerHTML）
p.ev("(async () => { const { sidebar } = await import('./js/ui/sidebar.js'); sidebar.render(); return 1; })()")
time.sleep(1.0)
tt.check("重绘后名单仍是展开的（不会被心跳收起）",
         p.ev("!!document.querySelector('#status-members.is-open')") is True, "")
p.ev("document.querySelector('[data-expand=\"members\"]').click()")
time.sleep(0.6)
tt.check("再点一下能收起", p.ev("!!document.querySelector('#status-members.is-open')") is False, "")
tt.check("状态页有「历史节点」行（常驻节点信息没有丢）",
         p.ev("[...document.querySelectorAll('#panel-body .stat__label')].some(e => e.textContent === '历史节点')") is True, "")
# ★ 这条是防回归的关键：设计稿的"3000m 专线 / 信标载波 142.85 MHz / 丢失率 0.00%"
#   全是编的，一旦有人照抄进来，排障页就会开始骗人。
tt.check("状态页不含设计稿的氛围文案（专线 / MHz / 丢失率）",
         not any(t in st["text"] for t in ("3000m", "MHz", "kHz", "丢失率")), "发现编造量")
tt.check("状态页不泄露私钥（只展示公开身份 ID）",
         "私钥" not in st["text"] or "切勿分享" in st["text"], "")

# ---- 设置页 ----
p.ev("document.getElementById('tab-settings').click()")
time.sleep(1.4)
se = json.loads(p.ev("""JSON.stringify((() => {
  const body = document.getElementById('panel-body');
  return {
    groups: body.querySelectorAll('.set-group').length,
    bodies: body.querySelectorAll('.set-group__body').length,
    switches: body.querySelectorAll('.switch').length,
    selects: body.querySelectorAll('select').length,
    wallTiles: body.querySelectorAll('[data-wallpaper]').length,
    wallOn: body.querySelectorAll('[data-wallpaper].is-on').length,
    hasUsage: body.innerText.includes('本地配置占用'),
    hasDanger: !!body.querySelector('.set-group--danger'),
    hasTools: !!body.querySelector('[data-act="testsound"]') && !!body.querySelector('[data-act="resetdefaults"]'),
    navRows: body.querySelectorAll('.set-row--nav').length,
  };
})())"""))
tt.check("设置页是分组白卡（≥6 组，标签与卡一一对应）",
         se["groups"] >= 6 and se["bodies"] == se["groups"], f"{se['groups']} 组 / {se['bodies']} 卡")
tt.check("开关控件仍在（提示音 / 标题未读）", se["switches"] >= 2, str(se["switches"]))
tt.check("下拉控件仍在（快捷键 / 主题 / 密度）", se["selects"] >= 3, str(se["selects"]))
tt.check("可点开的行仍在（昵称 / 房间 / 诊断 / 导出 …）", se["navRows"] >= 5, str(se["navRows"]))
tt.check("壁纸 4 档且恰有 1 档选中", se["wallTiles"] == 4 and se["wallOn"] == 1, f"{se['wallTiles']}/{se['wallOn']}")
tt.check("保留「本地配置占用」（数据用量没丢）", se["hasUsage"] is True, "")
tt.check("危险操作单独成组", se["hasDanger"] is True, "")
tt.check("有「测试提示音」「恢复默认」", se["hasTools"] is True, "")
tt.check("设置页没有横向溢出", p.ev(OVER_PROBE) == 0, str(p.ev(OVER_PROBE)))
# ★ 说明文字不许折行。面板窄（268px）时最容易出这个问题：
#   右边跟着 select / switch / 取值 的行，留给说明的宽度只有 100~170px，
#   长一点的说明就会断成两行，整页看起来毛毛躁躁。
#   （收窄左栏时真漏过 4 处，所以补上这条守卫。）
wrapped = json.loads(p.ev("""JSON.stringify([...document.querySelectorAll('#panel-body .set-row')]
  .filter(r => r.querySelector('.set-row__hint'))
  .map(r => { const h = r.querySelector('.set-row__hint');
    const lh = parseFloat(getComputedStyle(h).lineHeight) || 16;
    return { label: r.querySelector('.set-row__label').textContent.trim(),
             lines: Math.round(h.getBoundingClientRect().height / lh) }; })
  .filter(x => x.lines > 1))"""))
tt.check("设置项说明文字不折行（面板窄也只在 1 行内）", wrapped == [], json.dumps(wrapped, ensure_ascii=False))
# 工具行同理：窄了以后不能把按钮内部压成两行
tools = json.loads(p.ev("""JSON.stringify((() => {
  const row = document.querySelector('.set-tools');
  const items = [...document.querySelectorAll('.set-tools > *')];
  return { h: Math.round(row.getBoundingClientRect().height),
           worst: Math.max(...items.map(e => Math.round(e.getBoundingClientRect().height))) };
})())"""))
tt.check("设置页工具行没有把按钮压成两行", tools["h"] <= 34 and tools["worst"] <= 34, json.dumps(tools))

# 壁纸：点一下要立刻生效 + 落盘
p.ev("document.querySelector('[data-wallpaper=\"sun\"]').click()")
time.sleep(0.9)
after = p.ev("document.documentElement.dataset.wallpaper")
saved = p.ev("JSON.parse(localStorage.getItem('iroh.prefs')||'{}').wallpaper")
tt.check("选壁纸立即生效并落盘", after == "sun" and saved == "sun", f"{after} / {saved}")
p.ev("document.querySelector('[data-wallpaper=\"none\"]').click()")
time.sleep(0.7)
tt.check("壁纸可切回「纯净海面」", p.ev("document.documentElement.dataset.wallpaper") == "none", "")

# 搜索：设置页现在真的会筛（不是装饰）
p.ev("(() => { const f = document.getElementById('filter'); f.value = '壁纸'; f.dispatchEvent(new Event('input')); return 1; })()")
time.sleep(1.0)
filt = json.loads(p.ev("""JSON.stringify({
  groups: document.querySelectorAll('#panel-body .set-group').length,
  text: document.getElementById('panel-body').innerText })"""))
tt.check("设置页搜索能筛掉无关分组", 0 < filt["groups"] < se["groups"] and "壁纸" in filt["text"], str(filt["groups"]))
p.ev("(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()")
time.sleep(0.8)

# 顶栏（设计稿 _1）：房间名徽标 + 备注名标题 + 真实副行
head = json.loads(p.ev("""JSON.stringify({
  badge: document.getElementById('room-badge').hidden ? '' : document.getElementById('room-badge').textContent,
  title: document.getElementById('room-title').textContent,
  sub: document.getElementById('chat-subline-text').textContent,
})"""))
tt.check("有备注名时顶栏出现房间名徽标，且不与标题重复",
         bool(head["badge"]) and head["badge"] != head["title"], f"{head['badge']!r} vs {head['title']!r}")
tt.check("顶栏副行是真数据（无 3000m / MHz / 丢失率）",
         not any(t in head["sub"] for t in ("3000m", "MHz", "kHz", "丢失率")), head["sub"])
tt.check("顶栏副行说清加密事实", "端到端加密" in head["sub"], head["sub"])
time.sleep(0.5)

# ── G 视图切换 + 中继拓扑（设计稿 _1 的「声呐拓扑」） ────────────────────
p.ev("document.getElementById('tab-chats').click()")
time.sleep(0.8)
vt = json.loads(p.ev("""JSON.stringify({
  tabs: [...document.querySelectorAll('#view-tabs .view-tab')].map(t => t.textContent.trim()),
  onDefault: document.querySelector('#view-tabs .view-tab.is-on')?.textContent.trim(),
  visible: !!document.querySelector('.topology.is-on'),
})"""))
tt.check("顶栏有「消息对话 / 中继拓扑」两档", vt["tabs"] == ["消息对话", "中继拓扑"], str(vt["tabs"]))
tt.check("默认停在「消息对话」，拓扑是隐藏的",
         vt["onDefault"] == "消息对话" and vt["visible"] is False, f"{vt['onDefault']}/{vt['visible']}")

p.ev("window.__iroh_view('topology')")
time.sleep(1.2)
tp = json.loads(p.ev("""JSON.stringify((() => {
  const t = document.getElementById('topology');
  const nums = [...t.querySelectorAll('.topo-card__num')].map(e => e.textContent.trim());
  return {
    view: window.__state().ui.view,
    visible: !!t.classList.contains('is-on'),
    cards: t.querySelectorAll('.topo-card').length,
    nums,
    metrics: [...t.querySelectorAll('.topo-card')].map(c => c.dataset.metric),
    text: t.innerText,
    hasLocalNode: !!t.querySelector('.topo-node.is-local'),
    hasHomeNode: !!t.querySelector('.topo-node.is-home, .topo-node'),
    hasReprobe: !!t.querySelector('[data-topo="reprobe"]'),
    chips: t.querySelectorAll('.topo-chip').length,
    xScroll: t.scrollWidth - t.clientWidth,
    coveredComposer: (() => {
      // 输入区必须被拓扑盖住（证明它是覆盖层，而不是与时间线并排）
      const r = document.getElementById('composer').getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!el && !!el.closest('.topology');
    })(),
  };
})())"""))
tp["text"] = " ".join((tp.get("text") or "").split())   # 空白归一化在 Python 侧做
tt.check("切到拓扑后视图生效且面板可见", tp["view"] == "topology" and tp["visible"] is True, tp["view"])
tt.check("拓扑有 3 张指标卡（中继集群 / 主链路延迟 / Gossip 邻居）",
         tp["cards"] == 3 and tp["metrics"] == ["relays", "latency", "gossip"], str(tp["metrics"]))
tt.check("指标数字是纯数字或「—」（不是编的百分比/小数）",
         all(n == "—" or n.isdigit() for n in tp["nums"]), str(tp["nums"]))
tt.check("拓扑页盖住了输入区（是覆盖层，不是并排）", tp["coveredComposer"] is True, "")
tt.check("拓扑页没有横向溢出", tp["xScroll"] <= 1, str(tp["xScroll"]))
tt.check("链路图有「本机」节点和备选链路", tp["hasLocalNode"] and tp["chips"] >= 1,
         f"local={tp['hasLocalNode']} chips={tp['chips']}")
# ★ 与状态页同一条防线：设计稿「声呐拓扑」里的数字全是编的，一旦照抄进来
#   这一页会变成"看起来最专业、其实全假"的页面 —— 而它正是排障时最先打开的。
tt.check("拓扑不含设计稿编造的量（GEO / 负载 / gossip 周期 / 256 Bit / 3000m）",
         not any(t in tp["text"] for t in ("GEO", "负载", "0.42", "256", "3000m", "kHz")), "发现编造量")
tt.check("拓扑说清「打不了洞」这个前提", "relay-only" in tp["text"], tp["text"][:120])

# 拓扑里的「重新探测」必须真的接线（它不在 #panel-body 里，绑定要自己做）
p.ev("document.getElementById('composer-tip').textContent = ''")
p.ev("document.querySelector('#topology [data-topo=\"reprobe\"]').click()")
time.sleep(0.9)
# ⚠️ 不能只断言"提示里出现『探测』两个字"：探测很快（本地 60ms 级），
#    0.9 秒后提示已经被**结果**覆盖掉了（"hk-1 59ms · eu-1 205ms …"），
#    于是断言会偶发失败 —— 第一次跑就是这么挂的。判据改成
#    "点了之后提示要么在探测中、要么给出了探测结果"，两种都算接上了线。
_tip = p.ev("document.getElementById('composer-tip').textContent") or ""
tt.check("拓扑页的「重新探测」按钮真的接了线",
         any(k in _tip for k in ("探测", "ms", "不可达")), repr(_tip))
p.ev("window.__iroh_view('chat')")
time.sleep(0.8)
tt.check("切回「消息对话」后拓扑收起",
         p.ev("!!document.querySelector('.topology.is-on')") is False, "")

# ── H 桌面通知 ──────────────────────────────────────────────────────────
# 正文里放不放消息内容，是这一块唯一真正有隐私含义的决定 —— 用断言钉死。
nb = json.loads(p.ev("""JSON.stringify({
  withContent: window.__iroh_notifyBody('room-x', { nickname: '派大星', text: '机密内容' }, {}),
  noContent: window.__iroh_notifyBody('room-x', { nickname: '派大星', text: '机密内容' }, { notifyContent: false }),
  empty: window.__iroh_notifyBody('room-x', { nickname: '派大星', text: '' }, {}),
})"""))
tt.check("默认通知正文带发送者与内容",
         "派大星" in nb["withContent"]["body"] and "机密内容" in nb["withContent"]["body"],
         json.dumps(nb["withContent"], ensure_ascii=False))
tt.check("关掉「显示消息内容」后正文里不出现消息文本",
         "机密内容" not in nb["noContent"]["body"] and nb["noContent"]["body"] == "新消息",
         json.dumps(nb["noContent"], ensure_ascii=False))
tt.check("空消息不会产生「昵称: 」这种残缺正文", nb["empty"]["body"] == "新消息", nb["empty"]["body"])

p.ev("document.getElementById('tab-settings').click()")
time.sleep(1.2)
se2 = json.loads(p.ev("""JSON.stringify((() => {
  const body = document.getElementById('panel-body');
  const labels = [...body.querySelectorAll('.set-row__label')].map(e => e.textContent.trim());
  return {
    switches: body.querySelectorAll('.switch').length,
    hasNotify: labels.includes('桌面通知'),
    hasContent: labels.includes('通知里显示消息内容'),
    contentOn: !!body.querySelector('[data-toggle="notifyContent"]')?.classList.contains('is-on'),
    notifyOn: !!body.querySelector('[data-toggle="notify"]')?.classList.contains('is-on'),
    perm: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    prefOn: window.__state().ui.notifyOn,
  };
})())"""))
tt.check("设置页新增两个通知开关", se2["hasNotify"] and se2["hasContent"], str(se2["switches"]))
tt.check("桌面通知默认关闭", se2["notifyOn"] is False and se2["prefOn"] is False, str(se2["prefOn"]))
tt.check("「通知里显示消息内容」默认开", se2["contentOn"] is True, "")

# ★ 关键不变量：开关的状态必须与**系统权限**一致。
#   最常见的坑是"开关显示已开、系统里一直是拒绝" —— 用户以为开了，其实永远收不到。
p.ev("document.querySelector('[data-toggle=\"notify\"]').click()")
time.sleep(1.6)
after = json.loads(p.ev("""JSON.stringify({
  on: !!document.querySelector('[data-toggle="notify"]')?.classList.contains('is-on'),
  pref: window.__state().ui.notifyOn,
  perm: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
})"""))
tt.check("桌面通知开关必须与系统权限一致（不许出现「开着却收不到」）",
         after["on"] == after["pref"] and after["pref"] == (after["perm"] == "granted"),
         json.dumps(after, ensure_ascii=False))
# 复位，别把授权状态留给下一个用例
if after["pref"]:
    p.ev("document.querySelector('[data-toggle=\"notify\"]').click()")
    time.sleep(0.6)
time.sleep(0.4)

# ── I 贴底：刚发的消息不能被输入区压住一半 ────────────────────────────
# ★ 回归断言。原来的 bug：`scrollBottom()` 是**一次性**的，而发消息时浏览器会做
#   滚动锚定（scrollTop 自动跟着内容增长 +Δ），加上那一刻读到的 scrollHeight
#   还没稳定 —— 最后一条会卡在输入区后面约 26px，要用户再点一下输入框才对。
#   修法是把它改成结构性贴底（ResizeObserver + 补钉几帧），这里钉住它。
# ⚠️ 必须先切到一个**属于本次运行**的房间：同一个标签页里可能还连着别的用例留下的房间，
#    `__iroh_sendText` 发去的是**当前房间**，不然这些消息根本没进本房间的时间线。
# ⚠️ 房间名必须**每次运行唯一**：固定名字的话，上一轮跑过的历史还挂在锚点上，
#    断言里"往上翻"会触发 loadOlder 往前插页，位置被冲掉 → 偶发失败（实测过）。
STICK_ROOM = f"贴底测试房-{int(time.time())}"
p.ev(f"window.__iroh_openRoom({json.dumps(STICK_ROOM)})")
tt.wait_until(p, f"window.__state && window.__state().joined === {json.dumps(STICK_ROOM)}", 90, label="贴底测试房")
time.sleep(1.5)
p.call("Emulation.setDeviceMetricsOverride",
       {"width": 1080, "height": 663, "deviceScaleFactor": 1, "mobile": False})
time.sleep(1.0)
GAP = """(() => {
  const tl = document.getElementById('timeline'), comp = document.getElementById('composer');
  const rows = [...document.getElementById('tl-inner').querySelectorAll('.msg')];
  const last = rows[rows.length - 1];
  const cr = comp.getBoundingClientRect();
  const lr = last ? last.getBoundingClientRect() : null;
  return JSON.stringify({
    gap: Math.round(tl.scrollHeight - tl.clientHeight - tl.scrollTop),
    overflows: tl.scrollHeight > tl.clientHeight + 20,
    hidden: lr ? Math.round(lr.bottom - cr.top) : null,
  });
})()"""
# 灌到溢出，模拟用户真实场景（内容要够多才有"滚动"这回事）
for i in range(12):
    p.ev(f"window.__iroh_sendText('贴底测试消息第 {i + 1} 条')")
    time.sleep(0.45)
time.sleep(1.2)
g1 = json.loads(p.ev(GAP))
tt.check("先造出可滚动的内容（否则测不到贴底）", g1["overflows"] is True, json.dumps(g1))
tt.check("发完消息后时间线是贴底的", g1["gap"] <= 2, f"差 {g1['gap']}px")
tt.check("最后一条消息没有被输入区压住", (g1["hidden"] or -999) <= 2, f"露出输入区 {g1['hidden']}px")

# 上方内容突然变高（图片解码完 / 文件卡刷新）时也应该重新贴底
p.ev("""(() => {
  const inner = document.getElementById('tl-inner');
  const rows = [...inner.querySelectorAll('.msg')];
  const sp = document.createElement('div');
  sp.id = 'probe-spacer';
  sp.style.cssText = 'height:0;overflow:hidden';
  rows[rows.length - 1].before(sp);
  return 1;
})()""")
time.sleep(0.4)
p.ev("document.getElementById('probe-spacer').style.height='200px'")
time.sleep(0.8)
g2 = json.loads(p.ev(GAP))
tt.check("上方内容变高后自动重新贴底", g2["gap"] <= 2, f"差 {g2['gap']}px")
tt.check("变高后最后一条仍然完整可见", (g2["hidden"] or -999) <= 2, f"露出输入区 {g2['hidden']}px")
p.ev("document.getElementById('probe-spacer')?.remove()")

# 用户主动往上翻之后，内容变高**不能**把他拽回底部。
# 判据用"没有往下变"，而不是"绝对值小于 N"—— 绝对值会随房间内容漂移，
# 上一版就因为固定房间名 + 残留历史触发 loadOlder 而偶发失败。
p.ev("document.getElementById('timeline').scrollTop = 0")
time.sleep(0.6)
before = p.ev("Math.round(document.getElementById('timeline').scrollTop)")
p.ev("""(() => {
  const inner = document.getElementById('tl-inner');
  const rows = [...inner.querySelectorAll('.msg')];
  const sp = document.createElement('div');
  sp.id = 'probe-spacer2';
  sp.style.cssText = 'height:0;overflow:hidden';
  rows[rows.length - 1].before(sp);
  return 1;
})()""")
time.sleep(0.3)
p.ev("document.getElementById('probe-spacer2').style.height='200px'")
time.sleep(0.9)
after = p.ev("Math.round(document.getElementById('timeline').scrollTop)")
tt.check("用户往上翻之后不会被强行拽回底部", after <= before + 2,
         f"翻上去 {before} → 内容变高后 {after}")
p.ev("document.getElementById('probe-spacer2')?.remove()")
# ---- 输入框定高不能靠「归零再量」，否则时间线每敲一个字就抖 26px ----
# ★ 回归断言。老写法 `ta.style.height='0px'` → 量 scrollHeight → 写回，
#   会让输入区在两帧之间"塌下去再撑回来"，浏览器随之把时间线顶走 26px
#   （内容高度一个像素都没变，纯粹是布局中间态惹的祸）。
#   现在改成离屏克隆体测量：测量过程不碰真实布局。
GROW_ROOM = f"输入框定高测试房-{int(time.time())}"
p.ev(f"window.__iroh_openRoom({json.dumps(GROW_ROOM)})")
tt.wait_until(p, f"window.__state && window.__state().joined === {json.dumps(GROW_ROOM)}", 90, label="定高测试房")
for i in range(8):
    p.ev(f"window.__iroh_sendText('定高垫消息 {i}')")
    time.sleep(0.45)
time.sleep(1.0)
INPUT_H = """(() => {
  const i = document.getElementById('input');
  return JSON.stringify({ h: Math.round(i.getBoundingClientRect().height),
    ov: i.style.overflowY, gap: Math.round((() => { const t = document.getElementById('timeline');
      return t.scrollHeight - t.clientHeight - t.scrollTop; })()) });
})()"""
def set_input(text):
    p.ev("(() => { const i = document.getElementById('input'); i.value = "
         + json.dumps(text) + "; i.dispatchEvent(new Event('input')); return 1; })()")
    time.sleep(0.4)
    return json.loads(p.ev(INPUT_H))

h1 = set_input("单行")
h3 = set_input("\n".join(["一行文字"] * 3))
h9 = set_input("\n".join(["一行文字"] * 9))
tt.check("输入框按内容长高（1 行）", 20 <= h1["h"] <= 40, f"{h1['h']}px")
tt.check("输入框 3 行时长高", h3["h"] > h1["h"] + 20, f"1行 {h1['h']}px → 3行 {h3['h']}px")
tt.check("输入框到上限就封顶并开滚动条", h9["h"] <= 134 and h9["ov"] == "auto",
         f"9行 {h9['h']}px overflow={h9['ov']}")
tt.check("输入框变高时时间线仍贴底（不抖）",
         h1["gap"] <= 2 and h3["gap"] <= 2 and h9["gap"] <= 2,
         f"gap {h1['gap']}/{h3['gap']}/{h9['gap']}")
# 清空输入框，别把内容留给后面
p.ev("(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); return 1; })()")
time.sleep(0.5)

p.call("Emulation.clearDeviceMetricsOverride")
time.sleep(0.5)

p.call("Emulation.clearDeviceMetricsOverride")
time.sleep(0.8)
tap.pump()
bad = [x for x in tap.lines if ("[exception]" in x or "[error]" in x) and "do_holepunching" not in x]
tt.check("控制台没有未捕获异常", not bad, "\n".join(x[:160] for x in bad[:5]))

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
