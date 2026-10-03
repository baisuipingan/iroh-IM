#!/usr/bin/env python3
"""浏览器端「断点续传」端到端验证（零依赖，直连 Chrome DevTools Protocol）。

## 为什么要让发送方真的断

手工塞一个"半截文件"进去，只能证明"能补块"，证明不了
「真断了之后位图确实落了盘、下一轮真的只补缺的那部分」。
所以这里用 wasm 内置测试钩子 `set_stop_after_chunks(n)`，
让**发送方真的只发前 n 块就异常断开**，全走真实网络路径：

  第 1 轮  只发 32/64 块 → 断连
           → 接收方应走失败分支，把「已收 32 块」位图写进 IndexedDB
  第 2 轮  解除限制重发 → 接收方读回位图
           → **只写缺失的 32 块**（断言写入次数 ≈ 32，而不是 64）
           → 最终文件逐字节等于发送方源文件

## 前置

  1. scripts/dev-serve.py 在 8099 跑着（或传端口）
  2. Chrome 带 --remote-debugging-port=9222
  3. 页面 ?testid=1（两标签用不同随机身份，否则是同一个"人"）

用法：python3 scripts/transfer-test.py [端口]
"""
import base64
import json
import os
import socket
import struct
import sys
import time
import re
import traceback
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
BASE = f"http://127.0.0.1:{PORT}/"
CDP = "http://127.0.0.1:9222"

# 本机端口必须绕开沙箱代理（否则被拦成 502）
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url, method="GET"):
    req = urllib.request.Request(url, method=method)
    with _opener.open(req, timeout=5) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else {}


# ---------------------------------------------------------------------------
# 极简 WebSocket 客户端（标准库没有，手写握手 + 帧）
# ---------------------------------------------------------------------------


class WS:
    def __init__(self, url):
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        path = "/" + path
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\nHost: {hostport}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        assert b"101" in buf.split(b"\r\n")[0], f"握手失败: {buf[:200]!r}"
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, obj):
        payload = json.dumps(obj).encode()
        h = bytearray([0x81])
        n = len(payload)
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h.append(0x80 | 126)
            h += struct.pack(">H", n)
        else:
            h.append(0x80 | 127)
            h += struct.pack(">Q", n)
        mask = os.urandom(4)
        h += mask
        self.sock.sendall(bytes(h) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read(self, n):
        while len(self.buf) < n:
            c = self.sock.recv(65536)
            if not c:
                raise ConnectionError("连接关闭")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b1, b2 = self._read(2)
        opcode, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8))[0]
        mask = self._read(4) if masked else b""
        data = self._read(n)
        if masked:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if opcode == 0x8:
            raise ConnectionError("对端关闭")
        if opcode == 0x1:
            return json.loads(data)
        return self.recv()


