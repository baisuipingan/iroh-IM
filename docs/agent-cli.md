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

## Agent Skill（教 Agent 怎么用，省得每次重复指导）

[`skills/iroh-agent/`](../skills/iroh-agent) 是一个可直接分发的 Skill：任何 Agent 读到它
就知道什么时候该用这个工具、怎么装、命令有哪些、以及**最容易误解的多接收者语义**。

```
skills/iroh-agent/
├── SKILL.md            # 元数据 + 触发条件 + 安装配置 + 命令 + 场景 + 排障 + 注意事项
└── scripts/
    ├── install.sh      # macOS / Linux，自包含下载 + sha256 校验
    └── install.ps1     # Windows，PowerShell 5.1 可用
```

装到本机让 Agent 自动发现：

```bash
cp -R skills/iroh-agent ~/.workbuddy/skills/      # 或你的 Agent 的 skills 目录
```

**Skill 里不携带二进制**，只带下载逻辑 —— 理由见下面「为什么不把二进制塞进 Skill」。

## 二进制分发

产物命名（**三处必须一致**：两个安装脚本 + 打包流程）：

| 平台 | 产物 | 压缩格式 | 打包机 |
|---|---|---|---|
| macOS (arm64) | `iroh-agent-darwin-arm64.tar.gz` | tar.gz | `macos-14` |
| macOS (amd64) | `iroh-agent-darwin-amd64.tar.gz` | tar.gz | `macos-13` |
| Linux (amd64) | `iroh-agent-linux-amd64.tar.gz` | tar.gz | `ubuntu-latest` |
| Linux (arm64) | `iroh-agent-linux-arm64.tar.gz` | tar.gz | `ubuntu-latest` + `gcc-aarch64-linux-gnu` |
| Windows (amd64) | `iroh-agent-windows-amd64.zip` | **zip** | `windows-latest` |
| Windows (arm64) | `iroh-agent-windows-arm64.zip` | **zip** | `ubuntu-latest` + `cargo-xwin` |

- **Windows 用 zip 而不是 tar.gz**：PowerShell 5.1 自带的 `Expand-Archive` 只支持 zip。
- 不做 32 位 Windows（`x86_64-pc-windows-gnu` 的 32 位变体在 iroh 的 QUIC 栈上没验证过）。
- 打包与上传：`.github/workflows/release-agent.yml`，打 `agent-v*` tag 触发，
  也支持手动跑（只构建不发布，方便先验证矩阵）。
- 每个产物都带 `.sha256`，安装脚本会校验；`SHA256SUMS.txt` 一并放进 Release。

### 平台判断现在是怎么做的

`deploy/install/agent-install.sh` 原本只有 `uname -s` + `uname -m`，也就是**只认 macOS/Linux**。
本次补上的部分：

| 缺什么 | 补在哪 |
|---|---|
| Windows 识别（`MINGW*` / `MSYS*` / `CYGWIN*` / `Windows_NT`） | `agent-install.sh` 的 `detect()`，识别到就分流到 PowerShell 版 |
| 架构兜底（Git Bash 的 `uname -m` 不可靠时看 `PROCESSOR_ARCHITECTURE`） | 同上 |
| Windows 安装器本体 | 新增 `deploy/install/agent-install.ps1`（32 位进程跑在 64 位上时用 `PROCESSOR_ARCHITEW6432` 判断） |
| Windows 产物用 zip | 两个脚本里按平台选后缀 |
| **Rust 侧的配置目录** | ⚠️ 关键：原来 `home()` 只读 `HOME`/`XDG_CONFIG_HOME`，**Windows 上通常没有 `HOME`**，取不到就退化成 `/root/.config`（在 Windows 上会建到盘根或直接失败）。现在 Windows 走 `%APPDATA%\\iroh-agent`，并用 ACL 限制到当前用户 |

> ⚠️ **诚实说明**：macOS 与 Linux 的产物已实测（端到端通过）。
> **Windows 与两个交叉编译产物（linux/arm64、windows/arm64）尚未在本机验证过**，
> 第一次跑 `workflow_dispatch` 才是它们的首次验证。

### 首次真实演练暴露的缺陷（已修，附验证方式）

发布链路是**第一次被完整走通**（此前只到"能编译"），一跑就暴露了 8 个缺陷。
它们全都属于同一类：**平时不报错、只在特定分支上失效**，所以光看代码很难发现。

