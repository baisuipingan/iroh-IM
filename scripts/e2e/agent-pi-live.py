#!/usr/bin/env python3
"""pi-sdk brain × 真实 LLM 的房间级 e2e（**opt-in**，需要可用的 provider）。

流程：人类（原始 serve 客户端）先入房 → 适配器（--brain pi-sdk）以人类为 anchor 进房
→ 人类 @它 → 等真实模型回复（非空）→ SIGTERM 适配器优雅退出 → 人类退出。

前置：
  1) `cd client-wasm && cargo build --no-default-features --features cli --bin agent`
  2) `cd agent-pi && npm ci`（装 pi SDK）
  3) `~/.pi/agent/models.json` 里有可用的 provider（本机是 hahacode）
  4) 设置 E2E_PI_MODEL=provider/modelId（如 hahacode/gpt-6.1-sol）——不设则退出并提示

用法：E2E_PI_MODEL=hahacode/gpt-6.1-sol python3 scripts/e2e/agent-pi-live.py [agent二进制] [临时目录]

注意：耗时取决于上游（实测首答 30~90s）；中继与令牌自动读 frontend/relay-config.json。
"""
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

MODEL = os.environ.get("E2E_PI_MODEL", "")
if not MODEL:
    print("需要设置 E2E_PI_MODEL=provider/modelId（例：hahacode/gpt-6.1-sol）", file=sys.stderr)
    print(__doc__, file=sys.stderr)
    sys.exit(2)

REPO = str(Path(__file__).resolve().parents[2])
DEFAULT_BIN = Path(REPO) / "client-wasm/target/debug/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
ROOT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-pi-live-")

_relay_cfg = json.loads((Path(REPO) / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"agent-pi-live-{uuid.uuid4().hex[:6]}"
REPLY_TIMEOUT = 300  # 上游排队时首答可能要 1~2 分钟


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


# ---- 人类先入房 ----
human = subprocess.Popen(
    [BIN, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True,
    env={**os.environ, "IROH_AGENT_HOME": f"{ROOT}/home-h", "IROH_AGENT_TOKEN": TOKEN,
         "IROH_AGENT_RELAY": RELAY, "RUST_LOG": "warn"})
hello = read_line(human, 60, "hello")
h_id, h_relay = hello["endpointId"], hello["relay"]["url"]
assert cmd(human, "h1", {"cmd": "join", "room": ROOM, "nickname": "测试员"})["ok"]
print(f"✅ 人类入场（id={h_id[:8]}…）")

# ---- 适配器（pi-sdk + 真实模型）----
log_lines = []
lock = threading.Lock()
adapter = subprocess.Popen(
    ["node", "src/cli.ts", "--room", ROOM, "--nick", "小助手", "--brain", "pi-sdk",
     "--pi-model", MODEL, "--agent-bin", BIN, "--cooldown-ms", "1000"],
    cwd=f"{REPO}/agent-pi",
    env={**os.environ,
         "IROH_AGENT_HOME": f"{ROOT}/home-a", "IROH_AGENT_TOKEN": TOKEN,
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
        match = re.search(r"endpointId=([0-9a-f]{64})", line)
        if match:
            adapter_id = match.group(1)
            break
    time.sleep(0.3)
assert adapter_id, "没等到适配器 hello：\n" + "\n".join(log_lines[-15:])
print(f"✅ 适配器 hello（id={adapter_id[:8]}… model={MODEL}）")


def wait_presence(timeout=45):
    dl = time.time() + timeout
    while time.time() < dl:
        try:
            obj = read_line(human, dl - time.time(), "presence")
        except SystemExit:
            return False
        if obj.get("type") == "event" and obj["event"].get("type") == "presence":
            if adapter_id in [x["id"] for x in obj["event"].get("peers", [])]:
                return True
    return False


assert wait_presence(), "适配器没进房"
print("✅ 适配器已进房，开始真实对话（等模型回复，可能要 1~2 分钟）…")

# ---- @它，等真实回复 ----
human.stdin.write(json.dumps(
    {"v": 1, "id": "h2", "cmd": "say", "text": "@小助手 用一句话向房间里的大家问好"},
    ensure_ascii=False) + "\n")
human.stdin.flush()
dl = time.time() + REPLY_TIMEOUT
reply = None
while time.time() < dl:
    try:
        obj = read_line(human, dl - time.time(), "模型回复")
    except SystemExit:
        break
    if obj.get("type") == "event" and obj["event"].get("type") == "message":
        ev = obj["event"]
        if ev.get("message", {}).get("from") == adapter_id and ev["message"]["text"].strip():
            reply = ev["message"]["text"]
            break
assert reply, f"没有等到模型回复（{REPLY_TIMEOUT}s）\n适配器日志尾部：\n" + "\n".join(log_lines[-10:])
print(f"\n💬 房间里的回答：{reply}\n")
print("✅ 真实 LLM 房间级往返通过")

# ---- 优雅收尾 ----
adapter.send_signal(signal.SIGTERM)
ac = adapter.wait(timeout=30)
assert ac == 0, f"适配器退出码 {ac}"
assert cmd(human, "h3", {"cmd": "shutdown", "reason": "done"})["ok"]
print("✅ 适配器退出码 0，人类优雅退出")
