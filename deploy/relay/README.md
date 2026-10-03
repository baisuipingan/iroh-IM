# iroh-relay 部署说明（自建中继舰队）

> **新服务器请先看 `docs/relay-deploy-minimal.md`**（最精简方案：3 步上线、文件/端口清单、Docker 与二进制两种分发方式的取舍、验证清单）。
> 本文件是完整的部署件说明与运维细节。

本目录是**可复用的中继部署件**，用于在任意一台服务器上快速拉起 iroh 中继。
设计目标：贴合"频繁更换服务器"的使用方式——中继无状态，服务器换了就重新部署一遍，前端只改名单。

---

## 1. 目录内容

| 文件 | 用途 |
|---|---|
| `install-relay.sh` | 幂等安装脚本：装二进制、建用户、装配置、装 systemd 单元、开防火墙、启动 |
| `relay-a.toml` / `relay-b.toml` | systemd 版实例配置（现网两台在用） |
| `relay-docker.toml` | **Docker 版配置（推荐）**：纯中继不打洞，无 QAD，只暴露 8443/tcp |
| `docker-compose.yml` + `.env.example` | **Docker 版编排**：官方镜像 + host 网络 + 只读挂载 1Panel 证书目录 |
| `cert-sync.sh` | 把外部签发的证书改成 `default.crt/default.key`（Reloading 模式自动重读，**免重启**） |
| `iroh-relay@.service` | systemd 模板单元，`iroh-relay@<name>` 对应 `/etc/iroh-relay/relay-<name>.toml` |
| `probe-relay-matrix.sh` | 多中继语义实验（E1–E5），验证跨中继行为 |
| `test-failover.sh` | 中继故障自动切换测试 |

## 2. 在新服务器上部署

```bash
# 1. 拷过去
scp -r deploy/relay root@<新服务器>:/opt/iroh/

# 2. 按需改端口/实例名，然后跑（默认装 a、b 两个实例）
ssh root@<新服务器> 'cd /opt/iroh/relay && bash install-relay.sh'
# 只装一个：bash install-relay.sh a
# 指定版本：IROH_RELAY_VERSION=1.3.0 bash install-relay.sh a
```

脚本做的事（全部幂等）：

1. 按 CPU 架构从 GitHub Releases 拉 `iroh-relay-v<版本>-<triple>.tar.gz` 并装到 `/usr/local/bin/iroh-relay`（已有匹配版本则跳过）。
2. 建系统用户 `iroh-relay`（中继以非 root 运行，端口都在 1024 以上）。
3. 配置写到 `/etc/iroh-relay/relay-<name>.toml`。
4. 装 systemd 模板单元并 `daemon-reload`。
5. 按配置里声明的 `http_bind_addr` 端口自动 `ufw allow`，并放行 `7842/udp`（QAD 用）。
6. `enable --now` 各实例，打印监听状态。

## 3. 验证

```bash
# 健康检查（服务端自带，无需鉴权）
curl -s http://<host>:3340/healthz
# => {"status":"ok","version":"1.3.0","git_hash":"unknown"}

# 服务端指标（Prometheus 格式）
curl -s http://127.0.0.1:9097/metrics | grep -E 'relayserver_(accepts|unique_client_keys|bytes)'

# 客户端侧：做成中继候选名单后探测
cat > /tmp/iroh.config.toml <<'EOF'
[[relay_nodes]]
url = "http://<host>:3340"
[[relay_nodes]]
url = "http://<host>:3341"
EOF
iroh-doctor --config /tmp/iroh.config.toml report
```

`iroh-doctor` 可从 <https://github.com/n0-computer/iroh-doctor/releases> 取对应平台二进制（macOS 版 21MB / Linux 版 11MB）。

## 4. 配置要点（iroh-relay 1.3.0 实测字段）

```toml
enable_relay = true
http_bind_addr = "0.0.0.0:3340"      # 不配则默认 [::]:80 —— 有 nginx 的机器会直接报错
enable_quic_addr_discovery = false   # 置 true 必须同时给 [tls]，否则启动失败
enable_metrics = true
metrics_bind_addr = "127.0.0.1:9097"
access = "everyone"                  # 见下：生产必须改

[limits]
accept_conn_limit = 20.0
accept_conn_burst = 40

[limits.client.rx]
bytes_per_second = 2097152           # 每客户端 2 MiB/s
max_burst_bytes  = 8388608           # 突发 8 MiB
```