class Page:
    def __init__(self, target_id):
        info = [t for t in http_json(CDP + "/json/list") if t["id"] == target_id][0]
        self.ws = WS(info["webSocketDebuggerUrl"])
        self._id = 0

    def call(self, method, params=None, timeout=30):
        self._id += 1
        mid = self._id
        self.ws.send({"id": mid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.ws.recv()
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result")
        raise TimeoutError(f"{method} 超时")

    def ev(self, expr, timeout=30):
        r = self.call(
            "Runtime.evaluate",
            {"expression": expr, "awaitPromise": True, "returnByValue": True},
            timeout=timeout,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(f"JS 异常: {d.get('text')} {d.get('exception', {}).get('description', '')}")
        return r.get("result", {}).get("value")

    def fire(self, expr, timeout=15):
        """只触发、不等 Promise —— 用于「整个传输才 resolve」的调用
        （如 __acceptFile）。等它会把调用方卡死到传输结束。"""
        r = self.call(
            "Runtime.evaluate",
            {"expression": expr, "awaitPromise": False, "returnByValue": True},
            timeout=timeout,
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError(f"JS 异常: {d.get('text')} {d.get('exception', {}).get('description', '')}")
        return r.get("result", {}).get("value")


def open_tab(url):
    # ⚠️ 必须对 url 做百分号编码：`/json/new?<url>` 里若原样带 `?` / `&`，
    # Chrome 会把它们当成 `/json/new` 自己的查询参数，结果只打开了裸首页
    # （表现为"两个标签 id 相同、没进房间"）。
    return http_json(CDP + "/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")


def close_tab(tid):
    try:
        http_json(CDP + f"/json/close/{tid}")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 断言
# ---------------------------------------------------------------------------

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}" + (f"  ({detail})" if detail else ""), flush=True)
    else:
        FAIL += 1
        print(f"  ❌ {name}  ({detail})", flush=True)


def wait_until(page, expr, timeout=40, interval=0.4, label=""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = page.ev(expr)
        except Exception as e:
            last = f"<err {e}>"
        if last:
            return last
        time.sleep(interval)
    raise TimeoutError(f"等待超时：{label or expr}（最后 {last!r}）")


class LogTap:
    """旁挂一个 CDP 连接专门收 console / 异常（Page.recv 会丢事件，
    所以单独开一条只读连接）。"""

    def __init__(self, target_id):
        info = [t for t in http_json(CDP + "/json/list") if t["id"] == target_id][0]
        self.ws = WS(info["webSocketDebuggerUrl"])
        self._id = 0
        self.lines = []
        self.ws.send({"id": 1, "method": "Runtime.enable"})
        self._id = 1
        self.ws.sock.settimeout(0.05)

    def pump(self):
        """非阻塞地抽干已到达的日志"""
        while True:
            try:
                msg = self.ws.recv()
            except socket.timeout:
                return
            except Exception:
                return
            if msg.get("method") == "Runtime.consoleAPICalled":
                args = []
                for a in msg["params"].get("args", []):
                    args.append(str(a.get("value", a.get("description", ""))))
                self.lines.append(f"[{msg['params'].get('type')}] " + " ".join(args))
            elif msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"].get("exceptionDetails", {})
                self.lines.append(f"[exception] {d.get('text')} {d.get('exception', {}).get('description', '')}")

    def dump(self, tag="", keep=None):
        """keep: 正则，只打印匹配的行（过滤 iroh 的 NAT 噪音）"""
        self.pump()
        print(f"\n--- {tag} console ---", flush=True)
        shown = 0
        for ln in self.lines[-400:]:
            if "[debug]" in ln and "do_holepunching" in ln:
                continue  # relay 模式下的正常噪音
            if keep and not re.search(keep, ln):
                continue
            print("   ", ln[:1800], flush=True)
            shown += 1
        if not shown:
            print("    (无匹配)", flush=True)
        self.lines.clear()


# ---------------------------------------------------------------------------
# 注入到接收端的「内存假句柄」
#
# 无头环境没有系统保存对话框，但除此之外全部走真实 API 语义：
#   - getFile().size 返回**已写入的高水位**（模拟真实半截文件的大小）
#     ⚠️ 这点很关键：若返回满额大小，会被"目标比源还大 → 不是同一文件 → 忽略位图"
#        的逻辑挡掉，断点续传根本不会发生。
#   - createWritable({keepExistingData}) 时保留已写内容
#   - write({position, data}) 按偏移写入，并统计调用次数/序号
# ---------------------------------------------------------------------------

MOCK_JS = r"""
(() => {
  // ⚠️ 测试必须走 **OPFS 真实句柄**。
  //
  // 产品用的是 `showSaveFilePicker` 返回的 `FileSystemFileHandle`，
  // 它**可结构化克隆**（能 postMessage 进 Worker，已实测）。
  // 而自己造的"带方法的普通对象"**不可克隆** —— 会报
  //   "could not be cloned"
  // （因为函数不是可克隆类型）。所以这里不造假句柄，
  // 只把开关打开，让 Worker 自己用 OPFS 造一个真句柄（同类型、同 API）。
  window.__useOpfs = true;
  window.__writeLog = window.__writeLog || [];
  window.__mockFilePicker = async () => {
    throw new Error('本测试走 OPFS，不应调用 picker');
  };
  return true;
})()
"""

# 老版假句柄实现（内存 Map）留作参考，Worker 化后不再使用。
# 它的问题正是上面说的"不可克隆"。
_LEGACY_MOCK_JS = r"""
(() => {
  const CHUNK = 16384;
  const files = (window.__mockFiles = window.__mockFiles || new Map());
  window.__writeLog = window.__writeLog || [];
  window.__mockFilePicker = async (name, size) => {
    let f = window.__mockFiles.get(name);
    if (!f) {
      f = { buf: new Uint8Array(size), high: 0 };
      window.__mockFiles.set(name, f);
    }
    return {
      getFile: async () => ({ size: f.high, name }),
      createWritable: async (opts) => ({
        async write(arg) {
          const { position, data } = arg;
          f.buf.set(data, position);
          f.high = Math.max(f.high, position + data.length);
          window.__writeLog.push(Math.round(position / CHUNK));
        },
        async close() {},
      }),
    };
  };
  return true;
})()
"""

# 只重置「本轮写入日志」，保留文件内容
COUNT_JS = r"""
(() => {
  window.__writeLog = [];
  return true;
})()
"""


def main():
    # ① 清场：关掉所有本机旧标签（踩过坑：遗留标签互相抢事件）
    for t in http_json(CDP + "/json/list"):
        if t["type"] == "page" and "127.0.0.1" in t.get("url", ""):
            close_tab(t["id"])
    time.sleep(1)

    ROOM = "xfer-test"
    V = int(time.time() * 1000)
    SIZE = 1024 * 1024
    CHUNK = 16 * 1024
    TOTAL = SIZE // CHUNK  # 64
    STOP = 32

    print("== 打开两个标签（发送端 / 接收端）==", flush=True)
    tx_tab = open_tab(f"{BASE}?autostart=1&room={ROOM}&testid=1&v={V}a")
    rx_tab = open_tab(f"{BASE}?autostart=1&room={ROOM}&testid=1&v={V}b")
    tx, rx = Page(tx_tab["id"]), Page(rx_tab["id"])
    for p in (tx, rx):
        p.call("Runtime.enable")
    txlog, rxlog = LogTap(tx_tab["id"]), LogTap(rx_tab["id"])

    for name, p in (("发送端", tx), ("接收端", rx)):
        # ⚠️ 必须等 `joined`（房间 join 真正完成），不能只等 `node==='在线'`：
        #    后者只表示中继握手成功，此时 autostart 里的 join 还没跑完，
        #    立刻发文件会撞上「还没进房间」。
        wait_until(
            p,
            f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})",
            60,
            label=f"{name}进房完成",
        )
        print(f"  {name} 已进房并上线", flush=True)

    print(f"  发送端 id = {tx.ev('window.__state().myId')[:16]}…", flush=True)
    print(f"  接收端 id = {rx.ev('window.__state().myId')[:16]}…", flush=True)

    # ② 设置测试模式（走 OPFS 真实句柄）+ 开写入日志
    rx.ev(MOCK_JS)
    rx.ev("window.__setTestMode(true)")
    print("  接收端已开启测试模式（OPFS 真实句柄 + 写入日志）", flush=True)

    # ③ 发送端构造确定性文件：第 i 块填充 (i & 0xff)
    tx.ev(
        f"""
        (() => {{
          const u = new Uint8Array({SIZE});
          for (let i = 0; i < {SIZE}; i++) u[i] = ((i / {CHUNK}) | 0) & 0xff;
          window.__testFile = new File([u], 'resume.bin', {{ type: 'application/octet-stream' }});
          return window.__testFile.size;
        }})()
        """,
        timeout=30,
    )
    # ⚠️ `__clearBitmaps` 现在是异步的（要走 Worker RPC），必须 await
    rx.ev("window.__clearBitmaps && window.__clearBitmaps()", timeout=30)
    print(f"  已构造 {SIZE} 字节测试文件（{TOTAL} 块）", flush=True)

    # ---------------------------------------------------------------- 第 1 轮
    print(f"\n== 第 1 轮：发送方只发 {STOP}/{TOTAL} 块后异常断开 ==", flush=True)
    tx.ev(f"window.__setStopAfterChunks({STOP})")
    tx.ev("window.__sendFile(window.__testFile, 'xfer-test')")

    wait_until(
        rx,
        "window.__transfers().some(t => t.direction==='recv' && t.state==='invited')",
        30,
        label="接收端收到邀约",
    )
    fid = rx.ev("window.__transfers().find(t => t.direction==='recv').file_id")
    print(f"  收到邀约 file_id = {fid}", flush=True)

    rx.ev(COUNT_JS)  # 重置写入统计
    rx.fire(f"window.__acceptFile({json.dumps(fid)})")

    # ⚠️ 必须轮询等「第 1 轮真的结束」，不能固定 sleep：
    #    实测传输速度受日志/回调往返影响，6 秒可能连一半都没走完，
    #    那样第 2 轮会在第 1 轮还没结束时开跑，结论完全不可信。
    def settled(expr, timeout, label):
        try:
            wait_until(rx, expr, timeout, interval=0.5, label=label)
            return True
        except TimeoutError as e:
            print(f"  ⚠️ {e}", flush=True)
            return False

    settled(
        "!window.__transfers().some(t => t.state === 'active')",
        120,
        "第 1 轮结束（两端都不再 active）",
    )
    time.sleep(1)
    r1_writes = rx.ev("window.__writeLog.length")
    print(f"  第 1 轮实际写入块数 = {r1_writes}", flush=True)
    check("第 1 轮：只收到部分块（不是全部）", 0 < (r1_writes or 0) < TOTAL, f"{r1_writes}/{TOTAL}")
    print("  发送端传输状态:", tx.ev("JSON.stringify(window.__transfers())"), flush=True)
    print("  接收端传输状态:", rx.ev("JSON.stringify(window.__transfers())"), flush=True)
    txlog.dump("发送端", keep="测试钩子|开始发送|补发|发送完成|失败|ERROR|WARN")
    rxlog.dump("接收端", keep="数据不完整|校验|失败|中断|ERROR|WARN")

    keys = rx.ev("window.__pendingBitmaps()")
    print(f"  IndexedDB 断点位图 key = {keys}", flush=True)
    check("第 1 轮：断点位图已落盘", bool(keys), f"{len(keys or [])} 条")

    # ---------------------------------------------------------------- 第 2 轮
    print(f"\n== 第 2 轮：解除限制重发，应只补缺的块 ==", flush=True)
    tx.ev("window.__setStopAfterChunks(0)")

    # 记录第 1 轮结束时接收端已确认的块数（来自位图，最可信）
    have1 = rx.ev(
        r"""
        (async () => {
          const keys = await window.__pendingBitmaps();
          if (!keys.length) return 0;
          const b64 = await new Promise((res) => {
            const req = indexedDB.open('iroh-transfers', 1);
            req.onsuccess = () => {
              const g = req.result.transaction('bitmaps','readonly').objectStore('bitmaps').get(keys[0]);
              g.onsuccess = () => res(g.result.have);
            };
          });
          const raw = atob(b64);
          let n = 0;
          for (const ch of raw) { let v = ch.charCodeAt(0); while (v) { n += v & 1; v >>= 1; } }
          return n;
        })()
        """,
        timeout=15,
    )
    print(f"  第 1 轮位图记录块数 = {have1}", flush=True)

    rx.ev(COUNT_JS)  # 重置本轮写入统计（不动文件内容）
    rx.fire(f"window.__acceptFile({json.dumps(fid)})")

    # 等第 2 轮真正收完（状态变 done，或长时间不再有新的写入）
    deadline = time.time() + 180
    last_n, stable = -1, 0
    while time.time() < deadline:
        st = rx.ev("JSON.stringify(window.__transfers().map(t=>t.state))")
        n = rx.ev("window.__writeLog.length")
        if "done" in st and n == last_n:
            break
        stable = stable + 1 if n == last_n else 0
        if stable >= 6:  # 连续 3 秒没新写入 → 认为停了
            break
        last_n = n
        time.sleep(0.5)

    r2_writes = rx.ev("window.__writeLog.length")
    seqs = json.loads(rx.ev("JSON.stringify(window.__writeLog)") or "[]")
    print(f"  第 2 轮实际写入块数 = {r2_writes}", flush=True)
    print(f"  第 2 轮写入的块序号 = {sorted(seqs)}", flush=True)
    print("  接收端最终状态:", rx.ev("JSON.stringify(window.__transfers())"), flush=True)
    print("  发送端最终状态:", tx.ev("JSON.stringify(window.__transfers())"), flush=True)

    # ⚠️ 关心点：接收端 done 之后，发送端要多久才变 done？
    # 这是「接收端已完成、发送端还显示传输中」那个体感问题的量化。
    t0 = time.time()
    settled_ok = False
    try:
        wait_until(
            tx,
            "window.__transfers().every(t => t.state !== 'active')",
            130,
            interval=0.5,
            label="发送端脱离 active",
        )
        elapsed = time.time() - t0
        print(f"  发送端脱离「传输中」耗时 {elapsed:.1f}s", flush=True)
        settled_ok = True
    except TimeoutError as e:
        print(f"  ⚠️ {e}", flush=True)
    tx_final = json.loads(tx.ev("JSON.stringify(window.__transfers())") or "[]")
    print("  发送端脱离后状态:", json.dumps(tx_final, ensure_ascii=False), flush=True)

    check(
        "发送端最终进入终态（不再卡在「传输中」）",
        settled_ok and all(t["state"] != "active" for t in tx_final),
        json.dumps([t["state"] for t in tx_final]),
    )
    check(
        "发送端最终状态为 done",
        all(t["state"] == "done" for t in tx_final),
        json.dumps([t["state"] for t in tx_final]),
    )

    txlog.dump("发送端", keep="测试钩子|开始发送|补发|发送完成|失败|回执|ERROR|WARN")
    rxlog.dump("接收端", keep="数据不完整|校验|失败|中断|ERROR|WARN")

    missing = TOTAL - (have1 or 0)
    check(
        "第 2 轮：只补缺失块（不是全量重传）",
        r2_writes is not None and r2_writes <= missing + 3,
        f"补 {r2_writes} 块，缺口 {missing} 块，全量是 {TOTAL}",
    )

    # ---------------------------------------------------------- 逐字节校验
    print("\n== 逐字节校验最终文件 ==", flush=True)
    # Worker 化之后文件存在 OPFS 里（接收在 Worker 内完成），由 Worker 读回并校验
    res = rx.ev(f"window.__verifyOpfs('resume.bin', {SIZE}, {CHUNK})")
    print(f"  校验结果: {res}", flush=True)
    check("最终文件逐字节正确", bool(res and res.get("ok")), str(res))

    close_tab(tx_tab["id"])
    close_tab(rx_tab["id"])

    print(f"\n{'=' * 46}\n通过 {PASS} / 失败 {FAIL}", flush=True)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        traceback.print_exc()
        print(f"\n测试异常终止: {e}")
        sys.exit(2)