| # | 缺陷 | 为什么致命 | 现状 |
|---|---|---|---|
| 1 | 打包出的产物名是 `agent-<os>-<arch>.*`，而四个安装脚本都按 `iroh-agent-…` 去取 | 下载必然 **404** | 打包前显式改名，并打印包内容核对 |
| 2 | 压缩包里的可执行文件叫 `agent`，安装脚本 `install "$tmp/iroh-agent"` | 解包后**找不到文件** | 同上 |
| 3 | `c 0;33 "…"` 未加引号 | `;` 被当命令分隔符 → `$2: unbound variable`，**脚本在下载前就死** | 改成 `c '0;33' "…"` |
| 4 | `set -u` 下 `$ANCHOR_RELAY` / `$TOKEN` / `$ANCHOR_ID` / `$NICK` 从未声明 | 报 unbound variable **直接终止**；但用户已看到"已安装二进制"，**以为装完了其实没写配置** | 全部在顶部给默认值 |
| 5 | 打包写 `$GITHUB_WORKSPACE/out`，上传读 `client-wasm/out/*` | `if-no-files-found: error` → **整个 job 失败** | 全程绝对路径，两处指向同一目录 |
| 6 | publish 步骤 `rm -f ./*.sha256` | 安装脚本按 `<asset>.sha256` 取 → 404 → 静默退化成"跳过校验"，**供应链校验从未生效** | 不再删除，只额外生成 `SHA256SUMS.txt` |
| 7 | `$have）` —— 全角括号紧跟变量名 | bash 把多字节字符的**首字节吞进变量名** → `set -u` 报 `have<乱码>: unbound variable`。**只在"校验和不匹配"时触发**，也就是唯一需要它工作的安全分支 | 改成 `${have}`；全仓扫出 12 处同类（`deploy/install/install.sh` 5、`build-wasm.sh` 2、`e2e-relay-test.sh` 2 等）一并修掉 |
| 8 | 校验和比对本身 | 见 #7 | 现在能正确拦截并给出期望/实际两个哈希 |

**第 7 条值得单独记一笔**：现象是安装被拦住了（安全行为对），但报的是
`have?: unbound variable` 这种与校验毫无关系的错，很容易被当成"脚本坏了"而去放宽校验。
真正的原因是 bash 的变量名解析规则 —— `$have）` 里的 `）` 是 3 字节，
bash 会把**第一个字节**当作变量名的一部分。修法永远是用 `${have}` 定界。

**验证方式**（可复现，不需要真实 Release）：本地起一个静态服务冒充
`releases/latest/download`，把上面打包脚本的产物丢进去，然后：

```bash
# 正常路径：应打印「校验和通过」并写出 config.json
AGENT_RELEASE_BASE=http://127.0.0.1:8923 AGENT_PREFIX=/tmp/t/bin AGENT_DIR=/tmp/t/cfg \
  ANCHOR_ID=<64位hex> TOKEN=t bash skills/iroh-agent/scripts/install.sh

# 篡改路径：往产物尾部追加一个字节，应明确报「校验和不匹配」且**不安装**
echo corrupted >> iroh-agent-darwin-arm64.tar.gz
AGENT_RELEASE_BASE=http://127.0.0.1:8927 … bash skills/iroh-agent/scripts/install.sh
```

两个安装脚本（`skills/…` 与 `deploy/…`）都要各跑一遍 —— 它们是同一约定的两份实现，
**缺陷 3、4、7 恰好是两份都有的**。

## 为什么不把二进制直接塞进 Skill

| 维度 | 直接携带二进制 | 脚本按需下载（**采用**） |
|---|---|---|
| 体积 | 6 个产物 × ~8.7 MB ≈ **52 MB**（Skill 通常应是纯文本） | Skill 本体 **< 30 KB** |
| 可维护性 | 每次改代码都要**重新提交几十 MB 二进制**，git 历史迅速膨胀 | 只改文本 |
| 版本更新 | Skill 可能被缓存/分发各处，**版本容易不一致** | 每次安装拿 `releases/latest`，或用 `AGENT_VERSION` 锁版本 |
| 离线可用 | ✅ 天然离线 | ❌ 需要能访问 GitHub（或用 `AGENT_RELEASE_BASE` 指内网镜像） |
| 供应链安全 | 二进制直接进仓库，评审负担重 | 有 `.sha256` 校验，且发布流程可见 |

**结论**：采用**脚本按需下载**。代价是首次安装需要网络 —— 对 CI / 服务器 / agent 主机这类场景，
这本来就必须有网络（要连中继），所以这个代价实际上是**零**。

真要离线，把 Release 挂到内网镜像后设 `AGENT_RELEASE_BASE` 即可，不必把二进制塞进仓库。
