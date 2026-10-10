---
name: iroh-agent
version: "1.0.0"
display_name: 用 iroh-agent 在终端里参与聊天室（发文字 / 发文件）
display_name_en: Participate in the chat room from a terminal with iroh-agent (text and files)
description: >-
  Use the iroh-agent CLI to act as an ordinary member of an iroh chat room from a machine with
  no browser and no Node (CI runner, server, agent host): send text messages, publish a local
  file, and push the bytes when a receiver clicks 接收. Use when the user asks to "send a file
  from the server to my chat window", "let the agent join the chat", "post a build result to the
  room", or otherwise wants a headless participant in an existing iroh room. Covers install,
  configuration, command reference, the multi-recipient --expect semantics, and troubleshooting.
description_zh: >-
  用 iroh-agent 命令行以普通成员身份进入 iroh 聊天室，适用于没有浏览器、没有 Node 的机器
  （CI、服务器、agent 主机）：发文字、把本地文件发进房间、并在接收方点「接收」后推送字节。
  当用户说"把服务器上的文件发到我聊天窗口"、"让 agent 参与聊天"、"把构建结果发到群里"，
  或想在现有 iroh 房间里加一个无头成员时使用。包含安装、配置、命令参考、
  多接收者的 --expect 语义与故障排查。
description_en: >-
  Headless CLI member for iroh chat rooms. Covers install, config, commands, the --expect
  multi-recipient semantics, and troubleshooting.
---

# iroh-agent · 无头命令行聊天室成员

`iroh-agent` 是一个**静态二进制**，让没有浏览器、没有 Node 的机器（CI、服务器、agent 主机）
以**普通成员**的身份进入 iroh 聊天室：发文字、把本地文件发进房间、并在接收方点「接收」后推送字节。

底层能力本来就齐了（同一个 crate 的 `filetest` 已在原生跑完整收发流程），它只是把那套能力包成一条命令。
**浏览器侧零改动** —— 接收流程本来就与「发送方是不是浏览器」无关。

## 什么时候该用这个 Skill

**该用**：
- 「把服务器上这个文件/项目打包发到我聊天窗口」
- 「让这个 agent / CI 参与聊天室」「把构建结果发到群里」
- 任何"往已有 iroh 房间里加一个无头成员"的需求

**不该用**：
- 接收方 —— 接收必须用浏览器，且限 **Chrome / Edge**（依赖 File System Access API；
  Safari / Firefox 不支持保存文件选择器）。**这个 CLI 不能接收，只能发送。**
- 只是想读历史消息 → 直接开网页，或查 roomd 的 SQLite。

---

## 一、安装

> **给别人装这个 Skill 本身**（让另一个 Agent 获得"会用 iroh-agent"的知识）：
> ```bash
> npx skills add baisuipingan/iroh-IM --skill iroh-agent
> ```
> 支持 Claude Code / Codex / Cursor / OpenCode 等 70+ 目标；
> 加 `-g` 装到用户目录、`-a <agent>` 指定目标、`-y` 免交互。
> 也可以只取这一个目录（仓库很大，别整仓 clone）：
> ```bash
> git clone --depth 1 --filter=blob:none --sparse https://github.com/baisuipingan/iroh-IM
> cd iroh-IM && git sparse-checkout set skills/iroh-agent
> ```
> 下面讲的是**装 CLI 二进制**，跟装 Skill 本身是两件事。

**先看平台**：有预编译产物的只有这 6 种组合（当前 Release：`agent-v1.2.0`）。
安装脚本会自动取**最新的 `agent-*` Release**（不是 GitHub 的 "latest" —— 见下），
不需要你手动指定版本；要锁版本就用 `AGENT_VERSION`。

> ⚠️ 为什么不能靠 GitHub 的 `releases/latest`：这个仓库有**两条产物线**
> （`agent-v*` 与 `android-v*`），而 Latest 全局只有一个 —— 谁最后发布谁就是它，
> 另一条线立刻 404（2026-10-10 真踩到过）。所以脚本改成按 tag 前缀解析。
不在表里（如 32 位 Windows、FreeBSD、musl 静态链接）就别试安装脚本，直接走源码构建。

| 平台 | 有预编译产物 |
|---|---|
| macOS（Apple Silicon / Intel） | ✅ |
| Linux（x86_64 / arm64） | ✅ |
| Windows（x64 / arm64） | ✅ |
| 32 位 Windows | ❌ 未验证，走源码构建 |
| 其它类 Unix | ❌ 走源码构建 |

Skill 自带安装脚本（推荐，会按平台选产物、校验 sha256）：

```bash
# macOS / Linux
bash scripts/install.sh
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

或者用项目的一键安装器（等价物）：

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"   # macOS / Linux
irm https://get.editor.vip/iroh/agent-install.ps1 | iex               # Windows
```

**不想动配置文件**：这些环境变量可以直接替代（CI 里最省事）——
`RELAY`、`TOKEN`、`ANCHOR_ID`、`NICK`；安装脚本会写进 `config.json`。
运行时另有 `IROH_AGENT_*` 系列覆盖（见下面「配置」）。

