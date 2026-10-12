#!/usr/bin/env python3
"""召唤器（A2 邀请制）端到端 —— 真实中继、真实 spawn，无 mock。

流程：
  1) "人类"进房（原始 iroh-agent serve 客户端）
  2) 召唤器进房（node summoner.ts --rooms <房间> --registry <临时注册表>）
  3) 人类 @一个**注册过但不在场**的名字（@测试助手）
  4) 断言：召唤器如实播报"🫡 去叫…"→ 成员被拉起并出现在名册
  5) 断言：召唤器用**规范 token @<id8>**（不是昵称）把请求重说一遍（relay）
  6) 断言：成员按 @<它的 id8> 收到并答复（成员 = B5 的最小示例，40 行契约样例）
  7) 断言：SIGTERM 召唤器 → 它把带起来的成员一起收掉，房间里没有残留进程

用法：python3 scripts/e2e/summoner.py [iroh-agent二进制] [临时目录]
      中继与令牌自动读 frontend/relay-config.json；node 从 PATH 里取。
"""
import json
import os
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
DEFAULT_BIN = Path(REPO) / "client-wasm/target/release/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
ROOT = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-summoner-")

_relay_cfg = json.loads((Path(REPO) / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))
# 发现路径（缺了这个就是"孤立进房"：谁都看不见）：房间入口 + 历史提供者
RENDEZVOUS = _relay_cfg["rendezvous"]
HISTORY = _relay_cfg["history"]
ROOM = f"summoner-e2e-{uuid.uuid4().hex[:6]}"
MEMBER = "测试助手"

failures = []


