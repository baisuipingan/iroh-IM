#!/usr/bin/env python3
"""serve 单进程协议冒烟：命令→reply 往返、错误码、事件流、优雅退出。

前置：`cd client-wasm && cargo build --no-default-features --features cli --bin agent`
      （默认用 target/debug/agent；可用第一个参数覆盖路径）

用法：python3 scripts/e2e/agent-serve-smoke.py [agent二进制] [身份目录]
      中继与令牌自动读 frontend/relay-config.json（公开信息，随页面下发）

注：只跑真实中继、不需要 CDP/浏览器；身份目录不给就自动建临时目录。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_BIN = REPO / "client-wasm/target/debug/agent"
BIN = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_BIN)
HOME = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="iroh-agent-smoke-")

_relay_cfg = json.loads((REPO / "frontend/relay-config.json").read_text())
TOKEN = _relay_cfg["relay_token"]
RELAY = next(r["url"] for r in _relay_cfg["relays"] if r.get("enabled", True))

env = dict(os.environ)
env["IROH_AGENT_HOME"] = HOME
env["IROH_AGENT_TOKEN"] = TOKEN
env["IROH_AGENT_RELAY"] = RELAY
env["RUST_LOG"] = "warn"

p = subprocess.Popen(
    [BIN, "serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=env, bufsize=1,
)

events = []
def read_line(timeout, label):
    """读一行 stdout（带超时）。用 select 手工实现，避免线程。"""
    import select
    deadline = time.time() + timeout
    while True:
        remain = deadline - time.time()
        if remain <= 0:
            raise SystemExit(f"❌ 等待 {label} 超时")
        r, _, _ = select.select([p.stdout], [], [], remain)
        if not r:
            continue
        line = p.stdout.readline()
        if not line:
            raise SystemExit(f"❌ stdout 关闭（等待 {label} 时进程退出）")
        line = line.strip()
        print(f"daemon → {line}")
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            raise SystemExit(f"❌ stdout 混入非 JSON 行（协议被污染！）：{line!r}")

def wait_kind(kind, timeout=60, label=None):
    obj = read_line(timeout, label or kind)
    if obj.get("type") == "hello":
        print(f"   （hello：endpointId={obj.get('endpointId','')[:16]}… chatProtocol={obj.get('chatProtocol')}）")
        obj = read_line(timeout, label or kind) if obj.get("type") != kind else obj
    return obj

def cmd(id_, body, timeout=90):
    body = {"v": 1, "id": id_, **body}
    print(f"TS     → {json.dumps(body, ensure_ascii=False)}")
    p.stdin.write(json.dumps(body, ensure_ascii=False) + "\n")
    p.stdin.flush()
    deadline = time.time() + timeout
    while True:
        remain = deadline - time.time()
        if remain <= 0:
            raise SystemExit(f"❌ 等待 {id_} 的 reply 超时")
        obj = read_line(remain, f"reply {id_}")
        if obj.get("type") == "event":
            events.append(obj)
            # 事件里的 message / error 打短一点
            ev = obj.get("event", {})
            if ev.get("type") == "message":
                print(f"   （事件 message：{ev.get('message', {}).get('nickname')}: {ev.get('message', {}).get('text')!r} mine={ev.get('mine')}）")
            continue
        if obj.get("type") == "reply" and obj.get("id") == id_:
            return obj
        events.append(obj)

# ---- 1. hello ----
hello = read_line(60, "hello")
assert hello.get("type") == "hello", f"第一行必须是 hello，收到 {hello}"
print(f"✅ hello：agent={hello['agent']} chatProtocol={hello['chatProtocol']} relay={hello.get('relay')}")

# ---- 2. 命令往返 ----
r = cmd("c1", {"cmd": "ping"})
assert r["ok"], r
print(f"✅ ping → {r['value']}")

r = cmd("c2", {"cmd": "status"})
assert r["ok"], r
s = r["value"]
print(f"✅ status：room={s['room']} peers={len(s['peers'])} relays={[(x['url'], x['connected']) for x in s['relays']]}")

r = cmd("c3", {"cmd": "join", "room": "serve-smoke-8f3k", "nickname": "烟雾测试"})
print(f"✅ join → ok={r['ok']} value={r.get('value')} error={r.get('error')}")

r = cmd("c4", {"cmd": "say", "text": "你好（serve 冒烟测试）"})
print(f"✅ say → ok={r['ok']} value={r.get('value')} error={r.get('error')}")

r = cmd("c5", {"cmd": "list_files"})
print(f"✅ list_files → {r['value']}")

r = cmd("c6", {"cmd": "history", "limit": 3})
print(f"✅ history → ok={r['ok']} 条数={len(r.get('value', {}).get('messages', []))} snapshot={'有' if r.get('value', {}).get('snapshot') else '无'}")

r = cmd("c7", {"cmd": "bad_cmd"})
assert not r["ok"] and r["error"]["code"] == "unsupportedCmd", r
print(f"✅ 未知命令 → {r['error']['code']}")

r = cmd("c8", {"cmd": "say", "text": "x" * (33 * 1024)})
assert not r["ok"] and r["error"]["code"] == "tooLarge", r
print(f"✅ 超长文本 → {r['error']['code']}")

r = cmd("c9", {"cmd": "leave"})
print(f"✅ leave → ok={r['ok']}")

r = cmd("c10", {"cmd": "shutdown", "reason": "smoke done"})
print(f"✅ shutdown reply → ok={r['ok']}")

# 等 bye + 退出
try:
    bye = read_line(15, "bye")
    print(f"✅ 退出事件：{bye}")
except SystemExit as e:
    print(f"⚠️ 没等到 bye：{e}")
code = p.wait(timeout=15)
print(f"退出码 = {code}")

stderr_tail = p.stderr.read()
print("--- stderr（应只有日志，且不含协议 JSON）---")
print("\n".join(stderr_tail.splitlines()[-6:]))

# ---- 3. 断言事件流 ----
types = [e.get("event", {}).get("type") for e in events if e.get("type") == "event"]
print(f"收到事件序列：{types}")
assert "joined" in types, "必须收到 joined 事件"
assert "presence" in types, "进房后应收到 presence 事件"
# 注：发送者不会收到自己消息的回环（gossip broadcast 只推给邻居）——
#     message 事件需要第二个成员，见 serve-smoke2.py 的双进程用例。
seqs = [e.get("seq") for e in events if e.get("type") == "event"]
assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), f"seq 必须严格递增且不重复：{seqs}"
print("✅ 事件断言通过（joined / presence / seq 单调）")
print("✅ 冒烟全部通过")