卸载：同样命令加 `remove`（脚本子命令 / PowerShell 的 `-Action remove`；
要连身份一起删再加 `CONFIRM=yes` / `-Confirm`）。

> 如果提示「下载失败（Release 里还没有这个平台的产物？）」，说明该平台没产物。
> **改用源码构建**（需要 Rust）：
> ```bash
> git clone https://github.com/baisuipingan/iroh-IM && cd client-wasm
> cargo build --release --locked --no-default-features --features cli --bin agent
> install -m 755 target/release/agent /usr/local/bin/iroh-agent
> ```
> ⚠️ **源码构建产出的文件名是 `agent`**（不是 `iroh-agent`），所以最后那行
> `install … /usr/local/bin/iroh-agent` 的改名是必须的 —— 后面所有命令都按
> `iroh-agent` 调用。Cargo 的 `required-features = ["cli"]` 也意味着
> **漏掉 `--features cli` 会直接报 `requires the features: cli`**。
>
> 上面**故意没写 `--offline`**：那是给"依赖已在本地缓存"的场景用的
> （CI 里先 `cargo fetch --locked` 再 `--offline`）。首次构建直接省掉它即可，
> 加了反而会因为缓存是空的而失败。

装完确认能用（**这一步会真的连中继**，能顺带验证配置对不对）：

```bash
iroh-agent whoami
```

期望输出里 `已连上中继，当前中继地址 = Some("https://…")`。
身份首次运行生成在配置目录里，**持久复用**（所以它在房间里是"固定的那个人"）。

## 二、配置

配置文件：`~/.config/iroh-agent/config.json`（Windows 是 `%APPDATA%\iroh-agent\config.json`）。
安装时用环境变量写入：

```bash
RELAY=https://iroh1.editor.vip:15443 \
TOKEN=<中继共享令牌> \
ANCHOR_ID=<常驻节点 64 位 hex 身份> \
NICK=构建机 \
CONFIRM=yes \
bash scripts/install.sh
```

```json
{
  "relays": ["https://iroh1.editor.vip:15443"],
  "relay_token": "…",
  "anchor": { "id": "…", "relay": "https://iroh1.editor.vip:15443" },
  "nickname": "构建机"
}
```

**运行时也可以用环境变量覆盖**（CI 里更方便，不用写文件）：
`IROH_AGENT_RELAY`（逗号分隔多台）、`IROH_AGENT_TOKEN`、`IROH_AGENT_ANCHOR_ID`、
`IROH_AGENT_ANCHOR_RELAY`、`IROH_AGENT_NICK`、`IROH_AGENT_HOME`（连配置目录一起指走）。

| 字段 | 作用 | 缺了会怎样 |
|---|---|---|
| `relays` | 中继地址（按顺序探测） | 连不上任何中继 |
| `relay_token` | 中继共享令牌 | 中继开了鉴权就**连不上** |
| `anchor.id` | 常驻节点（房间锚点）身份 | 进房可能超时、收不到历史、房间里也发现不了你 |
| `nickname` | 房间里显示的名字 | 用默认「命令行成员」 |

## 三、命令

```bash
iroh-agent whoami                                  # 打印身份 + 验证能连上中继
iroh-agent say   --room 房间名 "文本"                # 发一句话就退
iroh-agent send  --room 房间名 --file /abs/path     # 发布文件 → 等接收 → 退
iroh-agent send  --room 房间名 --file /abs/path --expect 3 --timeout 3600
iroh-agent watch --room 房间名                      # 常驻，交互式
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--room X` | 必填（`watch` 可省，用配置里的） | 房间名 = 访问凭据，别人知道就能进 |
| `--file PATH` | — | **本机绝对路径**。不支持 URL —— agent 是从磁盘读的 |
| `--expect N` | `1` | 等 N 个接收者**完成**就退出（见下面「多接收者语义」） |
| `--timeout SEC` | `1800` | 等待上限 |
| `--nick NAME` | 配置里的 | 房间里的显示名 |

`watch` 进房后的交互：

```
直接敲文字回车            = 发消息
send /path/to/file 回车   = 发文件
quit / exit              = 退出
```

## 四、多接收者语义（**最容易误解，先读这段**）

发布一个文件**不会**让任何人自动拿到 —— 发送端只是把文件「摆上货架」（房间里多出一张文件卡片）。
**每有人点一次接收，发送端就单独推一次给他**（`FileAccepted` 事件，各接收者状态互不影响）。

所以 `--expect N` = 「等到 N 个人接收完成就退出」：

| 你想干什么 | 用什么 |
|---|---|
| 投给一个人，他接收后 CLI 就结束 | `send`（默认 `--expect 1`） |
| 投给固定几个人 | `send --expect 3` |
| **任意时刻、任意多人**都能接收 | `watch`（常驻） |

⚠️ **`send` 默认退出的代价**：第一个人接收成功后进程就退出，**之后其他人再点接收会推不动**
（文件卡片还在，但推送端没了）。这不是 bug，是"一次投递"语义的必然结果。
要让更多人随时接收，就得用 `watch`。

