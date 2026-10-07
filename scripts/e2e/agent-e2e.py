"""端到端：服务器上的 iroh-agent 发文件，本地浏览器接收（真实中继 + 真实 roomd）。

这是 `iroh-agent`（无头 CLI 成员）唯一有意义的验证方式 ——
浏览器侧完全不用改，就用平时那套接收流程。
"""
import importlib.util, sys, time, json, os, subprocess

_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved

ROOM = os.environ.get("AGENT_E2E_ROOM") or f"agente2e{int(time.time()) % 100000}"
# 目标机器用环境变量传 —— 仓库里不写死任何主机（这是公开仓库）。
SERVER = os.environ.get("AGENT_SERVER", "")
SSH = ["sshpass", "-p", os.environ.get("AGENT_SSH_PASSWORD", ""),
       "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20", SERVER]
REMOTE_FILE = "/tmp/agent-e2e.bin"
SIZE = 512 * 1024

if not SERVER or not os.environ.get("AGENT_SSH_PASSWORD"):
    print("需要 AGENT_SERVER（形如 root@host 或 root@host:22）与 AGENT_SSH_PASSWORD")
    sys.exit(2)


def sh(args, **kw):
    return subprocess.run(SSH + args, capture_output=True, text=True, timeout=kw.pop("timeout", 180), **kw)

print(f"房间: {ROOM}")
for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page":
        tt.close_tab(t["id"])
time.sleep(0.6)

KEY = "a1" * 32
url = f"http://127.0.0.1:8099/?autostart=1&room={ROOM}&testid=1&key={KEY}"
tab = tt.open_tab(url)
page = tt.Page(tab["id"]); page.call("Runtime.enable")
tt.wait_until(page, "!!(window.__state&&window.__state().joined)", 120, label="进房")
page.ev("window.__iroh_useOpfs = true")
try:
    page.ev("window.__iroh_clearBitmaps()")
except Exception:
    pass
time.sleep(1.0)
print(f"浏览器已进房，身份 {page.ev('window.__state().myId')[:16]}…")

# 服务器上造一个 512 KiB 文件（内容可校验）
print(f"服务器造测试文件 {SIZE} 字节 …")
sh(["-o", "BatchMode=yes", "true"])  # 忽略 host key 之类
# ★ 字节必须用项目自己的测试文件模式：`readOpfsFile` 校验时按
#   `want = ((i / chunkSize) | 0) & 0xff` 逐字节比对（第 i 字节 = 第几块）。
#   用别的内容 it'll 一定报"字节不符"，那是**校验模式**不匹配，不是传输坏了。
CHUNK = 16384
gen = ("import sys\n"
       "c=" + str(CHUNK) + "\n"
       "sys.stdout.buffer.write(bytes(((i//c)&0xff) for i in range(" + str(SIZE) + ")))\n")
head = subprocess.run(["/Users/patrick/.workbuddy/binaries/python/versions/3.13.12/bin/python3", "-c", gen],
                      capture_output=True, check=True).stdout
assert len(head) == SIZE, f"生成的测试文件大小不对: {len(head)} != {SIZE}"
local_probe = "/tmp/agent-e2e-src.bin"
open(local_probe, "wb").write(head)
subprocess.run(["sshpass", "-p", os.environ.get("AGENT_SSH_PASSWORD", ""), "scp", "-q",
                "-o", "StrictHostKeyChecking=no", local_probe, f"{SERVER}:{REMOTE_FILE}"],
               check=True, capture_output=True)
print("  文件已放到服务器")

# 起 agent（后台），它在等人接收
print("启动 iroh-agent send …")
agent = subprocess.Popen(
    SSH + ["-o", "ServerAliveInterval=15",
           f"iroh-agent send --room {ROOM} --file {REMOTE_FILE} --expect 1 --timeout 240"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
time.sleep(14)   # 让它连上中继、进房、发布邀约

print("等浏览器出现文件卡片 …")
card = None
for _ in range(20):
    found = json.loads(page.ev("""JSON.stringify([...document.querySelectorAll('.msg--file')]
        .map(e => ({id: e.dataset.fileId, name: (e.querySelector('.filecard__name')||{}).textContent||''})))"""))
    if found:
        card = found[0]; break
    time.sleep(1.5)
if not card:
    print("❌ 浏览器没看到文件卡片")
    agent.kill()
    print(agent.stdout.read()[-2000:])
    tt.close_tab(tab["id"]); sys.exit(1)
print(f"  看到卡片: {card['name']}  id={card['id'][:16]}…")

print("点接收 …")
page.ev(f"window.__iroh_acceptFile({json.dumps(card['id'])})")
tt.wait_until(page, """(() => {
  const t = window.__iroh_transfers().find(x => x.file_id === %s);
  return t && ['done','failed','expired','rejected'].includes(t.state);
})()""" % json.dumps(card["id"]), 150, label="传输结束")
state = json.loads(page.ev("JSON.stringify(window.__iroh_transfers().find(x => x.file_id === %s))" % json.dumps(card["id"])))
print(f"  接收侧状态: {state['state']}  {state.get('error') or ''}")

print("等 agent 退出 …")
try:
    out = agent.communicate(timeout=120)[0]
except subprocess.TimeoutExpired:
    agent.kill(); out = agent.stdout.read()
print("---- agent 输出 ----")
print("\n".join("  " + l for l in out.strip().splitlines()[-14:]))

verified = page.ev("window.__iroh_verifyOpfs(%s, %d, 16384)" % (json.dumps(card["name"]), SIZE))
if isinstance(verified, str):
    verified = json.loads(verified)
ok = state["state"] == "done" and verified.get("ok") and agent.returncode == 0
print("\n---- OPFS 校验明细 ----")
print("  " + json.dumps(verified, ensure_ascii=False)[:600])
print(f"\n结论: 浏览器状态={state['state']} OPFS 校验={verified.get('ok')} agent 退出码={agent.returncode} → {'✅ 通过' if ok else '❌ 未通过'}")
tt.close_tab(tab["id"])
sys.exit(0 if ok else 1)