def check(name, cond, detail=""):
    mark = "✅" if cond else "❌"
    print(f"{mark} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


class Daemon:
    """原始行协议客户端（当"人类"用）。"""

    def __init__(self, name):
        env = dict(os.environ)
        env.update(
            IROH_AGENT_HOME=os.path.join(ROOT, f"home-{name}"),
            IROH_AGENT_TOKEN=TOKEN,
            IROH_AGENT_RELAY=RELAY,
            IROH_AGENT_RENDEZVOUS_ID=RENDEZVOUS["id"],
            IROH_AGENT_RENDEZVOUS_RELAY=RENDEZVOUS["relay"],
            IROH_AGENT_HISTORY_ID=HISTORY["id"],
            IROH_AGENT_HISTORY_RELAY=HISTORY["relay"],
            RUST_LOG="warn",
        )
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
            return json.loads(raw.strip())

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

    def wait_any(self, pred, timeout, label):
        # 先翻已收下的事件：前面的 cmd() 可能已经把要等的事件吞进 self.events
        for e in self.events:
            if pred(e):
                return e
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                seen = [e.get("type") for e in self.events]
                raise SystemExit(f"[{self.name}] 等待 {label} 超时（已收 {seen}）")
            obj = self.line(remain)
            if obj.get("type") == "event":
                self.events.append(obj["event"])
                if pred(obj["event"]):
                    return obj["event"]
            else:
                self.buf.append(obj)

    def shutdown(self):
        self.cmd("shutdown", {"cmd": "shutdown", "reason": "e2e done"})
        self.wait_any(lambda e: e.get("type") == "bye", 10, "bye")
        return self.p.wait(timeout=15)


def presence_of(nickname):
    def pred(e):
        return e.get("type") == "presence" and any(
            p.get("nickname") == nickname for p in e.get("peers", [])
        )
    return pred


# ---------------------------------------------------------------- 人类先入场
print(f"==== 房间：{ROOM} ====")

# 前置闸门：v1 一次只能盯一个房间（一房一会话 —— 同一身份目录不能给两个进程共用）
gate = subprocess.run(
    [
        "node", "--experimental-strip-types", "agent-pi/src/summoner.ts",
        "--rooms", "a,b", "--registry", os.path.join(ROOT, "nope.json"),
    ],
    cwd=REPO, capture_output=True, text=True, timeout=60,
)
check(
    "--rooms a,b 被拒（一房一会话）",
    gate.returncode == 1 and "一房一会话" in gate.stderr,
    (gate.stderr or "")[-200:],
)

human = Daemon("human")
hello = human.line(60)
assert hello["type"] == "hello"
r = human.cmd("h1", {"cmd": "join", "room": ROOM, "nickname": "测试员"})
assert r["ok"], r
print("✅ 人类入场")

# ---------------------------------------------------------------- 召唤器入场
# 注册表：只列一个成员 —— 指向 B5 的最小示例（它按 @<我的 id8> 回话）。
# ⚠️ 成员必须有自己的 IROH_AGENT_HOME（同一个家目录起两个进程会互相踢下线）。
registry = {
    MEMBER: {
        "bin": "node",
        "args": [
            "--experimental-strip-types",
            "agent-pi/examples/minimal-supervisor.ts",
            "--nick",
            MEMBER,
        ],
        "env": {
            "IROH_AGENT_BIN": BIN,
            "IROH_AGENT_HOME": os.path.join(ROOT, "home-member"),
            "IROH_AGENT_TOKEN": TOKEN,
            "IROH_AGENT_RELAY": RELAY,
            "IROH_AGENT_RENDEZVOUS_ID": RENDEZVOUS["id"],
            "IROH_AGENT_RENDEZVOUS_RELAY": RENDEZVOUS["relay"],
            "IROH_AGENT_HISTORY_ID": HISTORY["id"],
            "IROH_AGENT_HISTORY_RELAY": HISTORY["relay"],
        },
        "cwd": REPO,
    }
}
reg_path = os.path.join(ROOT, "registry.json")
Path(reg_path).write_text(json.dumps(registry, ensure_ascii=False, indent=2))

summoner_env = dict(os.environ)
summoner_env.update(
    IROH_AGENT_HOME=os.path.join(ROOT, "home-summoner"),
    IROH_AGENT_TOKEN=TOKEN,
    IROH_AGENT_RELAY=RELAY,
    IROH_AGENT_RENDEZVOUS_ID=RENDEZVOUS["id"],
    IROH_AGENT_RENDEZVOUS_RELAY=RENDEZVOUS["relay"],
    IROH_AGENT_HISTORY_ID=HISTORY["id"],
    IROH_AGENT_HISTORY_RELAY=HISTORY["relay"],
    RUST_LOG="warn",
)
summoner = subprocess.Popen(
    [
        "node", "--experimental-strip-types", "agent-pi/src/summoner.ts",
        "--rooms", ROOM, "--registry", reg_path, "--nick", "召唤器",
        "--agent-bin", BIN, "--cooldown-ms", "0",
    ],
    cwd=REPO, env=summoner_env, stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
)
summoner_log = []
log_lock = threading.Lock()


def pump_summoner():
    for line in summoner.stderr:
        with log_lock:
            summoner_log.append(line.rstrip())


threading.Thread(target=pump_summoner, daemon=True).start()


def wait_log(pred, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with log_lock:
            if any(pred(l) for l in summoner_log):
                return
        time.sleep(0.2)
    with log_lock:
        tail = "\n".join(summoner_log[-20:])
    raise SystemExit(f"等待召唤器日志超时：{label}\n--- 日志尾部 ---\n{tail}")


wait_log(lambda l: "待命" in l, 60, "召唤器进房")
human.wait_any(presence_of("召唤器"), 60, "名册里出现召唤器")
print("✅ 召唤器已在房间待命（名册可见）")

# ---------------------------------------------------------------- 核心链路
print("==== @一个不在场的注册名 ====")
human.cmd("h2", {"cmd": "say", "text": f"@{MEMBER} 帮我查下天气"})

ev = human.wait_any(
    lambda e: e.get("type") == "message"
    and e.get("message", {}).get("text") == f"🫡 去叫「{MEMBER}」了",
    30,
    "去叫了",
)
check("召唤器如实播报「去叫了」", ev["message"]["nickname"] == "召唤器", ev["message"]["nickname"])

member_presence = human.wait_any(presence_of(MEMBER), 60, "名册里出现成员")
member_id = next(p["id"] for p in member_presence["peers"] if p["nickname"] == MEMBER)
member_id8 = member_id[:8].lower()
print(f"✅ 成员被拉起并进入名册（id8={member_id8}）")

relay = human.wait_any(
    lambda e: e.get("type") == "message"
    and e.get("message", {}).get("from") != member_id
    and "帮我查下天气" in e.get("message", {}).get("text", ""),
    60,
    "转交（relay）",
)
check(
    f"转交用规范 token（@{member_id8}），不是昵称",
    relay["message"]["text"] == f"@{member_id8} 帮我查下天气",
    relay["message"]["text"],
)

reply = human.wait_any(
    lambda e: e.get("type") == "message"
    and e.get("message", {}).get("from") == member_id
    and "收到" in e.get("message", {}).get("text", ""),
    60,
    "成员答复",
)
check("被召唤成员收到并答复", reply["message"]["text"] == f"收到：帮我查下天气", reply["message"]["text"])

# ---------------------------------------------------------------- 收尾
print("==== 收尾（SIGTERM 召唤器，成员应被一起收掉）====")
summoner.send_signal(signal.SIGTERM)
try:
    code = summoner.wait(timeout=15)
except subprocess.TimeoutExpired:
    summoner.kill()
    code = -9
check("召唤器 SIGTERM 退出码 0", code == 0, f"code={code}")
wait_log(lambda l: "收摊" in l, 10, "退出日志")

remaining = ""
deadline = time.time() + 15
while time.time() < deadline:
    remaining = subprocess.run(["pgrep", "-f", ROOM], capture_output=True, text=True).stdout.strip()
    if not remaining:
        break
    time.sleep(1)
check("房间里没有残留进程（按房名 pgrep）", remaining == "", f"残留 pid：{remaining}")

check("人类优雅退出", human.shutdown() == 0)

if failures:
    print(f"\n❌ 失败 {len(failures)} 项：{failures}")
    sys.exit(1)
print("\n✅ 召唤器端到端全部通过")
