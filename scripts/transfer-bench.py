#!/usr/bin/env python3
"""文件传输吞吐基准：定位「慢」到底慢在哪一段。

## 为什么要分两种 sink 对照

「慢」可能是三处：
  1. 网络/中继（数据面）—— 两个端都经香港中继，RTT ~80ms
  2. wasm↔JS 的每块回调往返
  3. 接收方写盘（File System Access API 的 writable.write）

只跑真实文件看不出差别。所以用**两种 sink 做对照**：
  - `mem` ：纯内存假句柄 —— 完全排除写盘因素
  - `opfs`：真实 `FileSystemFileHandle`（`navigator.storage.getDirectory()`），
           `createWritable()` 与用户真实保存路径**是同一套 API**，但不需要弹系统对话框

两者吞吐如果一样 → 瓶颈在网络；如果 opfs 明显慢 → 瓶颈在写盘。

还会记录**每块到达的时间间隔**：若间隔≈RTT（80ms），说明一次只有一个块在飞，
是流控/往返在拖后腿；若间隔很小但总量上不去，则是别的原因。

用法：
    python3 scripts/transfer-bench.py [端口] [大小MB] [mem|opfs]
"""
import importlib.util
import json
import statistics
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
SIZE_MB = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
MODE = sys.argv[3] if len(sys.argv) > 3 else "mem"
FOCUS = int(sys.argv[4]) if len(sys.argv) > 4 else 0
# 必须与 wasm 侧 `filetransfer::CHUNK_SIZE` 一致
CHUNK = 16 * 1024
SIZE = int(SIZE_MB * 1024 * 1024)
TOTAL = SIZE // CHUNK

spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tt)


PICKER_MEM = r"""
(() => {
  const CHUNK = 16384;
  window.__bytes = new Map();
  window.__writeLog = [];
  window.__mockFilePicker = async (name, size) => {
    let f = window.__bytes.get(name);
    if (!f) { f = { buf: new Uint8Array(size), high: 0 }; window.__bytes.set(name, f); }
    return {
      getFile: async () => ({ size: f.high, name }),
      createWritable: async () => ({
        async write(arg) {
          f.buf.set(arg.data, arg.position);
          f.high = Math.max(f.high, arg.position + arg.data.length);
          window.__writeLog.push([arg.position / CHUNK, performance.now()]);
        },
        async close() {},
      }),
    };
  };
  return true;
})()
"""

PICKER_OPFS = r"""
(async () => {
  const CHUNK = 16384;
  window.__writeLog = [];
  const root = await navigator.storage.getDirectory();
  window.__mockFilePicker = async (name, size) => {
    const fh = await root.getFileHandle(name, { create: true });
    const orig = fh.createWritable.bind(fh);
    fh.createWritable = async (opts) => {
      const w = await orig(opts);
      const ow = w.write.bind(w);
      w.write = async (arg) => {
        window.__writeLog.push([arg.position / CHUNK, performance.now()]);
        return ow(arg);
      };
      return w;
    };
    return fh;
  };
  return true;
})()
"""


PICKER_NOOP = r"""
(() => {
  // 空实现：不拷贝、不记录，只返回一个已 resolve 的 Promise。
  // 用于回答"接收端慢在 JS 回调，还是在 wasm 的 QUIC 收包"。
  window.__writeLog = [];
  window.__mockFilePicker = async (name, size) => ({
    getFile: async () => ({ size, name }),
    createWritable: async () => ({
      async write() {},
      async close() {},
    }),
  });
  return true;
})()
"""


