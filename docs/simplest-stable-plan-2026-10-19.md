# 最简稳定方案：单机 Web 栈（不用 iroh）

> 日期：2026-10-19
> 结论：**一台 VPS + WebSocket 聊天 + HTTP 可续传文件 + 对象存储（R2）或本地盘。**
> 这不是"又一个选项"，是我建议你直接做的方案。聊天室是 C/S 问题，不是 P2P 问题。
>
> ⚠️ **如果核心是"每个人把自己的本地 agent 接进房间"（BYOA），请看
> [`agent-chat-simplest-plan-2026-10-19.md`](agent-chat-simplest-plan-2026-10-19.md)。**
> 那份是本文的 agent 专用版：同样不用 iroh，但保留 `agent-pi` 的大脑/ACP/权限逻辑，只换 transport。

---

## 0. 先看清：现在的复杂度花在哪

| 当前组件 | 作用 | 这个场景真的需要吗 |
|---|---|---|
| `iroh-gossip` 房间 | 消息广播、邻居发现 | ❌ 一个 WebSocket 广播就能做 |
| 3 台 `iroh-relay` | 浏览器 relay-only 的中转 | ❌ 浏览器本来就是 C/S，直接连服务器更简单 |
| `roomd` | 历史、presence 快照、入口 | ⚠️ 历史需要，但一个 SQLite 表就够 |
| wasm 客户端 + Worker | 在浏览器跑 iroh | ❌ 原生 WebSocket 更小、更稳 |
| 自研文件协议 | 16 KB 分块、位图、ACK、续传 | ❌ `tus` / S3 multipart 已经成熟 |
| `iroh-gossip` fork | 本地打补丁（死邻居修复） | ❌ 不用维护 fork |
| Android JNI + Rust `.so` | 移动端接 iroh | ❌ RN 自带 WebSocket/HTTP |

**结论**：这套复杂度的 80% 是为了 P2P/打洞/离线/无服务器；但浏览器端官方就是 relay-only，你付了 P2P 的复杂度，拿到的是 C/S 的行为。**不划算。**

---

## 1. 目标架构（一张图）

```text
浏览器 / 手机 / Agent
        │
        │  1) WebSocket：房间、消息、presence、typing
        │  2) HTTPS：文件上传/下载（tus 可续传）
        ▼
┌──────────────────────────────┐
│  Cloudflare（可选，TLS/代理） │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  1 台 VPS                    │
│  Caddy（TLS + 反代）          │
│  Go 应用（单二进制）           │
│  SQLite（消息/房间/用户）      │
│  tusd（可选，上传网关）        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  Cloudflare R2 / 本地磁盘      │
│  文件对象（按 file_id 存）     │
└──────────────────────────────┘
```

- **聊天只走 WebSocket**：一条长连接，服务端记 `conn → room`，消息落 SQLite，广播给房间成员。
- **文件只走 HTTP**：上传到 R2（预签名）或本地盘（tusd），消息里只发 `file_id / name / size / sha256`。
- **没有 relay、没有 gossip、没有 NAT 打洞、没有 wasm**。

---

## 2. 技术选型（一份清单，照着买/装）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | **Go 单二进制**（或 Node，选你们维护得动的） | 内存小、部署一个文件、无 GC 停顿；Node 也行，但别上重框架 |
| WebSocket | `github.com/coder/websocket`（Go）或 `ws`（Node） | 轻；自带 ping/pong |
| 数据库 | **SQLite（WAL）** | MVP 足够；单机写入几十条/秒毫无压力 |
| 消息 ID | 每房间自增 `seq`（服务端分配） | 天然有序；历史分页用 `?after=seq`，不用处理 gossip 乱序 |
| 文件上传 | **tusd**（tus 1.0） | 断点续传是协议自带；单二进制；支持 S3 后端 |
| 文件存储 | **Cloudflare R2**（首选）或本地盘 | R2 无出网费、耐久性托管；本地盘要备份 |
| 反向代理 | **Caddy** | 自动 TLS、WebSocket、配置短；记得关上传缓冲 |
| 部署 | Docker Compose 或 systemd | 一台机器；`caddy + app + tusd` 三个进程 |
| 前端 | **保留现有 UI**，只换网络层 | `timeline/composer/sidebar/filetransfer` 不动；替换 `net.js` + `iroh-worker.js` |
| 移动端 | RN 自带 `WebSocket` + `tus-js-client` | 去掉 JNI/Rust `.so`，反而更简单 |
| Agent/Bridge | WebSocket + HTTP 客户端 | 替换 iroh transport；协议消息可以复用 |
| 鉴权 | 房间口令/邀请 token + 签名 Cookie | MVP 够用；要账号再加 OIDC |

