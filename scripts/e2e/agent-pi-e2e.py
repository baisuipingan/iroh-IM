#!/usr/bin/env python3
"""agent-pi 适配器端到端（真实中继 + 真实进程）。

流程：
  1) 起"人类"：原始 iroh-agent serve 进程（无 anchor），进房
  2) 起适配器（node cli.ts，anchor=人类）：规则大脑，昵称 派大星助手
  3) !ping → 应回 pong；无关文本 → 不回；@派大星助手 who → 应回身份
  4) 杀掉 serve 子进程 → 适配器应自动重启并重新握手 → 再 ping 仍通
  5) SIGTERM 适配器 → 退出码 0；人类优雅退出

用法：python3 scripts/e2e/agent-pi-e2e.py [iroh-agent二进制] [临时目录]
      中继与令牌自动读 frontend/relay-config.json；node 从 PATH 里取。
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
ROOT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-pi-")

_relay_cfg = json.loads((Path(REPO) / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"agent-pi-e2e-{uuid.uuid4().hex[:6]}"

failures = []


def check(name, cond, detail=""):
    mark = "✅" if cond else "❌"
    print(f"{mark} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


class Daemon:
    """原始行协议客户端（当"人类"用）。"""

    def __init__(self, name, extra_env=None):
        env = dict(os.environ)
        env.update(
            IROH_AGENT_HOME=os.path.join(ROOT, f"home-{name}"),
            IROH_AGENT_TOKEN=TOKEN,
            IROH_AGENT_RELAY=RELAY,
            RUST_LOG="warn",
        )
        if extra_env:
            env.update(extra_env)
        self.name = name
        self.events = []
        self.buf = []
        self.p = subprocess.Popen(
            [BIN, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=env, bufsize=1,
        )

    def line(self, timeout):
        deadline = time.time() + timeout
        while True:
            if self.buf:
                return self.buf.pop(0)
            remain = deadline - time.time()
            if remain <= 0:
                raise SystemExit(f"[{self.name}] 等待 stdout 超时")
            r, _, _ = select.select([self.p.stdout], [], [], remain)
            if not r:
                continue
            raw = self.p.stdout.readline()
            if not raw:
                raise SystemExit(f"[{self.name}] stdout 关闭")
            obj = json.loads(raw.strip())
            return obj

    def cmd(self, id_, body, timeout=120):
        self.p.stdin.write(json.dumps({"v": 1, "id": id_, **body}, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        deadline = time.time() + timeout
        while True:
            obj = self.line(deadline - time.time())
            if obj.get("type") == "reply" and obj.get("id") == id_:
                return obj
            if obj.get("type") == "event":
                self.events.append(obj["event"])
            else:
                self.buf.append(obj)

    def wait_event(self, pred, timeout, label):
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise SystemExit(f"[{self.name}] 等待 {label} 超时（已收 {[e.get('type') for e in self.events]}）")
            obj = self.line(remain)
            if obj.get("type") == "event":
                self.events.append(obj["event"])
                if pred(obj["event"]):
                    return obj["event"]
            else:
                self.buf.append(obj)

    def drain_messages(self, timeout):
        """读 timeout 秒内到达的消息事件（抛掉其它事件）。"""
        found = []
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                return found
            try:
                obj = self.line(remain)
            except SystemExit:
                return found
            if obj.get("type") == "event":
                self.events.append(obj["event"])
                if obj["event"].get("type") == "message":
                    found.append(obj["event"])
            else:
                self.buf.append(obj)

    def shutdown(self):
        self.cmd("shutdown", {"cmd": "shutdown", "reason": "e2e done"})
        self.wait_event(lambda e: e.get("type") == "bye", 10, "bye")
        return self.p.wait(timeout=15)


# ---------------------------------------------------------------- 人类先入场
print(f"==== 房间：{ROOM} ====")
human = Daemon("human")
hello = human.line(60)
assert hello["type"] == "hello"
human_id, human_relay = hello["endpointId"], hello["relay"]["url"]
r = human.cmd("h1", {"cmd": "join", "room": ROOM, "nickname": "测试员"})
assert r["ok"], r
print(f"✅ 人类入场（id={human_id[:8]}…）")

# ---------------------------------------------------------------- 适配器
print("==== 启动适配器（node cli.ts，anchor=人类）====")
adapter_env = dict(os.environ)
adapter_env.update(
    IROH_AGENT_HOME=os.path.join(ROOT, "home-adapter"),
    IROH_AGENT_TOKEN=TOKEN,
    IROH_AGENT_RELAY=RELAY,
    IROH_AGENT_ANCHOR_ID=human_id,
    IROH_AGENT_ANCHOR_RELAY=human_relay,
    RUST_LOG="info",
)
adapter = subprocess.Popen(
    ["node", "src/cli.ts", "--room", ROOM, "--nick", "派大星助手",
     "--rules", "examples/rules.json", "--agent-bin", BIN,
     "--prefix", "!", "--cooldown-ms", "500"],
    cwd=os.path.join(REPO, "agent-pi"), env=adapter_env,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
)
adapter_log = []
adapter_lock = threading.Lock()


def pump_adapter():
    for line in adapter.stderr:
        with adapter_lock:
            adapter_log.append(line.rstrip())


threading.Thread(target=pump_adapter, daemon=True).start()


def wait_log(pred, timeout, label):
    deadline = time.time() + timeout
    seen = 0
    while time.time() < deadline:
        with adapter_lock:
            snapshot = list(adapter_log)
        for i in range(seen, len(snapshot)):
            if pred(snapshot[i]):
                return snapshot[i]
        seen = len(snapshot)
        time.sleep(0.2)
    with adapter_lock:
        tail = "\n".join(adapter_log[-15:])
    raise SystemExit(f"超时等待适配器日志：{label}\n--- 最近日志 ---\n{tail}")


hello_line = wait_log(lambda l: "endpointId=" in l, 90, "adapter hello")
adapter_id = re.search(r"endpointId=([0-9a-f]{64})", hello_line).group(1)
print(f"✅ 适配器 hello（id={adapter_id[:8]}…）")

# 适配器的 serve 会自动进房（anchor=人类）：等人类看见它
human.wait_event(
    lambda e: e.get("type") == "presence" and any(p["id"] == adapter_id for p in e.get("peers", [])),
    45, "适配器进房",
)
print("✅ 适配器已进房（人类看到它的 presence）")

# ---------------------------------------------------------------- 触发/非触发
print("==== 触发路径 ====")
human.cmd("h2", {"cmd": "say", "text": "!ping"})
ev = human.wait_event(
    lambda e: e.get("type") == "message" and e.get("message", {}).get("from") == adapter_id
    and e["message"]["text"] == "pong",
    30, "pong",
)
check("!ping → pong", ev["message"]["nickname"] == "派大星助手", ev["message"]["nickname"])

human.cmd("h3", {"cmd": "say", "text": "今天天气不错，随便聊聊"})
noise = human.drain_messages(6)
from_adapter = [e for e in noise if e.get("message", {}).get("from") == adapter_id]
check("无关文本不触发", len(from_adapter) == 0, f"{len(from_adapter)} 条回复")

human.cmd("h4", {"cmd": "say", "text": "@派大星助手 who are you"})
ev = human.wait_event(
    lambda e: e.get("type") == "message" and e.get("message", {}).get("from") == adapter_id
    and "派大星助手" in e["message"]["text"],
    30, "who 回复",
)
print(f"   回复：{ev['message']['text']}")
check("@提及触发 + {bot} 模板", True)

# ---------------------------------------------------------------- 崩溃自愈
print("==== 杀掉 serve 子进程，验证自动重启 ====")
children = subprocess.run(["pgrep", "-P", str(adapter.pid)], capture_output=True, text=True).stdout.split()
check("找到 serve 子进程", len(children) >= 1, f"children={children}")
for pid in children:
    os.kill(int(pid), signal.SIGKILL)
wait_log(lambda l: "已重启并重新握手" in l, 90, "自动重启")
print("✅ 适配器已自动重启并重新握手")

pong_again = False
for attempt in range(1, 5):
    human.cmd(f"h5-{attempt}", {"cmd": "say", "text": "!ping"})
    try:
        human.wait_event(
            lambda e, attempt=attempt: e.get("type") == "message"
            and e.get("message", {}).get("from") == adapter_id
            and e["message"]["text"] == "pong",
            15, f"重启后 pong #{attempt}",
        )
        pong_again = True
        break
    except SystemExit:
        print(f"   （第 {attempt} 次未收到，等它重新进房后重试…）")
        time.sleep(3)
check("重启后 !ping → pong", pong_again)

# ---------------------------------------------------------------- 优雅退出
print("==== 优雅退出 ====")
adapter.send_signal(signal.SIGTERM)
code = adapter.wait(timeout=30)
check("适配器 SIGTERM 退出码 0", code == 0, f"code={code}")
wait_log(lambda l: "已退出" in l, 10, "adapter 退出日志")
check("人类优雅退出", human.shutdown() == 0)

if failures:
    print(f"\n❌ 失败 {len(failures)} 项：{failures}")
    sys.exit(1)
print("\n✅ agent-pi 端到端全部通过")
