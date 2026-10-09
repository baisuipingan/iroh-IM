#!/usr/bin/env python3
"""agent 收文件 e2e：B 发 → A 用 accept_file 收 → 逐字节校验。

流程：
  1) B（serve）先入房；A（serve，anchor=B）进同一房间，双方 presence 互见
  2) B `send_file` 一个 3MB 随机文件 → A 收到 fileInvite 事件
  3) A `accept_file`（savePath 指定临时路径）→ 等 reply
  4) 断言：bytes 与文件大小一致、落盘文件与源文件 sha256 相同、
     A 收到 fileRecvStarted / fileRecvFinished、双方优雅退出

用法：python3 scripts/e2e/agent-file-receive.py [agent二进制] [工作目录根]
      中继与令牌自动读 frontend/relay-config.json；两个进程独立身份目录。
"""
import hashlib
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
ROOT = Path(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-file-"))

_relay_cfg = json.loads((REPO / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
ROOM = f"agent-file-{uuid.uuid4().hex[:6]}"

failures = []


def check(name, cond, detail=""):
    print(f"{'✅' if cond else '❌'} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


class Daemon:
    """原始行协议客户端。"""

    def __init__(self, name, extra_env=None):
        env = dict(os.environ)
        env.update(
            IROH_AGENT_HOME=str(ROOT / f"home-{name}"),
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
                raise SystemExit(f"[{self.name}] 等待 stdout 超时（已收事件：{[e.get('type') for e in self.events]}）")
            r, _, _ = select.select([self.p.stdout], [], [], remain)
            if not r:
                continue
            raw = self.p.stdout.readline()
            if not raw:
                raise SystemExit(f"[{self.name}] stdout 关闭")
            return json.loads(raw.strip())

    def wait_reply(self, id_, timeout=300):
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
                raise SystemExit(f"[{self.name}] 等待 {label} 超时（已收：{[e.get('type') for e in self.events]}）")
            obj = self.line(remain)
            if obj.get("type") == "event":
                self.events.append(obj["event"])
                if pred(obj["event"]):
                    return obj["event"]
            else:
                self.buf.append(obj)

    def cmd(self, id_, body, timeout=300):
        self.p.stdin.write(json.dumps({"v": 1, "id": id_, **body}, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        return self.wait_reply(id_, timeout)

    def shutdown(self):
        self.cmd("shutdown", {"cmd": "shutdown", "reason": "e2e done"}, timeout=30)
        self.wait_event(lambda e: e.get("type") == "bye", 10, "bye")
        return self.p.wait(timeout=15)


print(f"==== 房间：{ROOM} ====")
b = Daemon("B")
hello = b.line(60)
assert hello["type"] == "hello"
b_id, b_relay = hello["endpointId"], hello["relay"]["url"]
assert b.cmd("b1", {"cmd": "join", "room": ROOM, "nickname": "发送方"})["ok"], "B 进房失败"
print(f"✅ B 入场（id={b_id[:8]}…）")

a = Daemon("A", extra_env={"IROH_AGENT_ANCHOR_ID": b_id, "IROH_AGENT_ANCHOR_RELAY": b_relay})
hello = a.line(60)
assert hello["type"] == "hello"
a_id = hello["endpointId"]
assert a.cmd("a1", {"cmd": "join", "room": ROOM, "nickname": "接收方"}, timeout=150)["ok"], "A 进房失败"
print(f"✅ A 入场（id={a_id[:8]}…，anchor=B）")

# 双方 presence 互见（邻居建立完成才发文件）
b.wait_event(
    lambda e: e.get("type") == "presence" and any(p["id"] == a_id for p in e.get("peers", [])),
    45, "B 看到 A",
)
a.wait_event(
    lambda e: e.get("type") == "presence" and any(p["id"] == b_id for p in e.get("peers", [])),
    45, "A 看到 B",
)
print("✅ presence 互见")

# ---- B 发文件 ----
src = ROOT / "send.bin"
data = os.urandom(3 * 1024 * 1024)  # 3MB，192 个块
src.write_bytes(data)
src_sha = hashlib.sha256(data).hexdigest()
print(f"==== B 发布 3MB 文件（sha256={src_sha[:16]}…）====")
r = b.cmd("b2", {"cmd": "send_file", "path": str(src)})
assert r["ok"], r
file_id = r["value"]["fileId"]
print(f"✅ 已发布 fileId={file_id[:8]}…")

# ---- A 等邀约并接收 ----
invite = a.wait_event(
    lambda e: e.get("type") == "fileInvite" and e.get("meta", {}).get("file_id") == file_id,
    60, "fileInvite",
)
check("邀约 meta 完整（size/root_hash）", invite["meta"]["size"] == len(data) and bool(invite["meta"]["root_hash"]))

dst = ROOT / "recv.bin"
print("==== A accept_file（真实传输中…）====")
t0 = time.time()
r = a.cmd("a2", {"cmd": "accept_file", "fileId": file_id, "savePath": str(dst)}, timeout=300)
elapsed = time.time() - t0
assert r["ok"], f"accept_file 失败：{r.get('error')}"
check("reply.bytes == 文件大小", r["value"]["bytes"] == len(data), str(r["value"]))
check("reply.path 正确", Path(r["value"]["path"]) == dst, r["value"]["path"])
check("落盘文件存在", dst.exists())

dst_sha = hashlib.sha256(dst.read_bytes()).hexdigest()
check("逐字节一致（sha256 相同）", dst_sha == src_sha, f"{dst_sha} != {src_sha}")
print(f"   传输 {len(data)} 字节，用时 {elapsed:.1f}s（≈{len(data)/1024/max(elapsed,0.001):.0f} KB/s）")

types_a = [e.get("type") for e in a.events]
check("A 收到 fileRecvStarted", "fileRecvStarted" in types_a, str(types_a))
check("A 收到 fileRecvFinished", "fileRecvFinished" in types_a, str(types_a))

# ---- 优雅退出 ----
check("B 优雅退出", b.shutdown() == 0)
check("A 优雅退出", a.shutdown() == 0)

if failures:
    print(f"\n❌ 失败 {len(failures)} 项：{failures}")
    sys.exit(1)
print("\n✅ agent 收文件 e2e 全部通过")
