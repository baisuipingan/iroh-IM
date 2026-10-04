#!/usr/bin/env python3
"""真实文件端到端测试：Mac 浏览器 → 香港浏览器，接收端写**真磁盘**（OPFS）。

## 为什么必须这么测

1. **接收端要用真磁盘**：之前用内存假句柄，384MB 会把内存堆到 GB 级（页面 OOM）；
   OPFS（`navigator.storage.getDirectory()`）走的是真实磁盘写入，
   和用户点「保存到文件」时同一套 `FileSystemFileHandle` API。
2. **必须用真实二进制数据**：测试文件如果全是 0，压缩性极强、不具代表性。
   这里从本地读一个真实文件按 4MB 分片喂给发送方（不整块进内存）。
3. **必须用真实拓扑**：两个端在同一台机器时，relay 模式下数据要跨境来回两趟，
   会低估 2~3 倍。所以接收端跑在香港机的无头 Chrome 上。

前置：
  - 香港机起了无头 Chrome（`--remote-debugging-port=9333`），并做了 SSH 端口转发
  - 本地 Chrome 调试端口 9222
  - frontend/ 静态服务在 8099

用法：
    python3 scripts/real-file-test.py <本地文件路径> [分片MB]
"""
import importlib.util
import json
import os
import sys
import time

FILE = sys.argv[1]
PIECE_MB = int(sys.argv[2]) if len(sys.argv) > 2 else 64
MAC = "http://127.0.0.1:9222"
HK = "http://127.0.0.1:9333"

# transfer-test.py 在导入时会读 sys.argv，所以先把它清掉再导入
_saved_argv = sys.argv
sys.argv = ["real-file-test.py"]
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tt)
sys.argv = _saved_argv

CHUNK = 16 * 1024


def main() -> int:
    size = min(os.path.getsize(FILE), PIECE_MB * 1024 * 1024)
    with open(FILE, "rb") as f:
        data = f.read(size)
    print(f"== 真实文件 {FILE}：取前 {size/1024/1024:.0f} MB ==", flush=True)

    ROOM = "real1"
    URL = f"https://im.pinkstar.cc/?autostart=1&room={ROOM}&testid=1"

    # ---------- 香港端：接收，写 OPFS（真磁盘） ----------
    tt.CDP = HK
    for t in tt.http_json(HK + "/json/list"):
        if t["type"] == "page" and "about" not in t.get("url", ""):
            tt.close_tab(t["id"])
    hk_tab = tt.open_tab(URL)
    time.sleep(4)
    hk = tt.Page(hk_tab["id"])
    hk.call("Runtime.enable")
    tt.wait_until(hk, f"!!(window.__state && window.__state().joined === '{ROOM}')", 90, label="HK进房")
    print("香港端已进房", flush=True)

    # OPFS 假句柄：与真实 showSaveFilePicker 返回的句柄同类型
    hk.ev(
        r"""
        (async () => {
          window.__writeLog = [];
          const root = await navigator.storage.getDirectory();
          try { await root.removeEntry('out.bin'); } catch {}
          const CHUNK = 16384;
          window.__mockFilePicker = async (name, size) => {
            const fh = await root.getFileHandle('out.bin', { create: true });
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
        """,
        timeout=30,
    )
    print("香港端已注入 OPFS（真磁盘）句柄", flush=True)

    # ---------- Mac 端：发送真实数据 ----------
    tt.CDP = MAC
    for t in tt.http_json(MAC + "/json/list"):
        if t["type"] == "page" and ("im.pinkstar.cc" in t.get("url", "") or "8099" in t.get("url", "")):
            tt.close_tab(t["id"])
    time.sleep(1)
    mac_tab = tt.open_tab(URL)
    time.sleep(4)
    mac = tt.Page(mac_tab["id"])
    mac.call("Runtime.enable")
    mac.call("Network.enable")
    mac.call("Network.clearBrowserCache")
    mactap = tt.LogTap(mac_tab["id"])
    tt.wait_until(mac, f"!!(window.__state && window.__state().joined === '{ROOM}')", 90, label="MAC进房")
    print("Mac 端已进房", flush=True)

    # 把真实数据分片塞进页面（每片 4MB，避免一条 JS 表达式过大）
    mac.ev("window.__parts = []; window.__got = 0; 1", timeout=30)
    piece = 4 * 1024 * 1024
    for off in range(0, size, piece):
        b64 = data[off : off + piece].hex()
        mac.ev(f"window.__parts.push('{b64}'); 1", timeout=120)
    mac.ev(
        """
        (() => {
          const bufs = window.__parts.map(h => {
            const u = new Uint8Array(h.length / 2);
            for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i*2, 2), 16);
            return u;
          });
          window.__parts = null;
          window.__testFile = new File(bufs, 'real.bin', { type: 'application/octet-stream' });
          return window.__testFile.size;
        })()
        """,
        timeout=180,
    )
    print(f"Mac 端已装载 {mac.ev('window.__testFile.size')} 字节（真实数据）", flush=True)

    mac.ev("window.__setStopAfterChunks(0)")
    t0 = time.time()
    mac.ev("window.__sendFile(window.__testFile, '" + ROOM + "')")
    print("已发起传输", flush=True)

    accepted = False
    done_info = None
    chunk_size = CHUNK  # 稍后从 meta 里读真实值
    for _ in range(400):
        time.sleep(3)
        try:
            st = json.loads(hk.ev("JSON.stringify(window.__transfers())") or "[]")
        except Exception:
            continue
        inv = [x for x in st if x["direction"] == "recv" and x["state"] == "invited"]
        if inv and not accepted:
            hk.fire(f"window.__acceptFile({json.dumps(inv[0]['file_id'])})")
            accepted = True
            print("香港端已接受", flush=True)
            continue
        if accepted and st and st[0]["state"] in ("done", "failed"):
            done_info = st[0]
            break
        if accepted and _ % 10 == 9:
            n = st[0]["done"] if st else 0
            el = time.time() - t0
            print(f"    [{el:6.0f}s] {n}/{total} 块 ({n*16/1024:.0f} MB) ≈ {n*16/1024/el*1000:.0f} KB/s", flush=True)

    el = time.time() - t0
    if not done_info:
        print(f"⚠️ 超时（{el:.0f}s）", flush=True)
    else:
        n = done_info["done"]
        # ⚠️ 必须用**真实块大小**算吞吐。之前这里硬编码 16KB，
        #    而发送端用的是 256KB 块 ⇒ 吞吐被低估 16 倍（踩过）。
        chunk_size = done_info.get("chunk_size") or CHUNK
        mb = n * chunk_size / 1024 / 1024
        print(f"\n{'='*54}")
        print(f"结果: {done_info['state']}  {n}/{total} 块（块大小 {chunk_size//1024}KB）")
        print(f"用时: {el:.1f}s")
        print(f"吞吐: {n*chunk_size/1024/el*1000:.0f} KB/s   （{mb:.0f} MB / {el:.0f}s）")
        if done_info.get("error"):
            print(f"错误: {done_info['error']}")
        print("=" * 54, flush=True)

    mactap.dump("发送端", keep="耗时分解|已发完|失败|ERROR")
    tt.close_tab(mac_tab["id"])
    tt.close_tab(hk_tab["id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
