# Matrix 是什么：一份完整架构说明

> 日期：2026-10-19
> 目的：把 Matrix 讲清楚——它是什么、不是什么、由哪些组件构成、一条消息怎么走、为什么复杂。
> 最后附：它和"agent 聊天室 / BYOA"的关系。

---

## 1. 一句话

**Matrix 是一套开放、联邦、可自托管、端到端加密的实时通信协议**，不是一个 App，也不是一台服务器。

- **协议**由 Matrix.org Foundation 维护，公开规范；
- **实现**有很多：Synapse（Python，参考实现）、Dendrite（Go）、Conduit（Rust）等；
- **客户端**有很多：Element（Web/桌面/移动）、Cinny、FluffyChat 等；
- **房间**可以跨服务器联邦：你在 A 服务器，我在 B 服务器，照样在同一个房间聊天；
- **E2EE** 可选：加密房间里，服务器只看到密文和元数据。

类比：**Matrix 像"聊天界的 SMTP + XMPP"**——每个人在自己的服务器上有账号，服务器之间互相投递；但 Matrix 比 email 多了房间状态、端到端加密、媒体仓库、机器人/桥接。

### Matrix 不是什么

| 常见误解 | 事实 |
|---|---|
| "Matrix 是一个聊天软件" | 它是协议；Element 才是客户端 |
| "Matrix 是一台服务器" | 它是联邦：很多 homeserver 互联 |
| "Matrix 是区块链" | 每个房间是事件 DAG，但没有全局链、没有共识挖矿；状态由确定性算法合并 |
| "所有消息复制到所有服务器" | 只有**参与房间**的 homeserver 复制事件；媒体是按需拉取+缓存 |
| "默认全加密" | E2EE 按房间开启；服务器仍能看到房间/成员/时间等元数据 |
| "只能聊天" | 还支持 VoIP、桥接 Slack/Discord/Telegram/IRC、bot、IoT 等 |

---

## 2. 四个核心角色

```text
┌─────────────┐   C-S API    ┌──────────────────┐   S2S API   ┌──────────────────┐   C-S API   ┌─────────────┐
│ 客户端 A     │─────────────>│ homeserver A      │<───────────>│ homeserver B      │<────────────│ 客户端 B     │
│ (Element)   │  HTTP/JSON   │ 账号/房间/媒体     │  联邦       │ 账号/房间/媒体     │  HTTP/JSON  │ (Element)   │
└─────────────┘              └──────────────────┘             └──────────────────┘             └─────────────┘
```

| 角色 | 作用 |
|---|---|
| **客户端** | 发消息、收消息、加密/解密、渲染 UI；通过 Client-Server API 连自己的 homeserver |
| **homeserver** | 你的"家"：账号、设备、房间事件、媒体仓库、联邦收发、推送、密钥服务 |
| **房间（room）** | 一个跨服务器的共享事件图；成员来自不同 homeserver |
| **联邦（federation）** | homeserver 之间用 Server-Server API 交换事件；不是所有服务器都参与每个房间 |

### 标识符

| 类型 | 形态 | 例子 |
|---|---|---|
| 用户 | `@localpart:server` | `@alice:example.org` |
| 房间 ID | `!opaque:server` | `!abc123:example.org` |
| 房间别名 | `#alias:server` | `#lobby:example.org` |
| 事件 ID | `$opaque` | `$event123` |
| 设备 ID | 客户端生成 | `DEVICE1` |
| 媒体 | `mxc://server/mediaId` | `mxc://example.org/abcd` |

**关键**：用户属于某个 homeserver；房间不属于任何单台服务器，而是参与者的服务器共同持有事件图。

---

## 3. 架构分层

### 3.1 Client-Server API（C-S）

- HTTP + JSON；客户端只和自己的 homeserver 说话。
- 同步：`GET /_matrix/client/v3/sync`（长轮询，带 `since` 游标）；不是 WebSocket。
- 发消息：`PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}`。
- 房间操作：创建、加入、邀请、离开、踢人、改状态。
- 媒体：`/_matrix/media/v3/upload`、`/_matrix/client/v1/media/download/...`。
- E2EE：设备密钥上传、to-device 消息、密钥备份。
- 扩展：Sliding Sync（MSC3575）用于大规模账号的快速同步；VoIP 用 WebRTC + TURN。

> 因为不是 WebSocket，客户端靠 `/sync` 长轮询拿增量；这是 Matrix 的"实时"机制。对普通聊天够用，但不如原生 WS 直接。

### 3.2 Server-Server API（S2S / Federation）

- homeserver 之间 HTTP + JSON 交换事务。
- **PDU**（Persistent Data Unit）：房间事件（消息、成员、状态），需要签名、参与状态解析。
- **EDU**（Ephemeral Data Unit）：typing、已读回执、presence 等瞬时信息，不持久化。
- 事件由**源服务器签名**；接收方验证签名、事件授权规则（auth rules）。
- 联邦不保证"所有服务器都有全部历史"：加入房间时通过 `backfill` 拉历史；媒体按需拉取。
- 联邦是最终一致：网络分区时可能出现分叉，靠 **state resolution** 合并。

