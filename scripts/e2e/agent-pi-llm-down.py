#!/usr/bin/env python3
"""pi-sdk brain 的失败路径 e2e：LLM 不可用（本机 3050 代理关闭）时，prompt 失败
必须只影响这一条消息——没有回复、进程存活、日志有记录——且 SIGTERM 仍优雅退出。

前提：agent-pi 已 `npm ci`（pi SDK 在；本用例故意不启 3050 代理走失败分支）。
用法：python3 scripts/e2e/agent-pi-llm-down.py [iroh-agent二进制] [临时目录]
      中继与令牌自动读 frontend/relay-config.json。
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

REPO = str(Path(__file__).resolve().parents[2])
DEFAULT_BIN = Path(REPO) / "client-wasm/target/debug/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
ROOT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-llm-down-")

_relay_cfg = json.loads((Path(REPO) / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"pi-sdk-down-{uuid.uuid4().hex[:6]}"


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


# ---- 人类先入房（适配器的 serve 用它当 anchor bootstrap）----
human = subprocess.Popen(
    [BIN, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True,
    env={**os.environ, "IROH_AGENT_HOME": f"{ROOT}/home-h", "IROH_AGENT_TOKEN": TOKEN,
         "IROH_AGENT_RELAY": RELAY, "RUST_LOG": "warn"})
hello = read_line(human, 60, "hello")
h_id, h_relay = hello["endpointId"], hello["relay"]["url"]
r = cmd(human, "h1", {"cmd": "join", "room": ROOM, "nickname": "测试员"})
assert r["ok"], r
print(f"✅ 人类入场（id={h_id[:8]}…）")

# ---- 适配器（pi-sdk brain；3050 没跑 → prompt 必失败）----
log_lines = []
lock = threading.Lock()
adapter = subprocess.Popen(
    ["node", "src/cli.ts", "--room", ROOM, "--nick", "小助手", "--brain", "pi-sdk",
     "--agent-bin", BIN, "--cooldown-ms", "300"],
    cwd=f"{REPO}/agent-pi",
    env={**os.environ,
         "IROH_AGENT_HOME": f"{ROOT}/home-a", "IROH_AGENT_TOKEN": TOKEN,
         "IROH_AGENT_RELAY": RELAY, "IROH_AGENT_ANCHOR_ID": h_id,
         "IROH_AGENT_ANCHOR_RELAY": h_relay, "RUST_LOG": "warn"},
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def pump():
    for line in adapter.stderr:
        with lock:
            log_lines.append(line.rstrip())


threading.Thread(target=pump, daemon=True).start()

deadline = time.time() + 90
adapter_id = None
while time.time() < deadline:
    with lock:
        snapshot = list(log_lines)
    for line in snapshot:
        match = re.search(r"endpointId=([0-9a-f]{64})", line)
        if match:
            adapter_id = match.group(1)
            break
    if adapter_id:
        break
    time.sleep(0.3)
assert adapter_id, f"没等到适配器 hello：\n" + "\n".join(log_lines[-15:])
print(f"✅ 适配器 hello（id={adapter_id[:8]}…）")


def wait_presence(timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            obj = read_line(human, deadline - time.time(), "presence")
        except SystemExit:
            return False
        if obj.get("type") == "event" and obj["event"].get("type") == "presence":
            if adapter_id in [x["id"] for x in obj["event"].get("peers", [])]:
                return True
    return False


assert wait_presence(), "适配器没进房（人类没看到它的 presence）"
print("✅ 适配器已进房")


def human_messages(fn, timeout, label):
    """在 timeout 内收集人类的消息事件；其它事件丢弃。"""
    deadline = time.time() + timeout
    out = []
    while time.time() < deadline:
        try:
            obj = read_line(human, deadline - time.time(), label)
        except SystemExit:
            return out
        if obj.get("type") == "event" and obj["event"].get("type") == "message":
            ev = obj["event"]
            if fn(ev):
                out.append(ev)
    return out


# ---- 触发消息：LLM 必失败 → 不回、双方都活着、日志有记录 ----
human.stdin.write(json.dumps({"v": 1, "id": "h2", "cmd": "say", "text": "@小助手 你好"}) + "\n")
human.stdin.flush()
time.sleep(25)
with lock:
    flat = list(log_lines)
print("--- 适配器关键日志 ---")
for line in flat:
    if "prompt" in line or "pi-sdk" in line or "hello" in line:
        print("   ", line[:170])
replies = None
# 再收 3 秒确认没有回复冒出来
replies = human_messages(lambda ev: ev.get("message", {}).get("from") == adapter_id, 3, "检查无回复")
alive = adapter.poll() is None and human.poll() is None
has_log = any(
    ("prompt 失败" in l) or ("提示：没有可用模型" in l) or ("本轮结束（error" in l) or ("Connection error" in l)
    for l in flat
)
print(f"✅ 双方进程存活：adapter alive={adapter.poll() is None} human alive={human.poll() is None}")
assert alive, "有进程意外退出！"
assert has_log, "日志里应有 prompt 失败记录"
assert not replies, f"LLM 不可用时不应有回复：{replies}"
print("✅ 失败被记日志且无回复发出")

# ---- 优雅收尾 ----
adapter.send_signal(signal.SIGTERM)
ac = adapter.wait(timeout=30)
with lock:
    tail = list(log_lines)[-12:]
print("--- SIGTERM 后适配器日志尾部 ---")
for line in tail:
    print("   ", line[:170])
hr = cmd(human, "h3", {"cmd": "shutdown", "reason": "done"})
assert hr["ok"]
assert ac == 0, f"适配器退出码 {ac}"
print("✅ 适配器退出码 0（SIGTERM 优雅退出）")
print("✅ pi-sdk 失败路径 e2e 通过：代理不可用只影响单条消息，进程链路不受影响")
