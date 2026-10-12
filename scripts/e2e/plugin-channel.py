"""前端插件通道：**新能力的事件要被认领，没人认领也不能出事**。

## 为什么单独立一条

`RoomEvent::Plugin` 是"万物皆插件"的客户端半边：Rust 侧任何新能力都能发它，
但在这条用例之前，前端**没有任何 case 接它** —— 事件到了浏览器直接掉进
`net.js` 的 default 被丢掉。于是每加一个能力都得改核心的几个文件，
"插件"名不副实。

判据（三条）：
  ① 走**真路径**投递（`net._dispatch`，即 Worker 事件到达时走的那条）能被注册的插件收到；
  ② 没人认领的名字**不报错、不弹提示**，但要进 `unhandled()` 计数（诊断不能丢）；
  ③ 插件自己的处理器抛错**不能影响别人**（第二个插件照样收到）。
"""
import importlib.util, sys, time, json, os

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

V = int(time.time())
ROOM = f"plg{V % 100000}"
SITE = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")

for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(1)

tab = tt.open_tab(f"{SITE}/?autostart=1&room={ROOM}&testid=1")
p = tt.Page(tab["id"]); p.call("Runtime.enable"); p.call("Page.enable")
tt.wait_until(p, "!!(window.__state && window.__state().joined)", 120, label="join")

# 钩子要在（新加的注册表得真的挂到 window 上）
tt.check("插件注册表钩子存在", p.ev("typeof window.__iroh_plugins === 'object'") is True)
tt.check("事件总线认得 plugin 这个名字",
         p.ev("!!window.__iroh_plugins && typeof window.__iroh_plugins.register === 'function'") is True)

# ① 没人认领：不报错、进计数
errs = []
p.ev("window.__err0 = []; window.addEventListener('error', e => window.__err0.push(String(e.message)))")
p.ev("window.__iroh_net._dispatch({type: 'plugin', name: 'nobody-registered-this', payload: {n: 1}})")
time.sleep(0.3)
tt.check("没人认领的事件被记进 unhandled()",
         p.ev("window.__iroh_plugins.unhandled()['nobody-registered-this']") == 1,
         f"unhandled={p.ev('JSON.stringify(window.__iroh_plugins.unhandled())')}")
tt.check("没人认领不会抛页面错误", p.ev("window.__err0.length") == 0)

# ② 注册了就能收到（走的是 Worker 事件那条真路径）
p.ev("window.__got = null; window.__un = window.__iroh_plugins.register('demo', {onEvent: (pl, meta) => { window.__got = {pl, meta}; }})")
p.ev("window.__iroh_net._dispatch({type: 'plugin', name: 'demo', payload: {n: 42, who: 'roomd'}})")
time.sleep(0.3)
got = json.loads(p.ev("JSON.stringify(window.__got)") or "null")
tt.check("注册后能收到 payload", got and got["pl"] == {"n": 42, "who": "roomd"}, f"got={got}")
tt.check("同时拿到插件名（便于一个处理器服务多个名字）",
         got and got["meta"]["name"] == "demo", f"meta={got.get('meta') if got else None}")
tt.check("注册之后不再计入 unhandled",
         "demo" not in (p.ev("JSON.stringify(window.__iroh_plugins.unhandled())") or "{}"))

# ③ 一个插件抛错不影响别人
p.ev("""window.__got2 = null;
window.__iroh_plugins.register('boom', {onEvent: () => { throw new Error('插件自己炸了'); }});
window.__iroh_plugins.register('ok2', {onEvent: (pl) => { window.__got2 = pl; }});""")
p.ev("window.__iroh_net._dispatch({type: 'plugin', name: 'boom', payload: {}})")
p.ev("window.__iroh_net._dispatch({type: 'plugin', name: 'ok2', payload: {alive: true}})")
time.sleep(0.3)
tt.check("别人家的插件抛错不影响我", json.loads(p.ev("JSON.stringify(window.__got2)") or "null") == {"alive": True})

# ④ 注销之后事件回到 unhandled（"卸载插件"这条路是通的）
p.ev("window.__un()")
p.ev("window.__iroh_net._dispatch({type: 'plugin', name: 'demo', payload: {n: 1}})")
time.sleep(0.3)
tt.check("注销后重新变成没人认领",
         p.ev("window.__iroh_plugins.unhandled()['demo']") == 1)

tt.check("已注册列表能列出来", sorted(json.loads(p.ev("JSON.stringify(window.__iroh_plugins.list())"))) == ["boom", "ok2"],
         f"list={p.ev('JSON.stringify(window.__iroh_plugins.list())')}")
tt.check("无未处理页面异常", p.ev("window.__err0.length") == 0)

tt.close_tab(tab["id"])
print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