### 3.3 房间模型：事件 DAG + 状态

每个房间是一张**有向无环图（DAG）**：

```text
$e1 (创建房间)
 ├── $e2 (Alice 发言)
 │     └── $e4 (Bob 发言)
 └── $e3 (Carol 改房间名)
       └── $e4 (合并)
```

- 每个事件带 `prev_events`（前驱）和 `auth_events`（授权事件）。
- **状态事件**（membership、name、topic、power levels、join rules）定义"房间此刻的状态"。
- **时间线事件**（m.room.message 等）是聊天内容。
- 网络分区会产生多个分支；**State Resolution v2** 用确定性算法合并，保证所有服务器最终得到同一状态。
- **Room version** 定义事件格式、授权规则、状态解析的版本；升级房间版本是受控迁移。

**这不是区块链**：没有全局共识、没有挖矿、没有代币；只是每个房间的事件图 + 确定性状态合并。

### 3.4 E2EE（端到端加密）

- **Olm**：1:1 的 Double Ratchet（前向保密）。
- **Megolm**：群组会话密钥，成员各自持有；用于房间消息。
- 设备有身份密钥 + 一次性密钥；登录新设备要验证（emoji/QR/交叉签名）。
- **Cross-signing**：用主身份密钥给设备签名，减少"每台设备手动验证"。
- **Key backup**：加密的房间密钥备份到服务器（服务器只存密文）。
- 服务器能看到：谁在哪个房间、何时发消息、消息大小、设备信息；**看不到明文**。
- 加密房间的媒体也要客户端加密；服务器无法生成缩略图。

### 3.5 媒体仓库（Content Repository）

- 上传：`POST /_matrix/media/v3/upload` → 返回 `mxc://server/mediaId`。
- 消息事件里只放 `mxc://` + 元信息；不传字节。
- 下载：客户端向**自己的** homeserver 请求；远端媒体由本机 homeserver 通过 S2S 拉取并缓存。
- 媒体**不可变**：重新上传 = 新 mediaId；适合缓存/CDN。
- 支持异步上传（`POST /media/v1/create` + `PUT`），但**规范没有断点续传**。
- 认证：新版推荐 `/_matrix/client/v1/media/download`，要求 access token；旧匿名端点逐步退场。

### 3.6 应用服务 / Bot / 桥接

- **Application Service（appservice）**：一种特权集成，注册 `as_token`、`hs_token` 和命名空间；可以创建"虚拟用户"（例如把 Slack 用户映射成 Matrix 用户）。
- homeserver 通过 HTTP **推送**事件到 appservice 的 `/transactions` 端点；appservice 也可以用 C-S API 发消息。
- **Bot** 也可以就是一个普通用户：用 C-S API 登录、`/sync` 收消息、`/send` 回复。
- **Bridge**：把 Slack/Discord/Telegram/IRC/XMPP 等接入 Matrix；通常用 appservice。
- **VoIP**：WebRTC + TURN；Matrix 只做信令。

> 对 BYOA（本地 agent）来说：**普通 bot 用户 + `/sync` 长轮询**是出站模型，适合 NAT 后的本地机器；
> **appservice** 需要 homeserver 能反向推送，通常不适合家用/公司内网的 agent。

---

## 4. 一条消息的完整旅程

场景：Alice 在 `example.org`，Bob 在 `example.net`，同一个房间。

1. Alice 的客户端用 C-S API 发 `PUT /rooms/{roomId}/send/m.room.message/{txnId}` 到 `example.org`。
2. `example.org` 校验 Alice 的权限、事件授权规则，分配 `event_id`，签名，写入本地事件图。
3. `example.org` 通过联邦把事件发给房间里其他参与服务器（`example.net`）。
4. `example.net` 验证签名/授权规则，把事件写入自己的事件图；如果状态有分叉，跑 state resolution。
5. Bob 的客户端用 `/sync` 从 `example.net` 拉到新事件。
6. 如果是加密房间：Bob 的客户端用 Megolm 会话密钥解密；密钥通过 to-device 消息/备份获得。
7. Bob 回复，反向走一遍。

**媒体**：Alice 先上传到 `example.org` 的媒体仓库，拿到 `mxc://`；消息里只带 `mxc://`。Bob 下载时，`example.net` 按需去 `example.org` 拉取并缓存。

---

## 5. 实现与部署

| 实现 | 语言 | 定位 |
|---|---|---|
| **Synapse** | Python/Twisted | 参考实现，功能最全；生产常用 Postgres；大实例要 workers |
| **Dendrite** | Go | 第二代实现，单二进制；功能覆盖不如 Synapse |
| **Conduit** | Rust | 轻量、单二进制；适合小社区 |
| **Element** | Web/TS + 移动 | 最常用的客户端；不是协议本身 |

Synapse 的典型部署：

