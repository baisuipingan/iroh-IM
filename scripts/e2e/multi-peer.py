"""三份独立浏览器存储：互发、晚加入历史、自动补漏和时间线竞态。"""

import importlib.util
import json
import os
import sys
import time

saved_args = sys.argv
sys.argv = ["multi-peer"]
spec = importlib.util.spec_from_file_location("transfer_test", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tt)
sys.argv = saved_args
tt.CDP = os.environ.get("E2E_CDP", "http://127.0.0.1:9222")
site = os.environ.get("E2E_SITE", "http://127.0.0.1:8099")
room = f"multi-peer-{time.time_ns()}"


class Browser(tt.Page):
    def __init__(self):
        self.ws = tt.WS(tt.http_json(tt.CDP + "/json/version")["webSocketDebuggerUrl"])
        self._id = 0


browser = Browser()
contexts = []


def wait_until(page, expression, timeout):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = page.ev(expression)
            if last:
                return last
        except Exception as error:
            last = str(error)
        time.sleep(0.4)
    raise TimeoutError(f"等待超时：{expression}（最后 {last!r}）")


def boot(fail_history=False):
    context = browser.call("Target.createBrowserContext")["browserContextId"]
    contexts.append(context)
    target = browser.call("Target.createTarget", {"url": "about:blank", "browserContextId": context})
    page = tt.Page(target["targetId"])
    page.call("Page.enable")
    page.call("Runtime.enable")
    if fail_history:
        page.call("Page.addScriptToEvaluateOnNewDocument", {"source": """
          const timer = setInterval(() => {
            if (!window.__iroh_net) return;
            clearInterval(timer);
            const original = window.__iroh_net.history.bind(window.__iroh_net);
            let failures = 1;
            window.__iroh_net.history = (...args) => {
              if (failures-- > 0) return Promise.reject(new Error('injected history failure'));
              return original(...args);
            };
          }, 0);
        """})
    page.call("Page.navigate", {"url": f"{site}/?autostart=1&room={room}"})
    wait_until(page, f"window.__state?.().joined === {json.dumps(room)}", 120)
    return page


def texts(page):
    state = page.ev("window.__state()")
    return state["messages"] + state["mine"]


