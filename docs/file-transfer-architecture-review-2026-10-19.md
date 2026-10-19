# 文件传输架构复核：调参能救吗，还是要换方案？

> 日期：2026-10-19
> 直接回答：**参数要调，但只能止血；聊天层不用推翻，文件层要换。**
> 一句话：**浏览器端 iroh 本来就是 relay-only，本质是 C/S；既然是 C/S，文件就不该走 P2P 栈。**
> 实现细节（Matrix 怎么存、tusd 做什么、RustFS/MinIO 怎么选、部署形态）见
> [`file-plane-implementation-2026-10-19.md`](file-plane-implementation-2026-10-19.md)。

---

## 0. 结论先行

| 问题 | 回答 |
|---|---|
| 调 cwnd/流窗口能解决吗？ | **能止住最痛的一刀**（传输首秒打爆中继队列），1–2 天见效；但解决不了"单中继 + 单 WebSocket + 自研文件协议"的结构问题。 |
| 要重新设计整套架构吗？ | **不用重写聊天层，要重做文件面**。房间/消息/签名/历史保留；文件从 iroh relay 上摘下来，改成 HTTP 可续传 + 对象存储。 |
| iroh 不成熟吗？ | iroh 在**原生端 P2P/QUIC/relay** 上成熟；**浏览器端官方明确是 relay-only 的受限形态**，不是它的主战场。当前项目恰好用了它最不擅长的组合。 |
| 浏览器 WebRTC P2P 行不行？ | iroh 自己实测：不同住宅/办公 ISP **20% 成功**，移动网络/CGNAT/企业防火墙 **0%**。它需要 TURN 兜底，而 TURN 就是另一种中继。 |
| 聊天室传文件是难题吗？ | 不是。Matrix、XMPP、Slack、Discord、Telegram、Signal 的共识都是：**控制面走聊天协议，文件面走 HTTP/对象存储**，P2P 只做局部优化。 |
| 现在这套算不算造轮子？ | 算。自研的 16 KB 分块、位图、ACK、续传，是 `iroh-blobs` / `tus` / S3 multipart 的子集，但少了成熟度、测试和生态。 |

---

## 1. iroh 官方怎么说（调研证据）

### 1.1 浏览器端：所有流量必须走 relay，打不了洞