## 五、典型场景

**场景 1：服务器 agent 把项目打包发到我的聊天窗口**（最常见）

```bash
tar czf /tmp/proj.tar.gz -C /path/to/project .
iroh-agent send --room 我的项目 --file /tmp/proj.tar.gz
# 然后在自己电脑的聊天窗口点「接收」
```

**场景 2：CI 构建完通知一下**

```bash
iroh-agent say --room 我的项目 "构建 #$BUILD_NUMBER 通过（$(date -u +%FT%TZ)）"
```

**场景 3：一次性投给固定几个人**

```bash
iroh-agent send --room 团队 --file report.pdf --expect 3 --timeout 600
```

**场景 4：agent 常驻，随时能发也能收**

```bash
iroh-agent watch --room 我的项目
```

**场景 5：完全不想写配置文件（CI 一次性）**

```bash
IROH_AGENT_RELAY=https://iroh1.editor.vip:15443 \
IROH_AGENT_TOKEN=… \
IROH_AGENT_ANCHOR_ID=… \
IROH_AGENT_NICK=ci \
iroh-agent send --room 通知 --file out.bin
```

## 六、故障排查

| 现象 | 原因与处理 |
|---|---|
| `iroh-agent: command not found` | 装到了 `$PREFIX`（默认 `/usr/local/bin`）但不在 PATH。Linux/macOS：把 `/usr/local/bin` 加进 PATH；Windows：把 `%LOCALAPPDATA%\Programs` 加进 PATH |
| 脚本报 `: unbound variable` 且行号在写配置之前 | 安装脚本在 `set -u` 下读了没传的环境变量。**已经装好二进制但配置没写出来** —— 别以为装完了。检查是否传了 `ANCHOR_ID` / `TOKEN`；脚本本身应该给每个变量兜底默认值 |
| `下载失败（Release 里还没有这个平台的产物？）` | ① Release 还没发布 → 改用下面那段源码构建；② 平台不在矩阵里（比如 32 位 Windows）；③ 自建镜像地址写错 |
| `校验和不匹配` | 产物损坏或被篡改。**不要**用"跳过校验"的方式绕过（有些脚本拿不到 `.sha256` 时会静默跳过 —— 那说明发布流程漏传了逐产物校验和，该修发布流程）。重下一次，仍失败就报错 |
| 提示「没拿到 .sha256，跳过校验」 | Release 里缺 `<产物名>.sha256`。安装脚本是按**逐产物**的 URL 取的，所以光有一份合并的 `SHA256SUMS.txt` 不够 |
| 进房超时 / `进房失败（可能没有锚点）` | `anchor.id` 没配或填错。它是 roomd 启动时打印的那串 64 位 hex |
| 连不上中继 / `连接中继超时` | `relay_token` 缺失或不匹配；`relays` 里的地址/端口不通。先用 `iroh-agent whoami` 单独验连通性 |
| 房间里有卡片但点「接收」没反应 | ① CLI 已经退出了（`--expect` 已满足）→ 改用 `watch` 或调大 `--expect`；② 接收端不是 Chrome/Edge；③ `available:false`（发送端内存里这个文件被淘汰） |
| `传输过程中对方拒绝接收` | 接收方点了拒绝。CLI 会继续等其他人（`--expect N` 还没满的话） |
| 文件卡片一直不出现 | agent 没进房成功；先看它的输出里有没有 `✅ 已进入房间`。另外历史里的文件卡片需要 anchor 参与 |
| 推送很慢 | 中继带宽/链路质量。可以用 `BENCH`/大文件先试；确认走的是 `hk-1` 这样的近端中继 |

**一条日志噪音**：退出时可能看到 `Endpoint dropped without calling Endpoint::close`。
`RoomNode::shutdown()` 只是把底层 close 派到后台任务、立刻返回，CLI 紧接着就退出了。
**纯日志问题，功能不受影响**（回执正常、退出码 0）。

## 七、注意事项

- **它只能发，不能收。** 接收必须用浏览器（Chrome / Edge）。
- **文件必须是本机路径**，不是 URL。
- **中继只转发密文**，看不到消息内容；但中继知道两端 IP 和在线时间。
- **房间名就是访问凭据**，谁拿到谁就能进。
- 身份密钥在 `~/.config/iroh-agent/identity.key`（0600）。**删掉它就换一个身份**，
  会变成房间里一个陌生人。
- 中继共享令牌（`relay_token`）**本质上是对客户端公开的**（每个浏览器都要下载它），
  所以它不是"服务器密钥"，别把它当高权限凭据对待。
- 并发推送会明显变慢；不要在一个进程里同时 `--expect` 好几个大文件。

## 八、深入

- 传输/协议细节与更多用法：[`docs/agent-cli.md`](../../docs/agent-cli.md)
- 端到端验证脚本（真实服务器 → 聊天室 → 浏览器接收并逐字节校验）：
  `scripts/e2e/agent-e2e.py`，见 [`docs/agent-cli.md`](../../docs/agent-cli.md) 的「端到端验证」
