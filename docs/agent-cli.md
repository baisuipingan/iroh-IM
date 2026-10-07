# iroh-agent · 无头命令行聊天室成员

让**没有浏览器、没有 Node** 的机器（CI、agent、服务器）以一个普通成员的身份进入聊天室：
发文字、发文件，并等对方点「接收」。

**它不是"curl 发文件"** —— 文件不走 HTTP，走的是 iroh 的点对点分块（`FILE_ALPN`）。
本仓库的服务端能力本来就是齐的（`filetest` 已在原生跑完整收发流程），
所以这个 CLI 只是把那套能力包成一条命令。

> 为什么不走 Cloudflare Workers：浏览器的接收动作是**向房间广播 accept**，
> 然后**发送方拨号把字节推过来**。所以发送端必须是一个浏览器能主动拨号的
> iroh 端点（要能 QUIC 连中继）。Workers 没有原始 UDP、也不能主动向外建
> iroh 连接，只能当 HTTP 中转 —— 而浏览器要的不是 HTTP 中转。

## 装

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"
bash -c "$(curl -sSL …/agent-install.sh)" remove      # 卸载
```

装完是**一个静态二进制**，运行时只用 `libc` / `libm` / `libgcc`（`ldd` 一看便知）。

GitHub Release 还没发布时，脚本会给出直接源码构建的命令：

```bash
git clone https://github.com/baisuipingan/iroh-IM && cd client-wasm
cargo build --release --offline --locked --no-default-features --features cli --bin agent
install -m 755 target/release/agent /usr/local/bin/iroh-agent
```

## 配置

`~/.config/iroh-agent/config.json`（**不要提交进仓库**）：

```json
{
  "relays": ["https://iroh1.editor.vip:15443"],
  "relay_token": "…",
  "anchor": { "id": "…", "relay": "https://iroh1.editor.vip:15443" },
  "nickname": "构建机"
}
```

环境变量可覆盖（CI 里更方便）：
`IROH_AGENT_RELAY`（逗号分隔）、`IROH_AGENT_TOKEN`、`IROH_AGENT_ANCHOR_ID`、
`IROH_AGENT_ANCHOR_RELAY`、`IROH_AGENT_NICK`、`IROH_AGENT_HOME`。

安装脚本的非交互形式：

```bash
RELAY=https://iroh1.editor.vip:15443 TOKEN=… ANCHOR_ID=… NICK=构建机 CONFIRM=yes \
  bash agent-install.sh
```

**身份**：首次运行生成 `~/.config/iroh-agent/identity.key`（权限 `0600`）并**持久复用**。
所以它在房间里是「固定的那个人」，你能认出它（而不是每次都冒出一个陌生身份）。

## 用

```bash
iroh-agent whoami                          # 打印身份，并验证能连上中继
iroh-agent say   --room X "构建完成"        # 发一句话就退
iroh-agent send  --room X --file Y          # 发布文件 → 等到 1 人接收完成 → 退
iroh-agent send  --room X --file Y --expect 3 --timeout 3600
iroh-agent watch --room X                  # 常驻，交互式
```

`watch` 进房后：

- 直接敲文字回车 = 发消息
- `send /path/to/file` 回车 = 发文件
- `quit` 退出

## ★ 多接收者语义（最容易误解的地方）

发布一个文件**不会**让任何人自动拿到 —— 发送端只是把文件「摆上货架」
（房间里会多出一张文件卡片）。**每有人点一次接收，发送端就单独推一次给他**
（`FileAccepted` 事件，各接收者状态互不影响）。

所以 `--expect N` 的意思是「等到 N 个人接收完成就退出」：

| 想干什么 | 用什么 |
|---|---|
| 把文件投给一个人，他接收后 CLI 就结束 | `send`（默认 `--expect 1`） |
| 投给固定几个人 | `send --expect 3` |
| **任意时刻、任意多人**都能接收 | `watch`（常驻） |

⚠️ **`send` 默认 `--expect 1`：第一个人接收成功后进程就退出，之后其他人再点接收会推不动**
（文件卡片还在，但推送端没了）。这不是 bug，是"一次投递"语义的必然结果 ——
要让更多人随时接收，就得用 `watch`。

## 端到端验证

`scripts/e2e/agent-e2e.py` 会：本地浏览器进房 → 服务器上 `iroh-agent send` →
浏览器用**平时那套接收流程**（OPFS 落地）→ 校验字节 → 比对 agent 的退出码。

```bash
AGENT_SSH_PASSWORD=… python3 scripts/e2e/agent-e2e.py
```

**浏览器侧零改动** —— 接收流程本来就与「发送方是不是浏览器」无关。