iroh 官方文档 [WebAssembly and Browsers](https://docs.iroh.computer/languages/wasm-browser) 原文：

> "All connections from browsers to somewhere else need to flow via a relay server. This is because we can’t port our hole-punching logic in iroh to browsers: They don’t support sending UDP packets to IP addresses from inside the browser sandbox."

同一页还写了官方对浏览器支持的定位：

> "We envision that most applications will use iroh browser support as an **additional feature** to complement existing deployments to desktops, native apps or servers."

**含义**：浏览器里的 iroh 不是"P2P 偶尔回落到 relay"，而是**永远 relay**。所谓 P2P 的复杂度（endpoint、ticket、ALPN、打洞、多中继）在浏览器里并没有换来 P2P 的收益，只换来一条**到中继的 WebSocket**。

### 1.2 `iroh-blobs` 是官方文件层，但浏览器只有 MemStore

[iroh-blobs](https://github.com/n0-computer/iroh-blobs) 提供了本项目自己实现的那一整套：

- 内容寻址（BLAKE3），每个 16 KiB 块单独可验证；
- 按字节/块范围请求（`ChunkRanges` / `RangeSpec`），**天然支持断点续传**；
- 多提供者并发下载，某个提供者掉线自动换下一个、从缺口继续；
- 官方 `sendme` CLI 就是它的封装。

但有两个硬限制：

1. **浏览器只有 `MemStore`**。官方 [browser-blobs 示例](https://github.com/n0-computer/iroh-examples/tree/main/browser-blobs) 的 README 原文：
   > "For now, only the in-memory store works in the browser, so there is no persistence."
   这意味着大文件要把整份内容放进 wasm 内存 —— 正是当前项目在 `filetransfer.rs` 开头拒绝 `iroh-blobs` 的理由（10 GB 不可能）。
2. **当前版本的 iroh-blobs 官方自己标注"还不算生产级"**（调研时主分支 README；依赖前请按你锁定的版本再确认）。README 原文：
   > "NOTE: this version of iroh-blobs is not yet considered production quality. For now, if you need production quality, use iroh-blobs 0.35."
   补充事实：主分支 `iroh-blobs 0.103.1` 的依赖已经是 `iroh = "1.0.0"`，所以它**能跟 iroh 1.x 配套**；`fs-store` 是默认 feature（redb），浏览器构建要关掉默认 feature、只用 `MemStore`。也就是说：**原生端可评估，浏览器端仍然解决不了大文件存储**；官方"非生产级"的注记要不要当回事，取决于你对官方承诺的要求。

### 1.3 iroh 自己的 WebRTC 实验：跨公网成功率很低

iroh 仓库 issue [#3250 "WebRTC datachannels"](https://github.com/n0-computer/iroh/issues/3250)（2025 年的实测）记录了真实网络测试：

| 场景 | WebRTC 直连成功率 |
|---|---:|
| 一端在公网 VPS / 无 NAT | 100% |
| 同一 LAN / 内网 / VPN / 热点 | 100% |
| 不同住宅/办公 ISP 线路 | **20%** |
| 移动网络 / CGNAT / 企业防火墙 / Guest Wi-Fi | **0%** |

结论：**跨公网 P2P 对浏览器不是"默认能成"，而是"少数场景能成"**。要做，就必须部署 TURN；TURN 转发流量，和自建中继是同一件事，只是协议换成 WebRTC。而且 WebRTC 的背压、分块、续传、SCTP 缓冲都要自己处理（参见生产实现总结：`bufferedAmount` 水位、动态分块 64 KB–1 MB、断线重连后按缺口续传）。

### 1.4 结论

- iroh 的成熟区：**原生端**的 QUIC 打洞、relay 兜底、gossip、blobs。
- 浏览器端：**官方定位是补充形态，relay-only**，适合聊天/小消息，不适合作为大文件的主通道。
- 当前项目把"浏览器 + 大文件 + 跨公网 + 自研协议"这四个最难的条件叠在一起，然后用调 cwnd 去救。**方向不对，参数再准也只能缓解。**

---

## 2. 业内成熟方案（调研）

### 2.1 一个共同点：控制面与数据面分离

| 系统 / 协议 | 文件怎么走 | 关键点 |
|---|---|---|
| **Matrix** | 独立的 **Content Repository**：`mxc://` URI，HTTP `POST/PUT` 上传、`GET` 下载；消息事件只带 `url` + 元信息 | 媒体与事件分离；支持"异步上传"（`POST /media/v1/create` + `PUT`）；规范本身**不做断点续传**，大文件靠对象存储/客户端分片 |
| **XMPP（XEP-0363）** | 聊天协议只发 **slot**（一对 PUT/GET URL），文件用 HTTPS `PUT` 直传，接收方 `GET` | 规范明确说 P2P（XEP-0096/0234）在**多接收者、离线存储、MUC 历史、消息归档**场景表现差，所以选择 HTTP 上传服务 |
| **tus** | HTTP 可续传上传：`HEAD` 查 `Upload-Offset`，`PATCH` 从偏移继续 | 1.0.0 稳定；服务端记偏移，客户端只需记住上传 URL；支持 checksum/并发分片 |
| **S3 / MinIO / R2** | Multipart Upload：分片上传、逐片重试、完成后合并；预签名 URL 直传 | 工业标准；天然支持断点、并行、CDN 下载；不经过聊天服务器 |
| **WebRTC（DataChannel）** | 浏览器 P2P，失败回落 TURN | 需要信令 + STUN/TURN；TURN 是带宽成本；生产还要处理 SCTP 背压、动态分块、重连续传 |
| **Slack / Discord / Telegram / Signal** | 文件上传到对象存储/CDN，消息里只发引用；大文件分片上传 | 聊天服务器不转发文件字节；下载走 CDN；离线可取 |

### 2.2 为什么它们不约而同地不用 P2P 做聊天室文件

XEP-0363 的理由写得最直白，也正好命中当前项目：

- 一次发给**多个接收者** → P2P 要开 N 条连接，发送方上行变成 N 倍；
- 接收方**离线** → P2P 文件根本送不到，除非发送方一直在线；
- 要进 **MUC 历史/消息归档** → P2P 的瞬时流无法被历史引用；
- 跨 **NAT/防火墙/移动网络** → 直连成功率低，最终还是要 TURN/中继。

**聊天室文件的第一需求是"可靠、可离线、可多播、可归档"，不是"省服务器带宽"。** 当前架构把优先级搞反了。

---

## 3. 当前架构的真实问题（为什么调参不够）

| # | 问题 | 调参能解决吗 |
|---|---|---|
| 1 | 浏览器 relay-only，所有字节走**一条**到中继的 WebSocket；聊天和文件共享同一条 TCP 连接 | ❌ 只能把爆点往后推；文件一大、人一多还会撞 |
| 2 | 文件传输是**自研协议**：16 KB 帧、位图、ACK、手动续传、30s/60s/120s/600s 四套超时 | ❌ 需要补的是协议成熟度，不是窗口 |
| 3 | 多接收方 = N 条并发流，每条都按 2 MB cwnd 起速 | ⚠️ 并发限流能缓解，但架构上仍是 N 倍上行 |
| 4 | 中继是**连通性兜底**，不是为批量数据设计的 CDN；自建三台也改不了单 WebSocket 复用 | ❌ 换更大带宽只是把成本转移 |
| 5 | 运行期失联没有自愈；gossip 消费任务 `Err` 即永久退出 | ✅ 这是应用层问题，P1 能修 |
| 6 | presence 心跳与文件抢同一条链路；TTL 35s 对拥塞太敏感 | ⚠️ 调 TTL/心跳能缓解，但根因是同链路 |
| 7 | `iroh-gossip` 是 vendored + 本地打补丁（2026-10-14/15 的死邻居修复） | ❌ 已经在维护 fork，升级成本会持续存在 |

**核心判断**：第 1、2、4 条是结构问题，调参只能改变"多快撞墙"，不能改变"一定会撞墙"。第 5、6 条是应用层缺陷，值得单独修。第 7 条是技术债，换文件层不会自动消失，但至少不再叠加自研协议。

---

## 4. 方案对比

| 方案 | 做法 | 浏览器 | 大文件 | 断点续传 | 跨公网 | 多接收方 | 改动量 | 风险 |
|---|---|---|---|---|---|---|---|---|
| **A. HTTP 可续传 + 对象存储（推荐）** | 文件直传 MinIO/R2/S3（tus 或 S3 multipart）；消息只发引用 | ✅ 原生支持 | ✅ 流式/分片 | ✅ 协议自带 | ✅ 普通 HTTPS | ✅ 天然支持 | 中（换文件面） | 低；需要存储/带宽/清理策略 |
| **B. 原生 iroh-blobs + 浏览器 HTTP** | 原生端用 iroh-blobs（fs store）P2P；浏览器走 A 的 HTTP 路径 | ✅ | ✅ 原生；浏览器分片 | ✅ blobs 自带 | ✅ | ✅ | 中大（两套路径） | 中；iroh-blobs 当前版本官方标注非生产级；两套逻辑 |
| **C. WebRTC + TURN** | 浏览器 P2P，失败走 TURN | ✅ | ⚠️ 需自己做背压/分块/续传 | ❌ 要自研 | ⚠️ 不同 ISP 20%、移动 0% | ⚠️ mesh 不超过 4–6 人 | 大 | 高；TURN 带宽、NAT 兼容、SCTP 缓冲 |
| **D. 只调参** | 当前架构 + cwnd/流窗口/限速/并发 | ✅ | ⚠️ 仍受单 WebSocket | ⚠️ 手动续传 | ⚠️ 慢上行仍可能闪 | ⚠️ N 倍上行 | 小 | 低；但只是止血，不是终局 |

**推荐路径**：**D 先止血（1–2 天）→ A 做目标架构（MVP 约 1–2 周）→ B 作为原生端可选加速 → C 只在"必须 P2P"的产品前提下考虑。**

---

## 5. 推荐目标架构

```text
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│   浏览器      │        │   原生客户端  │        │   其他成员    │
└──────┬───────┘        └──────┬───────┘        └──────┬───────┘
       │                       │                       │
       │  控制面（小消息）      │                       │
       └───────────┬───────────┴───────────┬───────────┘
                   ▼                       ▼
            iroh-gossip / roomd       HTTPS（分片/可续传）
            房间、消息、presence        │
                   │                    ▼
                   │             ┌──────────────┐
                   │             │  对象存储     │
                   │             │ MinIO / R2 /  │
                   │             │ S3 / OSS      │
                   │             └──────┬───────┘
                   │                    │
                   └──── 消息里只带 ─────┘
                         file_id / url / size / sha256
```

**分工**：

- **控制面**：iroh-gossip 继续负责房间、消息、presence、文件邀约的"元信息"。
- **数据面**：文件走 HTTPS 分片上传/下载（tus 或 S3 multipart），存对象存储；下载可走 CDN/预签名 URL。
- **消息**：只带 `file_id`、`name`、`size`、`sha256`、`storage`（`object` / `iroh`）、`url`（或 object key）。接收方点一下就能续传下载。
- **原生端可选 P2P**：如果产品坚持"桌面端局域网直传"，原生端可以保留 iroh-blobs（fs store + ticket），浏览器永远走 HTTP。两条路径用 `storage` 字段区分，不互相污染。

**这个架构解决的问题**：

- 文件不再和心跳抢同一条中继 WebSocket → 传文件时聊天不抖；
- 断点续传是协议自带，不依赖用户点"继续接收"；
- 多接收方不再 N 倍占用发送方上行（每人各自从对象存储下载）；
- 离线成员也能下载；文件可进历史；可加 CDN；
- 浏览器/原生/移动端统一走 HTTPS，不依赖 iroh 浏览器版的能力边界。

---

## 6. 迁移计划（不推翻聊天层）

### 第 1 步：止血（1–2 天，保留当前路径）

- 按 `docs/stability-review-2026-10-19.md` 的 P0：cwnd 2 MB→256 KB、流窗口 1.25 MB→1 MB、并发 ≤2、AIMD 限速。
- 目的：在换架构之前，先把"传文件必闪"压下去；也验证 RC-1 的判断。

### 第 2 步：文件面 MVP（约 1–2 周，1 人）

1. **存储**：起 MinIO（自建）或用 Cloudflare R2（出网费低）；建 bucket + 生命周期/配额。
2. **上传**：
   - 方案 1（推荐）：`tus-js-client` + tusd（或自己实现的 tus 端点），支持暂停/续传/checksum；
   - 方案 2：S3 multipart + 预签名 URL（浏览器直传，服务端只签名）。
3. **下载**：预签名 GET 或 CDN；支持 `Range`；大文件断点续传。
4. **协议**：`FileRef` 增加 `storage: "object" | "iroh"`、`sha256`、`object_key`/`url`；旧客户端忽略新字段即可。
5. **UI**：上传进度、暂停/继续、失败重试、多接收方各自下载；保留"复制链接"。
6. **安全**：短时效预签名 URL、房间成员鉴权、大小/类型限制、病毒扫描（可选）。

### 第 3 步：灰度与切换

- `?storage=object` 灰度 10% → 50% → 100%；
- 观察：上传成功率、P95 完成时间、续传成功率、对象存储 5xx、relay 丢包是否下降；
- 保留 iroh 文件路径 2 周作为 fallback，之后按数据决定删除或保留给原生端。

### 第 4 步：原生端可选 P2P（可选）

- 原生客户端接 `iroh-blobs`（fs store），用 `BlobTicket` 分享；
- 浏览器仍走对象存储；消息里 `storage` 字段区分；
- 这样桌面端局域网/大文件可以直传，浏览器不背 P2P 的复杂度。

---

## 7. 成本与取舍

| 项 | 方案 A（对象存储） | 方案 C（WebRTC+TURN） | 当前（iroh relay） |
|---|---|---|---|
| 服务器带宽 | 上传/下载走对象存储；自建 MinIO 需带宽 | TURN 转发全部流量，带宽成本最高 | 三台中继带宽；当前已是瓶颈 |
| 存储 | 需要（可设生命周期） | 不需要（但发送方需在线） | 不需要（发送方在线才行） |
| 断点续传 | 协议自带 | 自研 | 手动 |
| 多接收方 | 各自下载，不占发送方上行 | mesh 上行 N 倍 | 上行 N 倍 |
| 离线接收 | ✅ | ❌ | ❌ |
| 隐私 | 服务端可见文件（可客户端加密） | E2EE，TURN 只见密文 | E2EE，relay 只见密文 |
| 运维复杂度 | 低（对象存储成熟） | 高（TURN/ICE/兼容性） | 中（自建 relay + roomd） |

**如果"服务端不可见文件"是硬需求**：在客户端做 E2EE（例如 Matrix 的 AES-CTR + SHA-256 方案），对象存储只存密文；这样既保留隐私，又拿到 HTTP 的可靠性。代价是失去服务端缩略图/预览，需要客户端生成。

---

## 8. 如果坚持"无服务器存储 / 纯 P2P"，最低限度怎么做

这不是技术最优，而是产品取舍。最低限度：

1. **原生端**：用 `iroh-blobs`（fs store）+ ticket，别再自研分块/位图/ACK；它已经支持 BLAKE3 验证、范围请求、多提供者、续传。
2. **浏览器端**：接受"relay-only"，把文件限制在**小文件/图片**（例如 ≤ 20 MB），并且：
   - 给文件单独一条 relay（data relay），不要和 gossip 共用；
   - 强制 pacing + 小 cwnd；
   - 明确 UI 提示"浏览器大文件走中继，速度受服务器带宽限制"。
3. **大文件/跨公网**：引导到原生客户端，或提供"HTTP 上传"作为兜底。
4. **不要**把 WebRTC 当主路径：不同 ISP 20%、移动/CGNAT 0%，TURN 兜底又是一套中继，投入产出比很差。

---

## 9. 回答"是不是从头造轮子"

**是，而且造在了最不该造的地方。**

| 当前自研 | 成熟替代 | 建议 |
|---|---|---|
| 16 KB 分块 + `[u32 seq]` 帧 | iroh-blobs 的 BLAKE3 bao-tree / tus 分片 / S3 multipart | 换 |
| 位图 + IndexedDB 断点 | iroh-blobs range / tus offset / S3 part | 换 |
| 自定义 ACK + 四套超时 | HTTP 状态码 + tus/S3 语义 | 换 |
| 发送方逐块读 + 单流 | tus/S3 分片并行 + 预签名 | 换 |
| 房间模型 / 签名 / 历史 / presence | 无现成等价物（这是产品差异） | **保留** |

**该保留的**：iroh-gossip 的房间模型、消息签名、历史存储、presence 语义 —— 这些是这个产品的差异，不是轮子。
**该换掉的**：文件分块、位图、ACK、续传、重试 —— 这些是通用问题，成熟方案已经很多。

---

## 10. 参考

- iroh 浏览器限制：<https://docs.iroh.computer/languages/wasm-browser>
- iroh-blobs：<https://github.com/n0-computer/iroh-blobs>
- iroh-blobs 浏览器示例（MemStore only）：<https://github.com/n0-computer/iroh-examples/tree/main/browser-blobs>
- iroh WebRTC 实测成功率：<https://github.com/n0-computer/iroh/issues/3250>
- Matrix Content Repository：<https://spec.matrix.org/latest/client-server-api/#content-repository>
- XMPP HTTP File Upload（XEP-0363）：<https://xmpp.org/extensions/xep-0363.html>
- tus 可续传上传：<https://tus.io/protocols/resumable-upload>
- iroh relay 自托管说明（relay 是连通性兜底）：<https://github.com/thunderbird/thunderbolt/blob/main/docs/internals/architecture/iroh-relay-self-hosting.md>
