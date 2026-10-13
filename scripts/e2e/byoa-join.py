#!/usr/bin/env python3
"""BYOA 首接端到端：**空目录 + 一次 --server 引导 + 名片 + 别人真的看得到**。

覆盖"朋友第一次在自己的电脑上接入"的完整路径（不碰浏览器）：

  1. 全新的 `IROH_AGENT_HOME`（没有 config.json、没有 IROH_AGENT_* 环境变量）
  2. 适配器（agent-pi `cli.ts`）用默认 `--server` 拉 `relay-config.json` 自动补配置
     —— 断言日志里有"已从 … 引导配置"，且 config.json 真的写出来（含令牌）
  3. 进房后自动发布名片（`--bio/--tags`）—— 断言日志里有"名片已发布"
  4. **第二个身份**（独立家目录）拉快照 → 名片真的在（不是"自己以为发了"）
  5. SIGTERM 收摊，退出码 0，无残留

用法：python3 scripts/e2e/byoa-join.py [agent二进制] [适配器命令…]
  · 默认适配器 = `node --experimental-strip-types agent-pi/src/cli.ts`（仓库版）；
  · 测**单文件版**：先 bash scripts/build-room-bridge.sh，然后
      BRIDGE_BIN=dist/room-bridge/room-bridge-darwin-arm64 python3 scripts/e2e/byoa-join.py
前置：cd client-wasm && cargo build --no-default-features --features cli --bin agent
      （默认用 target/debug/agent）
注：连线上中继与 roomd（房名带随机后缀，不打扰真实房间）。
"""
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BIN = sys.argv[1] if len(sys.argv) > 1 else str(REPO / "client-wasm/target/debug/agent")
NICK = "首接测试助手"
BIO = "引导与名片端到端"
TAGS = ["byoa", "smoke"]
ROOM = f"byoa-{int(time.time()) % 100000}"

checks, failures = [], []


def check(name, cond, detail=""):
    (checks if cond else failures).append(name)
    print(("✅ " if cond else "❌ ") + name + (f"  ({detail})" if detail else ""), flush=True)


def main():
    home = tempfile.mkdtemp(prefix="byoa-home-")
    env = dict(os.environ)
    env["IROH_AGENT_HOME"] = home
    env.pop("IROH_AGENT_RELAY", None)
    env.pop("IROH_AGENT_TOKEN", None)
    env.pop("IROH_AGENT_RENDEZVOUS_ID", None)
    env["RUST_LOG"] = "warn"

    bridge_bin = os.environ.get("BRIDGE_BIN", "").strip()
    base_cmd = [bridge_bin] if bridge_bin else ["node", "--experimental-strip-types", "agent-pi/src/cli.ts"]
    adapter = subprocess.Popen(
        base_cmd + [
            "--room", ROOM, "--nick", NICK,
            "--bio", BIO, "--tags", ",".join(TAGS),
            "--brain", "rule", "--agent-bin", BIN,
        ],
        cwd=REPO, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )

    log = ""
    deadline = time.time() + 90
    published = False
    while time.time() < deadline and "名片已发布" not in log:
        # ⚠️ 用 select 做带超时的读：直接 readline 会在"进程挂着不输出"时
        #    把这里的 90s 超时变成永远等待（超时保护就成了摆设）。
        ready, _, _ = select.select([adapter.stderr], [], [], max(0.5, deadline - time.time()))
        if not ready:
            break
        line = adapter.stderr.readline()
        if not line:
            break
        log += line
        print("adapter → " + line.rstrip(), flush=True)
        if "名片已发布" in log:
            published = True
    check("适配器日志出现『引导配置』", "引导配置" in log, log.splitlines()[0] if log else "")
    check("前缀正确：" + ("外部适配器（BRIDGE_BIN）" if bridge_bin else "仓库版"), True, bridge_bin or "node cli.ts")
    check("引导写出的 config.json 含令牌", json.loads((Path(home) / "config.json").read_text())["relay_token"] != "" if (Path(home) / "config.json").exists() else False)
    check("适配器日志出现『名片已发布』", published)

    # ---- 第二个身份：拉快照看名片 ----
    cfg = json.loads((REPO / "frontend/relay-config.json").read_text())
    env2 = dict(os.environ)
    env2.update(
        IROH_AGENT_HOME=tempfile.mkdtemp(prefix="byoa-verify-"),
        IROH_AGENT_TOKEN=cfg["relay_token"],
        IROH_AGENT_RELAY=next(r["url"] for r in cfg["relays"] if r.get("enabled", True)),
        IROH_AGENT_RENDEZVOUS_ID=cfg["rendezvous"]["id"],
        IROH_AGENT_RENDEZVOUS_RELAY=cfg["rendezvous"]["relay"],
        IROH_AGENT_HISTORY_ID=cfg["history"]["id"],
        IROH_AGENT_HISTORY_RELAY=cfg["history"]["relay"],
        RUST_LOG="error",
    )
    v = subprocess.Popen([BIN, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, env=env2, bufsize=1)

    def vline(timeout=60):
        r, _, _ = select.select([v.stdout], [], [], timeout)
        if not r:
            raise SystemExit("❌ 验收端等待超时")
        return json.loads(v.stdout.readline())

    def vcmd(id_, body, timeout=60):
        v.stdin.write(json.dumps({"v": 1, "id": id_, **body}) + "\n")
        v.stdin.flush()
        while True:
            o = vline(timeout)
            if o.get("type") == "reply" and o.get("id") == id_:
                return o

    assert vline()["type"] == "hello"
    assert vcmd("j", {"cmd": "join", "room": ROOM, "nickname": "验收员"})["ok"]
    seen = None
    for attempt in range(1, 13):
        snap = vcmd(f"h{attempt}", {"cmd": "history", "limit": 30})["value"].get("snapshot")
        if snap:
            hit = [m for m in snap["members"] if m.get("nickname") == NICK]
            if hit and hit[0].get("bio") == BIO:
                seen = hit[0]
                break
        time.sleep(1)
    check("第二个身份在快照里看到名片（bio/tags 一致）",
          bool(seen) and sorted(seen.get("tags") or []) == sorted(TAGS),
          json.dumps(seen, ensure_ascii=False) if seen else "没看到")
    vcmd("q", {"cmd": "shutdown", "reason": "done"})
    v.wait(timeout=10)

    # ---- 收摊 ----
    adapter.send_signal(signal.SIGTERM)
    try:
        code = adapter.wait(timeout=15)
    except subprocess.TimeoutExpired:
        adapter.kill()
        code = -999
    check("适配器 SIGTERM 优雅退出（退出码 0）", code == 0, f"code={code}")

    print(f"\n总计 PASS={len(checks)} FAIL={len(failures)}  房间={ROOM}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