TLS 段（上 HTTPS / QAD 时才需要）：

```toml
[tls]
https_bind_addr = "0.0.0.0:8443"
quic_bind_addr  = "0.0.0.0:7842"
cert_mode = "Manual"                 # Manual | LetsEncrypt | Reloading
manual_cert_path = "/etc/iroh-relay/certs/fullchain.pem"
manual_key_path  = "/etc/iroh-relay/certs/privkey.pem"
```

## 5. 访问控制（**生产必做**）

中继默认 `access = "everyone"`，等于开放代理，会被陌生人白嫖流量。三种收紧方式：

| 方式 | 配置 | 适用 |
|---|---|---|
| 端点白名单 | `access.allowlist = ["<endpoint-id>", ...]` | 设备固定、数量少 |
| 共享 token | `access.shared_token = ["<token>"]` | 简单，但**前端 JS 里等于公开** |
| HTTP callout | `access.http.url = "https://<你的鉴权服务>/relay-auth"` + `bearer_token` | **推荐**：Relay 每次连接回调你的服务，请求头 `X-Iroh-NodeId` 带端点 ID，返回 200 且 body 恰为 `true` 才放行 |

推荐架构：callout 指向 Cloudflare Worker，做 EndpointId 白名单 + 配额。中继本机再用 `[limits]` 做兜底限速。

## 6. 上 HTTPS（浏览器必需，需域名）

浏览器只能用 `wss://`，所以必须给中继一个**域名 + 可信证书**。本机 80/443 被 OpenResty/1Panel 占用，
因此中继自带的 ACME 走不通（HTTP-01 要 80、TLS-ALPN-01 要 443）。两个可选方案：

**方案 A（推荐）：中继自己终止 TLS，监听 8443 + 7842**
1. 加子域 A 记录，如 `relay1.example.com → <服务器IP>`；
2. 在 1Panel 里给该子域建站点并申请 Let's Encrypt 证书（1Panel 自动续期）；
3. 把证书软链/复制到 `/etc/iroh-relay/certs/`（或在配置里直接用 `cert_mode = "Reloading"` 指向证书目录）；
4. 配置 `[tls]` 段，端口用 8443/tcp + 7842/udp，`ufw allow 8443/tcp && ufw allow 7842/udp`；
5. 前端名单里写 `https://relay1.example.com:8443`。

优点：不经 nginx，无 WebSocket 超时/缓冲问题，路径最短。
缺点：证书文件需要自己同步（换证书时重启或用 Reloading 模式）。

**方案 B：1Panel/OpenResty 反代，中继只监听 127.0.0.1**
1. 子域建站点，1Panel 里配反向代理到 `http://127.0.0.1:3340`（务必开启 WebSocket 支持）；
2. 中继配置加 `[tls] dangerous_http_only = true`（禁止自己绑 HTTPS，仅保留 TLS 配置给 QUIC 用）；
3. QAD 仍直连 7842/udp（不经反代）。

优点：证书全由面板管，中继不暴露端口。
缺点：要调 nginx 的 `proxy_read_timeout`、`proxy_buffering off` 等长连接参数，多一跳。

## 7. 回滚 / 清理

```bash
systemctl disable --now iroh-relay@a iroh-relay@b
rm /etc/systemd/system/iroh-relay@.service /etc/iroh-relay/relay-*.toml
rm /usr/local/bin/iroh-relay
systemctl daemon-reload
ufw delete allow 3340/tcp; ufw delete allow 3341/tcp   # 按需
```
中继无状态，删除不影响任何数据。

## 8. 已踩过的坑

1. `iroh-relay` **默认绑 80**，在有 OpenResty 的机器上必定 `Address in use`，必须显式配 `http_bind_addr`。
2. `--dev` 模式与 TLS 配置互斥，且**不启动 QUIC 端点**（没有 QAD）。
3. `enable_quic_addr_discovery = true` 但没配 `[tls]` → 启动直接失败。
4. `iroh-doctor 0.101.0` 预编译版的 TLS 是坏的（`No rustls crypto provider configured`），只能测纯 HTTP 中继。
5. `pkill -f "iroh-doctor --config"` 写在 ssh 一行命令里会**连自己的 shell 一起杀掉**（命令行里含同名字符串），脚本里要用 `iroh-[d]octor` 这种自排除写法。
6. 中继协议版本兼容是**单向**的：老客户端能连新中继，新客户端连不上老中继。**换服务器/升级时先升中继，再发前端。**

