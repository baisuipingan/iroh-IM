# 新服务器 iroh 中继：最精简部署方案（v2 · Docker 版）

> 版本说明：v2 依据三个新决定重写 —— ① **纯中继、不打洞**（手机端也不打洞）② **Docker 分发**（不用 systemd）
> ③ **证书由 1Panel 管理**。v1 的 systemd/QAD 方案见 git 历史或 `README.md` §9 的两台现网实例。
>
> 实测依据（2026-09-29，香港机器上验证，未影响现网实例）：
> - Docker + `network_mode: host` + 官方镜像 `n0computer/iroh-relay:v1.3.0` → ✅ 跑通（镜像 49 MB / 压缩 15 MB）
> - **关闭 QAD**（不打洞就不需要）后：只监听 9443/tcp，客户端注册成功 `connected=true`，
>   **且与另一台中继上的客户端端到端收发成功**（`delivered`，对端真收到消息）✅
> - `cert_mode = "Reloading"` ❌ 启动失败（它期望的文件名与 1Panel 输出的不一致）→ 证书更新走"重新挂载 + 重启容器"

---

## 0. 新机器怎么装（唯一入口）

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"
```

问 3 件事（域名 / 证书来源 / 端口），全自动装完。卸载把 `remove` 加在末尾。
脚本本体在 `deploy/install/`（含托管说明与 Cloudflare Worker）。

**本文剩余部分讲原理与手工部署**，用于理解配置含义和排障；新机器不要手搓，直接用上面那条命令。

---

## 1. 相比 v1 砍掉了什么

| 项 | v1 | v2 | 原因 |
|---|---|---|---|
| QUIC 地址发现（QAD） | 开，占 `7842/udp` | **关** | QAD 只为打洞服务；客户端纯走中继时完全用不到 |
| 防火墙端口 | `15443/tcp` + `7842/udp` | **只有 `15443/tcp`** | 少一个暴露面，少一条规则 |
| 分发方式 | 静态二进制 + systemd | **Docker + compose** | 你熟悉 Docker |
| 证书 | acme.sh + systemd timer 同步 | **1Panel 签发 + 挂载目录 + 定时重启** | 你在 1Panel 里管更顺手 |
| systemd 依赖 | 需要 | **不需要**（compose + cron） | — |

**没变的两条硬约束**（都是实测出来的）：

1. 域名**必须 DNS-only，不能挂 Cloudflare 代理** —— 否则 TLS 终止点跑到 Cloudflare，长连接和中继语义都会出问题。
2. 数据库里那条：**中继之间不互转**，客户端拨号必须知道对端**当前真实所在**的中继 URL，填错就 20s 超时。
   （纯中继方案下这条依然成立，所以客户端侧如果要支持"换中继"，得靠地址发现或业务层交换地址。）

---

## 2. 最精简方案（三步上线）

### 2.0 前置（只有两件）

1. **DNS**：`relay-N.<你的域名>` A 记录 → 新服务器 IP，**只开 DNS，关掉 Cloudflare 代理**
2. **1Panel 里给这个子域建一个站点并申请证书**（纯静态站点即可，不用反代）
   → 证书会落在 `/opt/1panel/www/sites/relay-N.<你的域名>/ssl/{fullchain.pem,privkey.pem}`
   （这是 1Panel 的固定规范，文件名刚好与中继配置要求一致，**可以直接挂，不用复制**）

### 2.1 四个文件（都在 `deploy/relay/`）

```
docker-compose.yml      # 服务定义（host 网络 + 只读挂载配置与证书）
relay-docker.toml       # 中继配置（无 QAD；证书用 Reloading 自动重读）
.env.example            # 一个变量：证书来源目录
cert-sync.sh            # 把签发好的证书改成 default.crt/default.key（中继自动重读，免重启）
```

### 2.2 上线

```bash
# ① 传文件
scp -r deploy/relay root@<新IP>:/opt/iroh/

# ② 配证书来源（只有一个变量要改）→ 同步证书 → 起容器
cd /opt/iroh/relay
cp .env.example .env && vi .env      # 只改 CERT_SRC_DIR
./cert-sync.sh                       # 按 default.crt/default.key 放好（中继会自动重读）
docker compose up -d