def main() -> int:
    print(f"== 基准：{SIZE_MB}MB（{TOTAL} 块）sink={MODE} ==", flush=True)

    for t in tt.http_json(tt.CDP + "/json/list"):
        if t["type"] == "page" and ("127.0.0.1" in t.get("url", "") or "editor.vip" in t.get("url", "") or "localhost" in t.get("url", "")):
            tt.close_tab(t["id"])
    time.sleep(1)

    # ⚠️ 必须清缓存：Chrome 会把 `net.js`（ES 模块）和 `iroh_web_bg.wasm?b=<BUILD>`
    #    一起缓存。只 bump BUILD 也可能无效 —— 因为旧 net.js 本身被缓存了，
    #    它仍然用旧的 ?b= 去请求 wasm。结果就是"重新构建了，但页面跑的还是旧 wasm"。
    _tabs = [t for t in tt.http_json(tt.CDP + "/json/list") if t["type"] == "page"]
    if _tabs:
        _p = tt.Page(_tabs[0]["id"])
        _p.call("Network.enable")
        _p.call("Network.clearBrowserCache")
        print("  已清空浏览器缓存", flush=True)

    ROOM = "bench"
    V = int(time.time() * 1000)
    # ⚠️ 用两个**不同的源**（127.0.0.1 与 localhost）打开两端，
    #    让 Chrome 把它们分到不同的渲染进程。
    #    否则两个 wasm QUIC 栈挤在同一个 JS 线程上，ACK 处理互相拖慢，
    #    会把 QUIC 的 RTT 估计抬高、窗口涨不上去 —— 本地测试因 RTT≈0 看不出来。
    tx_url = f"http://127.0.0.1:{PORT}/?autostart=1&room={ROOM}&testid=1&v={V}a"
    rx_url = f"http://localhost:{PORT}/?autostart=1&room={ROOM}&testid=1&v={V}b"
    print(f"  发送端 {tx_url}\n  接收端 {rx_url}", flush=True)
    tx_tab = tt.open_tab(tx_url)
    rx_tab = tt.open_tab(rx_url)
    tx, rx = tt.Page(tx_tab["id"]), tt.Page(rx_tab["id"])
    for p in (tx, rx):
        p.call("Runtime.enable")

    for name, p in (("发送端", tx), ("接收端", rx)):
        try:
            tt.wait_until(
                p, f"!!(window.__state && window.__state().joined === {json.dumps(ROOM)})", 60,
                label=f"{name}进房",
            )
            print(f"  {name} 已进房", flush=True)
        except TimeoutError as e:
            print(f"  ⚠️ {e}", flush=True)
            return 1

    rx.ev({"mem": PICKER_MEM, "opfs": PICKER_OPFS, "noop": PICKER_NOOP}[MODE], timeout=30)
    print(f"  已注入 {MODE} 句柄", flush=True)

    tx.ev(
        f"""
        (() => {{
          const u = new Uint8Array({SIZE});
          for (let i = 0; i < {SIZE}; i += 4096) u[i] = (i / 4096) & 0xff;
          window.__testFile = new File([u], 'bench.bin', {{ type: 'application/octet-stream' }});
          window.__clearBitmaps && window.__clearBitmaps();
          return window.__testFile.size;
        }})()
        """,
        timeout=60,
    )
    rx.ev("window.__clearBitmaps && window.__clearBitmaps()")
    print("  测试文件已构造", flush=True)

    tx.ev("window.__setStopAfterChunks(0)")
    tx.ev("window.__sendFile(window.__testFile, 'bench')")

    tt.wait_until(
        rx, "window.__transfers().some(t => t.direction==='recv' && t.state==='invited')",
        40, label="收到邀约",
    )
    fid = rx.ev("window.__transfers().find(t => t.direction==='recv').file_id")

    # 计时从「点接受」开始
    t0 = time.time()
    # FOCUS: 0=不动（默认，接收端是活动标签） 1=接收端置前 2=发送端置前
    # 背景标签会被 Chrome 节流（定时器降到 ~1s），而 wasm 上的 QUIC 依赖定时器驱动，
    # 所以"哪个标签在前台"会显著影响结果 —— 真实场景是两个用户各自的前台浏览器。
    if FOCUS == 1:
        rx.call("Page.bringToFront")
        print("  （接收端置前）", flush=True)
    elif FOCUS == 2:
        tx.call("Page.bringToFront")
        print("  （发送端置前）", flush=True)
    rx.fire(f"window.__acceptFile({json.dumps(fid)})")

    # 轮询到收齐或超时
    deadline = time.time() + 300
    last = -1
    stalls = 0
    while time.time() < deadline:
        time.sleep(0.5)
        n = rx.ev("window.__writeLog.length") or 0
        if n >= TOTAL:
            break
        if n == last:
            stalls += 1
            if stalls > 40:  # 20 秒没有新块
                break
        else:
            stalls = 0
        last = n

    elapsed = time.time() - t0
    got = rx.ev("window.__writeLog.length") or 0
    states = rx.ev("JSON.stringify(window.__transfers().map(t=>t.state))")

    print(f"\n  收到 {got}/{TOTAL} 块，用时 {elapsed:.1f}s", flush=True)
    if elapsed > 0 and got:
        print(f"  平均吞吐 ≈ {got * CHUNK / 1024 / elapsed:.0f} KB/s", flush=True)
    print(f"  接收端状态: {states}", flush=True)

    # 每块到达间隔（最能说明问题：≈RTT 就是「一次只有一个块在飞」）
    if got > 3:
        log = json.loads(rx.ev("JSON.stringify(window.__writeLog)") or "[]")
        gaps = [round(log[i + 1][1] - log[i][1], 1) for i in range(len(log) - 1)]
        gaps_sorted = sorted(gaps)
        print(f"\n  块间间隔(ms): 中位数={statistics.median(gaps):.1f} "
              f"最小={gaps_sorted[0]:.1f} 95分位={gaps_sorted[int(len(gaps_sorted)*0.95)]:.1f} 最大={gaps_sorted[-1]:.1f}",
              flush=True)

        # 速率时间序列：按 500ms 分桶，看是"稳定跑满"还是"锯齿"
        t_start = log[0][1]
        buckets = {}
        for _, ts in log:
            b = int((ts - t_start) / 500)
            buckets[b] = buckets.get(b, 0) + 1
        series = [buckets.get(i, 0) * CHUNK / 1024 / 0.5 for i in range(max(buckets) + 1)]
        # 用字符柱状图打出来（一眼看形状）
        print(f"  速率走势（每格 500ms，单位 KB/s；峰值 {max(series):.0f}）：", flush=True)
        top = max(series) or 1
        for i, v in enumerate(series):
            bar = "#" * max(1, int(v / top * 50))
            print(f"    {i*0.5:5.1f}s {v:7.0f} {bar}", flush=True)

    txlog = tt.LogTap(tx_tab["id"])
    rxlog = tt.LogTap(rx_tab["id"])
    txlog.dump("发送端", keep="耗时分解|stats|开始发送|补发|已发完|回执|失败|WARN|ERROR")
    rxlog.dump("接收端", keep="接收|写入失败|失败|中断|ERROR|WARN|panic|不完整|超时")
    rxlog.dump("接收端", keep="接收|写入失败|失败|中断|ERROR|WARN|panic|不完整|超时")

    tt.close_tab(tx_tab["id"])
    tt.close_tab(rx_tab["id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