---

## 9. 线上部署清单（2026-09-29 实测）

| 项 | iroh1 | iroh2 |
|---|---|---|
| 域名 | `iroh1.editor.vip` | `iroh2.editor.vip` |
| 服务器 | 189.24.68.147（**香港**，AS979，8C16G，1Panel+OpenResty，28 容器） | 85.209.49.6（**欧洲**，1C1G，跑着 xray/3x-ui） |
| 中继地址 | `https://iroh1.editor.vip:8443` | `https://iroh2.editor.vip:8443` |
| TLS 终止 | **中继自己做**（`https_bind_addr=0.0.0.0:8443`） | **nginx 反代**（8443 终止 TLS → `127.0.0.1:8342`） |
| 明文监听 | `127.0.0.1:3340`（仅本机） | `127.0.0.1:8341`（仅本机） |
| QAD/QUIC | `0.0.0.0:7842/udp` | `0.0.0.0:7842/udp` |
| systemd | `iroh-relay@a`（模板单元） | `iroh-relay.service` |
| 证书 | acme.sh `/root/.acme.sh/iroh1.editor.vip_ecc/`，由 `iroh-cert-sync.timer` 同步到 `/etc/iroh-relay/certs/` 并在变更时重启 | certbot `/etc/letsencrypt/live/iroh2.editor.vip/`，由 deploy hook `iroh-relay-iroh2.sh` 同步 |
| 限速 | **无**（未配 `[limits]`，不限速） | **无** |
| 鉴权 | `access = "everyone"`（待改成白名单/callout） | `access = "everyone"`（同上） |

验证过的关键事实：

```bash
# TLS 可信 + 健康检查
curl -sS https://irohN.editor.vip:8443/healthz       # {"status":"ok","version":"1.3.0"}
# 浏览器路径的 WebSocket 升级（必须带子协议，否则 400）
curl -i -m 6 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: iroh-relay-v2" \
  https://iroh1.editor.vip:8443/relay                 # HTTP/1.1 101 Switching Protocols
```

- 中继协议版本在 `Sec-WebSocket-Protocol` 里协商，当前是 `iroh-relay-v2`（老客户端会用 `v1`）。
- 浏览器发不了自定义 header，**鉴权 token 走 URL query `?token=`**（`x-iroh-relay-client-auth-v1` 头浏览器设不了）。

### 9.1 延迟基线（实测，用于前端择优）

| 路径 | 新建连接(含握手) | 复用连接后的真实 RTT |
|---|---|---|
| 香港 → iroh1（本机） | 59 ms | ~0.1 ms |
| 香港 → iroh2（欧洲） | 754 ms | **233 ms** |
| 香港 ↔ 欧洲 ICMP | — | 250 ms |

**结论：`GET /ping` 的处理开销可忽略，但新建 TLS 连接要付 2～3 个 RTT。**
前端探测必须"先预热再采样"，并优先读 `PerformanceResourceTiming` 的
`requestStart → responseStart`，否则测出来的数会差出 3 倍（754ms vs 233ms）。
实现见 `frontend/probe.js`。

### 9.2 iroh2 上的 nginx 关键配置（供扩展参考）

```nginx
server {
    listen 8443 ssl;
    server_name iroh2.editor.vip;
    ssl_certificate     /etc/letsencrypt/live/iroh2.editor.vip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/iroh2.editor.vip/privkey.pem;

    location = /healthz { proxy_pass https://127.0.0.1:8342/healthz; }
    location = /ping    { proxy_pass https://127.0.0.1:8342/ping; }
    location ^~ /relay  { proxy_pass https://127.0.0.1:8342; }   # WS 升级 + 长连接

    location / { return 404; }
}
```

注意：`proxy_pass` 指到 relay 的 loopback TLS 口（8342）。要保证 WebSocket 能升级，
必须带上 `Upgrade`/`Connection` 头透传，且 `proxy_read_timeout` 要放大（relay 心跳间隔内不能断）。

