#!/usr/bin/env python3
"""agent-pi 文件策略 e2e：自动收小文件、按上限拒大文件。

流程：
  1) 人类（原始 serve）先入房；适配器（--files accept --files-max-mb 1）以人类为 anchor 进房
  2) 人类发 200KB 文件 → 适配器自动接收 → 落盘 sha256 校验
  3) 人类发 2MB 文件 → 适配器自动拒绝 → 人类收到 fileRejected（理由含"上限"）
  4) 断言大文件没有落盘；适配器 SIGTERM 退出码 0

用法：python3 scripts/e2e/agent-pi-files.py [agent二进制] [临时目录]
      中继与令牌自动读 frontend/relay-config.json；需先 `cd agent-pi && npm ci`。
"""
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_BIN = REPO / "client-wasm/target/debug/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
ROOT = Path(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-pi-files-"))

_relay_cfg = json.loads((REPO / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"agent-pi-files-{uuid.uuid4().hex[:6]}"
RECV_DIR = ROOT / "recv"

failures = []


def check(name, cond, detail=""):
    print(f"{'✅' if cond else '❌'} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def read_line(p, timeout, label):
    r, _, _ = select.select([p.stdout], [], [], max(timeout, 0.5))
    if not r:
        raise SystemExit(f"⏳ 等待 {label} 超时")
    raw = p.stdout.readline()
    if not raw:
        raise SystemExit(f"stdout 关闭（等待 {label} 时）")
    return json.loads(raw.strip())


def cmd(p, id_, body, timeout=120):
    p.stdin.write(json.dumps({"v": 1, "id": id_, **body}, ensure_ascii=False) + "\n")
    p.stdin.flush()
    deadline = time.time() + timeout
    while True:
        obj = read_line(p, deadline - time.time(), f"reply {id_}")
        if obj.get("type") == "reply" and obj.get("id") == id_:
            return obj


def wait_event(p, pred, timeout, label):
    deadline = time.time() + timeout
    while True:
        obj = read_line(p, deadline - time.time(), label)
        if obj.get("type") == "event" and pred(obj["event"]):
            return obj["event"]


# ---- 人类先入房 ----
human = subprocess.Popen(
    [BIN, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True,
    env={**os.environ, "IROH_AGENT_HOME": str(ROOT / "home-h"), "IROH_AGENT_TOKEN": TOKEN,
         "IROH_AGENT_RELAY": RELAY, "RUST_LOG": "warn"})
hello = read_line(human, 60, "hello")
h_id, h_relay = hello["endpointId"], hello["relay"]["url"]
assert cmd(human, "h1", {"cmd": "join", "room": ROOM, "nickname": "测试员"})["ok"]
print(f"✅ 人类入场（id={h_id[:8]}…）")

# ---- 适配器（自动接收，上限 1 MiB）----
log_lines = []
lock = threading.Lock()
adapter = subprocess.Popen(
    ["node", "src/cli.ts", "--room", ROOM, "--nick", "小助手", "--brain", "rule",
     "--agent-bin", BIN, "--files", "accept", "--files-max-mb", "1",
     "--files-dir", str(RECV_DIR), "--cooldown-ms", "1000"],
    cwd=str(REPO / "agent-pi"),
    env={**os.environ,
         "IROH_AGENT_HOME": str(ROOT / "home-a"), "IROH_AGENT_TOKEN": TOKEN,
         "IROH_AGENT_RELAY": RELAY, "IROH_AGENT_ANCHOR_ID": h_id,
         "IROH_AGENT_ANCHOR_RELAY": h_relay, "RUST_LOG": "warn"},
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
)


def pump():
    for line in adapter.stderr:
        with lock:
            log_lines.append(line.rstrip())


threading.Thread(target=pump, daemon=True).start()

deadline = time.time() + 90
adapter_id = None
while time.time() < deadline and not adapter_id:
    with lock:
        snapshot = list(log_lines)
    for line in snapshot:
        m = re.search(r"endpointId=([0-9a-f]{64})", line)
        if m:
            adapter_id = m.group(1)
            break
    time.sleep(0.3)
assert adapter_id, "没等到适配器 hello：\n" + "\n".join(log_lines[-15:])
print(f"✅ 适配器 hello（id={adapter_id[:8]}… files=accept max=1MiB）")

wait_event(human, lambda e: e.get("type") == "presence" and any(p["id"] == adapter_id for p in e.get("peers", [])), 45, "适配器进房")
print("✅ 适配器已进房")

# ---- 场景 1：小文件（200KB）自动接收 ----
small = ROOT / "small.bin"
small_data = os.urandom(200 * 1024)
small.write_bytes(small_data)
small_sha = hashlib.sha256(small_data).hexdigest()
r = cmd(human, "h2", {"cmd": "send_file", "path": str(small)})
assert r["ok"], r
print(f"==== 人类发布 small.bin（200KB）====")

dst = RECV_DIR / "small.bin"
deadline = time.time() + 120
while time.time() < deadline:
    if dst.exists() and hashlib.sha256(dst.read_bytes()).hexdigest() == small_sha:
        break
    time.sleep(0.5)
check("小文件已自动接收且逐字节一致", dst.exists() and hashlib.sha256(dst.read_bytes()).hexdigest() == small_sha)

with lock:
    flat = "\n".join(log_lines)
check("适配器日志记录了接收", "已接收 small.bin" in flat, flat[-400:])

# ---- 场景 2：大文件（2MB > 1MiB 上限）自动拒绝 ----
big = ROOT / "big.bin"
big.write_bytes(os.urandom(2 * 1024 * 1024))
r = cmd(human, "h3", {"cmd": "send_file", "path": str(big)})
assert r["ok"], r
print("==== 人类发布 big.bin（2MB，超上限）====")

ev = wait_event(
    human,
    lambda e: e.get("type") == "fileRejected" and "上限" in e.get("reason", ""),
    60, "大文件被拒事件",
)
print(f"   拒绝理由：{ev['reason']}")
check("大文件被自动拒绝（理由含上限）", True)
check("大文件没有落盘", not (RECV_DIR / "big.bin").exists())

# ---- 优雅退出 ----
adapter.send_signal(signal.SIGTERM)
ac = adapter.wait(timeout=30)
check("适配器 SIGTERM 退出码 0", ac == 0, str(ac))
assert cmd(human, "h4", {"cmd": "shutdown", "reason": "done"})["ok"]
human.wait(timeout=15)
check("人类优雅退出", human.returncode == 0, str(human.returncode))

if failures:
    print(f"\n❌ 失败 {len(failures)} 项：{failures}")
    sys.exit(1)
print("\n✅ agent-pi 文件策略 e2e 全部通过")