try:
    first = boot()
    second = boot()
    first.ev("window.__iroh_sendText('before-first')")
    second.ev("window.__iroh_sendText('before-second')")
    first.ev(f"window.__iroh_sendFile(window.__iroh_makeFile('multi-peer.bin', 64), {json.dumps(room)})")
    wait_until(first, f"window.__iroh_net.history({json.dumps(room)}, 50).then(messages => "
                  "messages.some(message => message.text === 'before-second') && "
                  "messages.some(message => message.file?.name === 'multi-peer.bin'))", 40)

    third = boot(fail_history=True)
    pages = [first, second, third]
    identities = [page.ev("window.__state().myId") for page in pages]
    tt.check("独立存储生成三个不同身份", len(set(identities)) == 3)
    wait_until(third, "window.__state().messages.includes('before-first') && "
                  "window.__state().messages.includes('before-second')", 45)
    tt.check("第三人历史失败后自动重试", "before-second" in texts(third))
    wait_until(third, "[...document.querySelectorAll('.filecard__name')].some(element => "
                  "element.textContent === 'multi-peer.bin')", 15)
    tt.check("第三人加载历史文件卡片", True)

    for index, page in enumerate(pages):
        page.ev(f"window.__iroh_sendText('live-{index}')")
    for index, page in enumerate(pages):
        wait_until(page, "['live-0','live-1','live-2'].every(text => "
                      "[...window.__state().messages, ...window.__state().mine].includes(text))", 30)
        tt.check(f"用户 {index + 1} 收齐三方消息", True)
        wait_until(page, f"import('./js/ui/sidebar.js').then(({{sidebar}}) => "
                      f"{json.dumps([identity for identity in identities if identity != identities[index]])}"
                      ".every(identity => sidebar.peers.some(peer => peer.id === identity)))", 30)
        # 「在线成员」页已合并进「连接状态页」：点开名单，**数真实人头**
        # （原来是读一个小标题里的数字，现在直接数行，更结实）
        page.ev("document.getElementById('tab-status').click()")
        page.ev("document.querySelector('[data-expand=\"members\"]')?.click()")
        wait_until(page, "document.querySelectorAll('#status-members .member').length === 3", 20)
        rows = page.ev("document.querySelectorAll('#status-members .member').length")
        tt.check(f"用户 {index + 1} 成员名单列出三人（排除常驻节点）", rows == 3, f"{rows} 行")
        # ⚠️ 状态页改版（比奇堡设计稿 _1）后，"房间人数"从 `.kv` 行换成了
        #    `.stat` 卡片行（标签在 `.stat__label`、取值在右侧的药丸里）。
        #    断言的原意不变：**状态页要能区分"房间人数"和"Gossip 邻居"** ——
        #    这两个数在旧版曾长期混为一谈。
        count = page.ev("""(() => {
          const row = [...document.querySelectorAll('#panel-body .stat')]
            .find(r => r.querySelector('.stat__label')?.textContent === '在线成员');
          return row ? row.querySelector('.state-pill')?.textContent.trim() : 'MISSING';
        })()""")
        # 药丸现在只有数字（"含自己"在下面那行说明里），所以这里比 "3 人"
        tt.check(f"用户 {index + 1} 状态页区分人数和邻居", count == "3 人", count)

    third.ev("""(() => {
      const original = window.__iroh_net._dispatch.bind(window.__iroh_net);
      window.__iroh_net._dispatch = event => {
        if (event.type === 'message' && event.message.text === 'dropped-live') return;
        original(event);
      };
    })()""")
    first.ev("window.__iroh_sendText('dropped-live')")
    wait_until(third, "window.__state().messages.includes('dropped-live')", 35)
    tt.check("丢失实时广播后自动从历史补齐且不重复", texts(third).count("dropped-live") == 1)
    isolated = third.ev("""(async () => {
      const { sidebar } = await import('./js/ui/sidebar.js');
      const { bus, EV } = await import('./js/bus.js');
      const before = sidebar.peers.map(peer => peer.id).join(',');
      bus.emit(EV.PRESENCE, {room:'other-room',peers:[{id:'foreign',nickname:'foreign'}]});
      return before === sidebar.peers.map(peer => peer.id).join(',');
    })()""")
    tt.check("旧房间成员事件不覆盖当前房间", isolated)

    result = third.ev("""(async () => {
      const { timeline } = await import('./js/ui/timeline.js');
      const { net } = await import('./js/net.js');
      const original = net.history;
      try {
        timeline.open('isolated-ui-regression', window.__state().myId);
        let release;
        net.history = () => new Promise(resolve => { release = resolve; });
        const loading = timeline.loadLatest();
        timeline.push({id:'live',from:'other',nickname:'Live',text:'new-live',ts:2000}, false);
        release([
          {id:'old',from:'other',nickname:'Old',text:'old-history',ts:1000},
          {id:'proof',from:'other',nickname:'File',text:'',ts:1500,
           file:{file_id:'f'.repeat(32),name:'older.bin',size:64}},
          {id:'live',from:'other',nickname:'Live',text:'new-live',ts:2000}
        ]);
        await loading;
        const ordered = [...document.querySelectorAll('.msg[data-ts]')].map(element => element.dataset.id);
        const fileCards = document.querySelectorAll('.msg--file').length;
        const baseline = {id:'base',from:'other',nickname:'Base',text:'base',ts:3000};
        const backlog = [baseline, ...Array.from({length:120}, (_, index) => ({
          id:`backlog-${String(index).padStart(3,'0')}`,from:'other',nickname:'Backlog',
          text:`backlog-${index}`,ts:4000 + index
        }))];
        timeline.open('isolated-gap-regression', window.__state().myId);
        net.history = async () => [baseline];
        await timeline.loadLatest();
        let pageCount = 0;
        net.history = async (room, limit, before) => {
          pageCount++;
          const timestamp = before ? Number(before.split(':')[0]) : Infinity;
          return backlog.filter(message => message.ts < timestamp).slice(-limit);
        };
        await timeline.loadLatest({silent:true});
        const recovered = document.querySelectorAll('.bubble').length;
        net.history = async () => [{id:'older-proof',from:'other',nickname:'File',text:'',ts:2000,
          file:{file_id:'e'.repeat(32),name:'history-older.bin',size:64}}];
        await timeline.loadOlder();
        const olderFile = document.querySelector('.msg[data-ts]').dataset.id === 'older-proof';
        timeline.open('generation-a', window.__state().myId);
        net.history = () => new Promise(resolve => { release = resolve; });
        const stale = timeline.loadLatest();
        timeline.open('generation-b', window.__state().myId);
        timeline.open('generation-a', window.__state().myId);
        release([{id:'stale',from:'other',nickname:'Stale',text:'stale',ts:1000}]);
        await stale;
        const staleCount = document.querySelectorAll('.bubble').length;
        return {ordered,fileCards,pageCount,recovered,staleCount,olderFile};
      } finally {
        net.history = original;
        timeline.close();
      }
    })()""")
    tt.check("慢历史与实时消息按时间合并并去重", result["ordered"] == ["old", "proof", "live"], str(result))
    tt.check("历史文件插入正确位置", result["fileCards"] == 1)
    tt.check("超过一页的断档全部补齐", result["recovered"] == 121 and result["pageCount"] == 3)
    tt.check("上拉历史页也恢复文件卡片", result["olderFile"])
    tt.check("A→B→A 时丢弃旧历史请求", result["staleCount"] == 0)
finally:
    for context in contexts:
        browser.call("Target.disposeBrowserContext", {"browserContextId": context})

print(f"\n总计 PASS={tt.PASS} FAIL={tt.FAIL}", flush=True)
sys.exit(1 if tt.FAIL else 0)
