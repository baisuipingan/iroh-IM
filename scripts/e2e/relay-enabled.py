"""验证 `relay-config.json` 里的 `enabled: false` **真的会排除中继**。

## 为什么值得单独测

这个字段原来是个"哑开关"：
- `probe.js`（延迟探测）**会**过滤它；
- 但 `net.js` 把**全部** url 丢给 Rust，而 Rust 侧压根没有 `enabled` 这个概念。

结果：配置里把某台标成 `false`，探测不显示它，**连接时它照样是候选**、
照样可能被选成 home relay。一个看起来像开关、实际不生效的字段比没有更糟。

## 测试方式

临时改写 `frontend/relay-config.json`（本地 dev 服务直接服务这个目录），
断言有两种状态，**用 finally 保证还原**：

1. 禁用一台 → 状态页显示「已禁用」，且探测结果里没有它
2. 全部禁用 → 启动被拦下（不会拿空列表去 boot）
"""
import importlib.util, json, sys, time, pathlib

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOT = pathlib.Path(__file__).resolve().parents[2]
CFG = ROOT / "frontend" / "relay-config.json"
ORIGINAL = CFG.read_bytes()
SITE = "http://127.0.0.1:8099"
V = int(time.time())


def write_config(disable_ids):
    d = json.loads(ORIGINAL.decode("utf-8"))
    for r in d["relays"]:
        r["enabled"] = r["id"] not in disable_ids
    CFG.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def open_page(room, wait_join=True, timeout=120):
    url = f"{SITE}/?autostart=1&room={room}&testid=1&v={V}{room}"
    tab = tt.open_tab(url)
    page = tt.Page(tab["id"]); page.call("Runtime.enable")
    if wait_join:
        tt.wait_until(page, "!!(window.__state && window.__state().joined)", timeout, label=room)
    else:
        tt.wait_until(page, "!!window.__state", timeout, label=room)
    return tab, page


for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)

try:
    # ── 1) 禁用一台 → 状态页标「已禁用」 ─────────────────────────
    write_config({"fr-1"})
    tab, P = open_page("relayA", wait_join=True)
    time.sleep(2)
    P.ev("document.getElementById('tab-status').click()")
    time.sleep(1.2)

    rows = P.ev("""JSON.stringify([...document.querySelectorAll('#panel-body .relay')]
      .map(e => ({ id: e.querySelector('.relay__id')?.textContent,
                   st: e.querySelector('.relay__state')?.textContent })))""")
    # ⚠️ 所有要在页面上读的东西都必须在 close_tab **之前**读完 ——
    #    关掉标签后 CDP 会话随之关闭，再 `P.ev(...)` 会报 "连接关闭"。
    #    （踩过：把 close_tab 写在中间，后面的读取全崩，还以为是环境问题。）
    probes = json.loads(P.ev("JSON.stringify((window.__net.probes||[]).map(p=>p.id))") or "[]")
    tt.close_tab(tab["id"])
    data = {r["id"]: r["st"] for r in json.loads(rows)}
    tt.check("被禁用的中继在状态页标为「已禁用」", data.get("fr-1") == "已禁用", json.dumps(data, ensure_ascii=False))
    tt.check("未禁用的中继不标「已禁用」",
             data.get("hk-1") != "已禁用" and data.get("eu-1") != "已禁用",
             json.dumps(data, ensure_ascii=False))

    # 探测结果里不该出现被禁用的那台（probeAll 一直按 enabled 过滤）
    tt.check("延迟探测不包含被禁用的中继", "fr-1" not in probes, f"probes={probes}")

    # ── 2) 全部禁用 → 启动被拦下（而不是拿空列表去 boot）─────────
    write_config({"hk-1", "eu-1", "fr-1"})
    tab2, P2 = open_page("relayB", wait_join=False)
    time.sleep(6)
    joined = P2.ev("(window.__state && window.__state().joined) || ''")
    node = P2.ev("(window.__state && window.__state().node) || ''")
    body = P2.ev("document.body.innerText.replace(/\\n+/g,' | ').slice(0,160)")
    tt.close_tab(tab2["id"])
    tt.check("全部禁用时不会真的进房（boot 被拦下）", joined in ("", "None", "null"), f"joined={joined!r}")
    tt.check("全部禁用时给出「节点启动失败」而不是静默卡住",
             "启动失败" in (node or "") or "启动失败" in (body or ""),
             f"node={node!r} body={body!r}")
finally:
    # ⚠️ 无论如何都要还原 —— 这个测试会改磁盘上的真实配置文件
    CFG.write_bytes(ORIGINAL)
    restored = CFG.read_bytes() == ORIGINAL
    print(f"  {'✅' if restored else '❌'} relay-config.json 已还原")
    if not restored:
        tt.check("配置文件已还原", False, "还原失败，请手动 git checkout frontend/relay-config.json")

print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