> 如果不想引入 tusd：用 R2 的 **S3 multipart + 预签名 URL**，前端自己记 `uploadId + ETag`。少一个服务，但客户端代码多一点。MVP 建议 tusd。

---

## 3. MVP 范围（只做这些）

1. **房间**：创建/加入（口令或邀请链接）、成员列表。
2. **消息**：文本、@、图片/文件卡片；服务端分配 `seq` 和时间戳；落 SQLite。
3. **历史**：按 `seq` 分页；刷新/重进房间能拉到。
4. **Presence**：WebSocket 连接即在线；断开即离线；服务端广播 join/leave。**不需要 35s TTL 猜。**
5. **文件**：上传（可暂停/续传）、下载（Range）、多接收方各自下载、失败重试。
6. **基础治理**：房间/用户限速、单文件大小上限、总配额、过期清理。
7. **部署**：Caddy + app + SQLite + R2/tusd；每日备份。

**MVP 不做**：E2EE、联邦、P2P、离线消息队列、语音/视频、复杂权限。这些都可以后加，且不影响主架构。

---

## 4. 为什么它更稳（对比当前）

| 故障模式 | 当前 iroh 栈 | 单机 Web 栈 |
|---|---|---|
| 传文件导致聊天闪断 | 文件与心跳共用中继 WebSocket，队列满就一起断 | 文件走 HTTP/R2，聊天 WS 完全不受影响 |
| 跨公网连不上 | 中继不互转、错中继 13s 超时、NAT/代理差异 | 普通 HTTPS/WSS，任何能上网的网络都能连 |
| 断线重连 | gossip 邻居/中继/topic 多层状态，容易半死 | WS 断开即重连；服务端 presence 准确 |
| 断点续传 | 自研位图 + 手动"继续接收" | tus 协议自带；刷新/换网都能续 |
| 多接收方 | 发送方 N 倍上行 | 上传一次，各自从 R2 下载 |
| 运维 | 3 relay + roomd + 证书 + BBR + 防火墙 + fork | 1 台 VPS + Caddy + 1 个二进制 |
| 升级 | wasm + JNI + relay + roomd 多端联动 | 后端滚动重启；前端静态资源 |

**核心差别**：当前架构把"聊天"和"文件"耦合在同一条 relay 链路上；新架构把它们彻底分开。**文件再大，也不会影响聊天。**

---

## 5. 迁移步骤（保留 UI，换网络层）

### 第 0 步：冻结与导出（0.5 天）

- 从 roomd 的 SQLite 导出房间、消息、成员；保留 `room / ts / from / nickname / text / file` 字段。
- 文件本身不在 roomd（只有 `FileRef`），不需要迁移字节。

### 第 1 步：新后端 MVP（3–5 天）

- Go 单二进制：`/ws`（聊天）、`/api/history`、`/api/rooms`、`/api/files/sign`（R2 预签名）。
- SQLite 表：`rooms / members / messages / files`；`messages(room, seq)` 唯一索引。
- WS 协议：`join / send / presence / ping / pong`；消息带 `seq`。
- tusd：`pre-create` 校验房间/大小，`post-finish` 写 `files` 表 + 广播文件消息。

