#!/usr/bin/env python3
"""serve 双进程冒烟：B 先入房；A 把 B 当 bootstrap 进同一房间；互相收发。

这验证的是 serve 作为"普通成员"的真实收发链路（消息事件、presence 互见），
也顺带证明发送者不会收到自己的回环（mine 只能来自网络消息）。

用法：python3 scripts/e2e/agent-serve-two-peer.py [agent二进制] [工作目录根]
      中继与令牌自动读 frontend/relay-config.json；两个进程用独立身份目录
      （⚠️ 同一 IROH_AGENT_HOME 绝不能给两个进程共用）。
"""
import json
import os
import select
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_BIN = REPO / "client-wasm/target/debug/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
ROOT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-2peer-")

_relay_cfg = json.loads((REPO / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"serve-smoke2-{uuid.uuid4().hex[:6]}"


class Daemon:
    def __init__(self, name, extra_env=None):
        home = os.path.join(ROOT, f"home-{name}")
        env = dict(os.environ)
        env.update(
            IROH_AGENT_HOME=home,
            IROH_AGENT_TOKEN=TOKEN,
            IROH_AGENT_RELAY=RELAY,
            RUST_LOG="warn",
        )
        # ⚠️ anchor 必须显式注入：A 以 B 为 bootstrap 才能成为邻居
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
                raise SystemExit(f"[{self.name}] stdout 关闭（进程退出？code={self.p.poll()}）")
            raw = raw.strip()
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                raise SystemExit(f"[{self.name}] stdout 混入非 JSON（协议污染）：{raw!r}")
            print(f"[{self.name}] ← {raw[:150]}")
            return obj

    def wait_reply(self, id_, timeout=90):
        deadline = time.time() + timeout
        while True:
            obj = self.line(deadline - time.time())
            if obj.get("type") == "reply" and obj.get("id") == id_:
                return obj
            if obj.get("type") == "event":
                self.events.append(obj["event"])
            else:
                self.buf.append(obj)

    def wait_event(self, pred, timeout=25, label=""):
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                raise SystemExit(f"[{self.name}] 等待事件 {label} 超时（已收：{[e.get('type') for e in self.events]}）")
            obj = self.line(remain)
            if obj.get("type") == "event":
                self.events.append(obj["event"])
                if pred(obj["event"]):
                    return obj["event"]
            else:
                self.buf.append(obj)

    def cmd(self, id_, body, timeout=90):
        self.p.stdin.write(json.dumps({"v": 1, "id": id_, **body}, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        r = self.wait_reply(id_, timeout)
        print(f"[{self.name}] {id_} → ok={r['ok']} {r.get('value', r.get('error'))}")
        return r

    def shutdown(self):
        self.cmd("shutdown", {"cmd": "shutdown", "reason": "smoke2 done"})
        self.wait_event(lambda e: e.get("type") == "bye", 10, "bye")
        code = self.p.wait(timeout=15)
        print(f"[{self.name}] 退出码 = {code}")
        return code


print("==== 启动 B（普通成员，先入房）====")
b = Daemon("B")
hello_b = b.line(60)
assert hello_b["type"] == "hello", hello_b
b_id = hello_b["endpointId"]
b_relay = hello_b["relay"]["url"]
r = b.cmd("b1", {"cmd": "join", "room": ROOM, "nickname": "成员乙"})
assert r["ok"], r

print("==== 启动 A（以 B 为 bootstrap 入同一房间）====")
a = Daemon("A", extra_env={"IROH_AGENT_ANCHOR_ID": b_id, "IROH_AGENT_ANCHOR_RELAY": b_relay})
hello_a = a.line(60)
assert hello_a["type"] == "hello", hello_a
a_id = hello_a["endpointId"]
a.p.stdin.write(json.dumps({"v": 1, "id": "seed", "cmd": "ping"}) + "\n")  # 预热，保证 hello 已完整
a.p.stdin.flush()
a.wait_reply("seed")
r = a.cmd("a1", {"cmd": "join", "room": ROOM, "nickname": "成员甲"}, timeout=150)
assert r["ok"], r

print("==== A 发言 → B 必须收到（mine=false，from=A）====")
a.cmd("a2", {"cmd": "say", "text": "来自 A 的消息"})
ev = b.wait_event(
    lambda e: e.get("type") == "message" and e.get("message", {}).get("text") == "来自 A 的消息",
    30, "A 的消息",
)
assert ev["message"]["from"] == a_id, ev
assert ev["mine"] is False, ev
print(f"✅ B 收到 A 的消息：nickname={ev['message']['nickname']}")

print("==== B 回复 → A 必须收到 ====")
b.cmd("b2", {"cmd": "say", "text": "来自 B 的回复"})
ev = a.wait_event(
    lambda e: e.get("type") == "message" and e.get("message", {}).get("text") == "来自 B 的回复",
    30, "B 的消息",
)
assert ev["message"]["from"] == b_id, ev
print(f"✅ A 收到 B 的消息：nickname={ev['message']['nickname']}")

print("==== presence 互见（等各自心跳，最多 20s）====")
b.wait_event(
    lambda e: e.get("type") == "presence" and any(p["id"] == a_id for p in e.get("peers", [])),
    35, "B 看到 A",
)
a.wait_event(
    lambda e: e.get("type") == "presence" and any(p["id"] == b_id for p in e.get("peers", [])),
    35, "A 看到 B",
)
print("✅ 双方 presence 互见")

r = a.cmd("a3", {"cmd": "status"})
assert r["value"]["peers"], f"A 的 status 里应有成员：{r['value']}"
print(f"✅ A 的 status.peers = {len(r['value']['peers'])} 人")

print("==== 双方优雅退出 ====")
assert b.shutdown() == 0
assert a.shutdown() == 0
print("✅ 双进程冒烟全部通过")