```text
客户端 → 反向代理（Caddy/Nginx，TLS）→ Synapse（C-S + S2S）
                                      ├─ Postgres（事件/状态/账号）
                                      ├─ 媒体仓库（本地盘或 S3 兼容）
                                      ├─ Redis（缓存/worker）
                                      └─ TURN（VoIP）
```

**为什么 Synapse 重**：事件图/状态解析、联邦收发、E2EE 密钥、媒体、推送、workers、数据库，都是常驻组件；一个小房间也要一套完整栈。

---

## 6. 优缺点

### 优点

- **开放标准**：不被单一厂商锁定；客户端/服务器可替换。
- **联邦**：不同组织/服务器的人可以在同一个房间；适合社区、跨公司协作。
- **E2EE**：加密房间服务端只见密文；有交叉签名/密钥备份。
- **桥接生态**：Slack/Discord/Telegram/IRC/XMPP 等。
- **可自托管**：数据在自己服务器；可审计/可控。
- **不只是聊天**：VoIP、bot、IoT、工作流。

### 缺点 / 复杂度

- **重**：Synapse + Postgres + 媒体 + TURN + workers；小规模也要不少运维。
- **联邦的边界**：媒体不复制、源服务器挂了可能 404；联邦滥用/ spam 需要治理。
- **E2EE 的代价**：多设备验证、密钥备份、bot 接入加密房间很麻烦；服务端不能做内容审核/缩略图。
- **规范没有媒体断点续传**：大文件上传体验依赖客户端/对象存储。
- **状态解析/房间版本**：概念多，排障门槛高。
- **实时性**：C-S 是 `/sync` 长轮询，不是原生 WebSocket；大规模要 Sliding Sync。
- ** moderation**：没有全局管理员；权力在房间 power levels 和各服务器管理员手里。

---

## 7. 和"agent 聊天室 / BYOA"的关系

### 可以借的

| Matrix 的做法 | 借到你的 Hub |
|---|---|
| 事件与媒体分离：消息只带 `mxc://` + 元信息 | 消息只带 `file_id/url/sha256`；文件走 HTTP |
| 媒体不可变、按 ID 寻址 | `file_id` 不可变；下载 URL 可签名 |
| 下载认证、按房间成员校验 | Hub 发短期签名 URL；token 绑房间 |
| E2EE 信封（客户端加密，服务端存密文） | 需要隐私时加 AES-GCM；Hub 只存密文 |
| appservice/bot 模型 | 本地 agent 作为"成员"接入；但用出站 WS，不用 appservice 的反向推送 |
| 房间状态/power levels | 简化成成员角色（owner/member/agent） |

### 不该照搬的

- **联邦**：你的 agent 房间不需要跨组织服务器；一个 Hub 足够。
- **事件 DAG + state resolution**：单 Hub 用 `seq` 单调排序即可，不需要 DAG。
- **Synapse/Postgres/workers**：小规模用 SQLite 就够；不需要为了聊天室上 Matrix 全套。
- **appservice 反向推送**：本地 agent 在 NAT 后，homeserver 推不进去；出站 WS/`/sync` 才对。
- **Matrix 的 E2EE 设备/密钥管理**：如果 agent 只是房间成员，Hub 认证 + TLS 已够；要 E2EE 再加客户端信封。

### 结论

**Matrix 是"联邦聊天协议"的完整答案；你的产品是"单组织 agent 房间"的垂直答案。**
借它的**分层思想**（事件/媒体分离、引用/字节分离、认证/存储分离），不要背它的**联邦复杂度**。
如果将来要做"跨组织 agent 房间互联"，Matrix 才有结构性优势；那时再考虑桥接，而不是现在。

---

## 8. 常见问题

**Q：Matrix 和 XMPP 有什么区别？**
XMPP 更老、更模块化（XEP），核心协议轻；Matrix 原生带房间状态、E2EE、媒体仓库、联邦事件图，开箱更完整，但也更重。

**Q：Matrix 和 Slack/Discord 有什么区别？**
Slack/Discord 是中心化 SaaS；Matrix 是开放联邦协议，可自托管、可跨服务器、可 E2EE。代价是运维和体验打磨。

**Q：Matrix 能替代 iroh 吗？**
不是一层东西。iroh 是连接/传输层（QUIC/打洞/relay）；Matrix 是聊天/房间/媒体/联邦协议。Matrix 自己也要 TCP/TLS/WebRTC/TURN。

**Q：Matrix 适合做 agent 聊天室吗？**
可以，但重。Agent 作为普通 bot 用户用 `/sync` 出站接入是可行的；但 @ 路由、ACP 工具事件、权限、召唤器都要自定义。一个轻量 Hub 更贴合。

---

## 9. 参考

- Matrix 规范：<https://spec.matrix.org/>
- Matrix 官网：<https://matrix.org/>
- Synapse：<https://github.com/element-hq/synapse>
- Dendrite：<https://github.com/matrix-org/dendrite>
- Conduit：<https://conduit.rs/>
- Element：<https://element.io/>
- Content Repository：<https://spec.matrix.org/latest/client-server-api/#content-repository>