### 第 2 步：前端换网络层（2–3 天）

- 新增 `js/ws-client.js`：连接、重连（指数退避）、心跳、消息队列。
- 新增 `js/upload.js`：`tus-js-client` 上传，进度/暂停/续传。
- 替换 `net.js` 的 `send/join/history` 调用；UI 组件不动。
- 文件卡片继续用现有 `filetransfer.js`，只是数据源从 iroh 事件换成 WS 事件。

### 第 3 步：并行运行与切换（2–3 天）

- 新栈部署到 `next.` 子域；导入历史；开两个房间做对比。
- 前端加 `?backend=ws` 灰度；稳定后 DNS 切主域。
- 旧栈保留只读 1 周，随时回滚 DNS。

### 第 4 步：移动端 / Agent（按需）

- RN：`WebSocket` + `tus-js-client`；删掉 JNI 和 `.so`。
- agent/bridge：WS + HTTP 上传；消息协议可复用。
- 下线 3 台 relay + roomd + iroh 相关 CI/构建。

---

## 6. 资源与成本（小规模）

| 组件 | 规格 | 说明 |
|---|---|---|
| VPS | 2 vCPU / 4 GB / 80 GB SSD | 100–500 并发聊天足够；文件走 R2 不占盘 |
| Caddy | 约 30 MB | 自动 TLS |
| Go app | 约 50–100 MB | 单二进制 |
| tusd | 约 50 MB | 可和 app 同机 |
| SQLite | 随消息增长 | 10 万条消息约几十到上百 MB |
| R2 | 按量 | 存储便宜、出网免费；下载走 R2 边缘 |
| 备份 | 每日 | SQLite 快照 + R2 版本/异机 |

如果要完全自包含：把 R2 换成 VPS 本地盘（或同机 MinIO/RustFS），但要做每日异机备份；文件带宽会占 VPS 出口。

---

## 7. 你会失去什么（诚实说）

| 失去 | 影响 | 补偿 |
|---|---|---|
| P2P / 无服务器存储 | 文件经过服务器/对象存储 | 对聊天室这是正常架构；省下的复杂度远大于收益 |
| 默认 E2EE | 服务端可见消息/文件 | 需要就客户端 AES-GCM 加密，服务端只存密文（Matrix 同款信封） |
| iroh 身份/离线发现 | 不能"拨 key 就找到人" | 聊天室不需要；用房间 token/邀请链接 |
| 纯离线/局域网直传 | 无网不能传 | 聊天室场景不需要；真要就单独做 LAN 传输 |

**如果 P2P/E2EE 是产品的核心卖点**，那不该走这个方案；但如果目标是"一个稳定好用的聊天室"，这些都不是刚需。

---

## 8. 如果必须保留 iroh（最小改动，不推荐作为终局）

- 保留 `iroh-gossip` 聊天；只把文件面换成 HTTP/R2；补 P0/P1。
- 好处：改动小、UI/移动端不用大改。
- 代价：仍然要维护 3 台 relay、roomd、gossip fork；浏览器仍是 relay-only；只是把"文件打爆中继"移走了。
- 这是**止血方案**，不是"最简稳定"。真正最简的是第 1 节的单机 Web 栈。

---

## 9. 一句话总结

**聊天室是 C/S 问题。用 C/S 的成熟栈：WebSocket 管聊天，HTTP/tus 管文件，SQLite 管历史，R2 管存储。**
一台 VPS、三个进程、一个数据库，比现在的 3 relay + roomd + wasm + 自研文件协议简单一个数量级，也稳定一个数量级。

---

## 10. 参考

- tus 协议：<https://tus.io/protocols/resumable-upload>
- tusd：<https://github.com/tus/tusd>
- Cloudflare R2：<https://developers.cloudflare.com/r2/>
- Caddy：<https://caddyserver.com/>
- Matrix 媒体仓库（分层参考）：<https://spec.matrix.org/latest/client-server-api/#content-repository>