# ③ 防火墙 + 证书自动同步（cron 每 6 小时；1Panel 的「计划任务」里加一条也行）
ufw allow 15443/tcp
(crontab -l 2>/dev/null; echo "0 */6 * * * /opt/iroh/relay/cert-sync.sh") | crontab -
```

### 2.3 配置全文（`relay-docker.toml`）

```toml
enable_relay = true
http_bind_addr = "127.0.0.1:0"           # 0 = 系统随便给个空闲口（不占 80/3340）
enable_quic_addr_discovery = false       # ★ 不打洞 → 不开 QAD → 不占 UDP 端口
enable_metrics = false                   # 不用就不开
access = "everyone"                      # 收紧见 §5

[tls]
https_bind_addr = "0.0.0.0:15443"         # 唯一对外端口
cert_mode = "Reloading"                  # 中继周期性重读证书 → 续期后免重启
cert_dir = "/etc/iroh-relay/certs"       # ★ 期望的文件名是 default.crt / default.key（实测）
```

**不要写 `[limits]`** —— 自建的目的就是摆脱限速；要防的是白嫖（→ 鉴权），不是带宽。

### 2.4 端口与防火墙

| 端口 | 用途 | 放行 |
|---|---|---|
| `15443/tcp` | 中继协议（WebSocket over TLS），客户端唯一入口 | ✅ 公网 |
| `9090/tcp` | Prometheus 指标 | ❌ 绑 127.0.0.1 |

就这一条：`ufw allow 15443/tcp`。

> 如果你更希望中继挂在 **443** 上（这样客户端 URL 里不用写端口），前提是那台机器 443 空闲；
> 已被 nginx 占用的话就走 nginx 反代的形态，见 §7。

---

## 3. Docker 的两个必须知道的坑（实测确认）

1. **必须 `network_mode: host`。**
   - 默认 bridge + 端口发布模式会让 relay 看到**全是 docker-gateway 的来源 IP**，日志/排障全废，限速与滥用防护也无从下手；
   - Docker 会自己写 iptables 的 `DOCKER` 链，**绕过 ufw**（你以为没封，其实开着）。
   - host 模式下容器直接绑主机端口，上述问题都不存在，`ports:` 也不需要写。
2. **镜像 tag 必须带 `v`**：`n0computer/iroh-relay:v1.3.0`（`1.3.0` 不存在）。
   多架构（amd64/arm64）都有，换 ARM 机器不用改任何东西。

容器里跑的是 root，挂载的证书**只需可读**；`/opt/1panel/www/sites/*/ssl/privkey.pem` 是 644，直接挂没问题。

---

## 4. 证书：Cloudflare DNS-01，一条路

只有一种做法，没有分支：

```
acme.sh --issue --dns dns_cf -d <域名> --server letsencrypt --keylength ec-256
```

- **不占任何端口**（DNS-01 只往 Cloudflare 加一条 TXT 记录），所以不用 80、不用 443、不依赖面板
- 需要一枚 Cloudflare API Token：`Zone → DNS → Edit` + `Zone → Zone → Read`，范围限定到你的域名
- Token 由脚本存到 `/root/.iroh-relay-cf-token`（`600`），**同一台机器只问一次**；要换就删掉这个文件
- 续期由脚本自己的 cron 负责（每 6 小时跑一次 `renew.sh`）。**不能指望 acme.sh 自带的全局 cron**——
  实测它不持久化 DNS 凭据，那样续期会静默失败

**踩过的两个坑（都写进脚本了）：**

1. **中继的证书重载轮询间隔是 24 小时**（源码常量 `DEFAULT_CERT_RELOAD_INTERVAL = 24h`）。
   所以"续期零重启"成立，但**换成新证书最长要等 24 小时**。证书是在到期前 30 天续的，等 24h 无影响；
   真要立刻生效：`cd /opt/iroh/relay && docker compose restart`（几秒）。
2. **`cert_mode = "Reloading"` 期望的文件名是 `default.crt` + `default.key`**，不是 `fullchain.pem/privkey.pem`。
   名字不对会直接启动失败，所以脚本里有一层改名复制（`cert-sync.sh`）。

## 5. 鉴权（建议上线就做，别留 `everyone`）

| 方式 | 配置 | 适用 |
|---|---|---|
| 端点白名单 | `access.allowlist = ["<EndpointId>", ...]` | 人就几个、身份固定 |
| 共享 token | `access.shared_token = ["<token>"]` | 简单，但写在前端 JS 里等于公开 |
| **HTTP callout（推荐）** | `access.http.url` + `bearer_token` | 中继每次连接回调你的服务，请求头带端点 ID；浏览器端**不用带任何凭据**，最干净 |

callout 的目标建议放 Cloudflare Worker：既能做白名单，也能做配额和封禁，顺便解决"前端拿不到秘密"的问题。

---

## 6. 验收（3 条命令，全绿即成功）

```bash
# 1) 证书可信 + 服务活着
curl -sS https://relay-N.<域名>:15443/healthz
#    → {"status":"ok","version":"1.3.0","git_hash":"unknown"}

# 2) 浏览器路径的 WebSocket 升级（必须带子协议，否则 400）
curl -i -m 6 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: iroh-relay-v2" https://relay-N.<域名>:15443/relay
#    → HTTP/1.1 101 Switching Protocols

# 3) 打开的浏览器里跑前端页面（frontend/index.html），点「探测全部中继」→「启动节点」
#    → 该中继显示「可达」，节点状态「在线」，中继列表里它显示「已连接」
```

（第 3 条是最终用户路径的验收，**也是唯一必需的一条**。服务器上没有浏览器时用 1、2 兜底。）

---

## 7. 关于 `relay-probe`：不是必需，但建议留一个

**它不是打洞用的**（打洞与否跟它无关），它的作用是：**在没有浏览器的服务器上，用真 iroh 客户端验证中继能不能承载业务流量**。

| 它能验的 | curl 验不了的部分 |
|---|---|
| 真实 iroh 客户端完成中继注册（选 home relay、报 `connected=true`） | curl 只能验到 WS 101 |
| 端到端收发消息（跨中继投递） | 无 |

但**它不是部署件**：不常驻、不开端口、不进 compose，只是 `dist/relay-probe` 一个 6.3 MB 的二进制。
而且它是**常驻节点的雏形**——两者共用 `client-wasm/src/node.rs` 那份核心逻辑，所以留着不额外占成本。

结论：**可以不部署**。要精简就删掉，验收退化成 curl 两条 + 浏览器一次；要排障就留着。

---

## 8. 常驻节点（按决定：跑在香港那台）

中继解决不了的只有三件事，都得靠一台**长期在线的原生 iroh 端点**：

| 能力 | 为什么中继做不到 |
|---|---|
| 房间历史消息 | 中继无状态，一转手就忘 |
| 在线状态 / 名册 | 同上 |
| "第一个进房间的人" | 纯 gossip 需要至少一个对端在线才有网络 |

- **位置**：香港（189.24.68.147，8C16G），和中继同机 —— 它自己连本地中继只有 ~0.1ms
- **形态**：独立容器/进程，**不复用中继端口**，作为 iroh 客户端连 `relay-1:15443`
- **身份**：SecretKey 落盘持久化，EndpointId 写进前端配置，所有人都认识它
- **它能看到消息内容**（因为它是协议参与者，不是因为解密）—— 产品上要跟用户讲清楚，它不是中心服务器
- **纯中继对它完全够用**：它和浏览器一样不走打洞，所以 v2 砍掉 QAD 对它没有影响

---

## 9. 换机器 / 升级（顺序不能反）

**relay 协议版本兼容是单向的：老客户端能连新中继，新客户端连不上老中继。**

1. 新机器按 §2 上线，名单里**加上**新 URL → 观察（`docker logs` + 9090 指标）
2. 前端名单里把旧 URL 标记 `enabled: false`，观察一个周期
3. 旧机器 `docker compose down`（中继无状态，**不需要迁移任何数据**）

前端名单里建议带上中继的 iroh 版本号，启动时校验，避免"新前端连老中继"这类静默故障。

---

## 10. 附：为什么一开始没用 Docker（澄清）

中继**从未编译过**，一直用的是官方预编译二进制（v1.3.0 musl 静态，10 MB），源码零改动。
之前编的是**客户端**：① 浏览器 wasm 包（iroh 官方不提供 npm 包，必须自己写 wrapper 编）；
② 原生测试客户端（官方 `iroh-doctor` 预编译版的 TLS 是坏的，连不上自建 HTTPS 中继，只能自己编）。

当时选二进制只是权衡（无 docker 依赖、systemd 管生命周期），**不是 Docker 不行** —— v2 已改成 Docker。
