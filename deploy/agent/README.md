# Agent 常驻部署（systemd）

把 `agent-pi`（pi-sdk 大脑）部署成聊天室里的**常驻成员**。本文以 2026-10-09 的一次真实部署为蓝本。

## 形态

```
systemd: iroh-agent-pi.service
  └─ /opt/node22/bin/node agent-pi/src/cli.ts --brain pi-sdk …   （适配器 + LLM）
       └─ /opt/iroh-agent/bin/agent serve …                      （行协议子进程）
            └─ 自建中继（与其他成员同一套协议）
```

与同机的 roomd / relay **完全隔离**：独立目录、独立身份、独立 systemd 服务，不碰它们的容器与数据。

## 步骤

> 前置：Ubuntu/Debian、x86_64、能出网（GitHub / nodejs.org / npm registry）。

**1) 目录**

```bash
mkdir -p /opt/iroh-agent/{bin,agent-pi,home,pi-agent,received}
```

**2) Node ≥ 22.18**（独立目录，不动系统包）：

```bash
VER=$(curl -s https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' | head -1)
mkdir -p /opt/node22 && curl -fsSL "https://nodejs.org/dist/latest-v22.x/$VER" | tar -xJ --strip-components=1 -C /opt/node22
```

**3) iroh-agent 二进制**（从 Release 拉取并做 sha256 校验；改脚本顶部 `VERSION` 可锁版本）：

```bash
# 把仓库里的 deploy/agent/install-release.sh 传上去后：
bash /opt/iroh-agent/install-release.sh
```

**4) agent-pi 源码与依赖**（本机打包上传，排除 node_modules）：

```bash
cd agent-pi && tar --exclude node_modules -czf - . | ssh root@<SERVER_IP> 'tar -xzf - -C /opt/iroh-agent/agent-pi'
ssh root@<SERVER_IP> 'cd /opt/iroh-agent/agent-pi && PATH=/opt/node22/bin:$PATH npm ci --no-audit --no-fund'
```

**5) 配置**（两个都 `0600`）：

- `/opt/iroh-agent/home/config.json` —— iroh 侧：`relays` / `relay_token` / `anchor` / `nickname`（内容与 `frontend/relay-config.json` 对齐）
- `/opt/iroh-agent/pi-agent/models.json` —— pi 侧：provider（如 OpenAI 兼容网关的 `baseUrl/api/apiKey/models`）。**缺了不会崩**，但消息进模型时会失败、不回。

**6) systemd**：

```bash
cp deploy/agent/iroh-agent-pi.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now iroh-agent-pi.service
```

**7) 验收**：

```bash
journalctl -u iroh-agent-pi -n 30 --no-pager   # 应看到 hello + 已进入房间
# 然后从任意成员 @它（默认昵称 服务器助手）或发 !你好
```

## 运维

| 想干什么 | 怎么做 |
|---|---|
| 看状态/日志 | `systemctl status iroh-agent-pi` / `journalctl -u iroh-agent-pi -f` |
| 换房间 / 昵称 / 文件策略 | 改 unit 的 `ExecStart` → `systemctl daemon-reload && systemctl restart iroh-agent-pi` |
| 收到的文件 | `/opt/iroh-agent/received/`（`--files accept` 时） |
| 身份 | `/opt/iroh-agent/home/identity.key`（删掉=换人；备份它可保持"还是同一个人"） |
| 停用 | `systemctl disable --now iroh-agent-pi` |

## 实测踩过的坑

- **ssh 会话里 `nohup … &` 起的后台任务会被会话清理**（1Panel / sshd 的会话回收）：
  长任务要么同步跑、要么直接做成 systemd 服务 —— 别指望 nohup 能留住。
- npm 的 shebang 是 `#!/usr/bin/env node`：unit 里必须显式
  `Environment=PATH=/opt/node22/bin:…`，否则 `env: 'node': No such file`。
- 二进制没装好时报错是 `spawn /opt/iroh-agent/bin/agent ENOENT`（`Restart=always`
  会一直重试，装好即自愈）。
- `models.json` 未配时：进程一切正常、能收消息，**就是不回**；
  `journalctl` 里能看到 `prompt 失败` / `No model selected`。
