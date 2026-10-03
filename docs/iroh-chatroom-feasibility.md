# 基于 iroh 的浏览器聊天室 + 多中继动态切换：可行性调研与架构评估

调研日期：2026-09-29
调研基准版本：**iroh / iroh-relay v1.3.0**（1.0.0 于 2026-06-15 稳定发布；当前最新为 1.3.0）、Cloudflare Workers/Pages（2026 年运行时）
实测环境：服务器 189.24.68.147（Ubuntu 22.04 / 8C16G，1Panel + OpenResty 占用 80/443），详见 §8

---

## 0. 结论先行

**方案成立，但你的心智模型里有一处必须先纠正，否则会做出错误的技术选型。**

三句话：

1. **浏览器里的 iroh 永远只能走中继，打洞和直连在浏览器沙箱里不存在。** 这是官方明确的平台限制（不是"还没做"），你方案里最重的那个卖点（P2P 直连、~90% 流量不过服务器）对纯浏览器场景**完全不适用**，100% 流量会落在你自己的中继服务器上。
2. **"前端选择中继并建立信道"这件事 iroh 内核已经做了。** 它在启动时对所有已知中继做延迟探测，自动选一台延迟最低的作为 `home relay`，并暴露 `home_relay_status()` / `net_report()` 让你观测。你要做的不是"实现选择"，而是**给候选集、做质量评级、做故障剔除、必要时强制指定**。
3. **Cloudflare 只能托管控制面。** Workers 运行时没有 UDP、没有 WebTransport、没有入站 TCP，跑不了 iroh 节点，也跑不了原生 iroh-relay。Cloudflare 的正确位置是：静态前端 + 中继名单下发接口 + 中继鉴权回调。

**整体判断：架构成立，可以开工（中继侧已经上线两台，见 §9）。带宽不是本方案的约束——自建的目的就是摆脱第三方聊天服务的限速，所以中继配置里不要开 `[limits]` 限速。真正的成本项是"中继被陌生人白嫖"和"单机被打爆"，对应手段是鉴权与容量监控，不是限速。**

4. **【已实测，2026-09-29】中继故障自动切换确实可用，但"跨中继"的死穴也确认了**：客户端配置 [中继a, 中继b] 时，停掉 a 后 25 秒内自动切到 b，a 恢复后自动连回，应用层零重试逻辑。但反过来，**如果拨号时被指向的中继上并没有对端，即使该中继在你的候选名单里，连接也会超时失败（13 秒超时）** —— iroh 不会自动去对端真正所在的那台中继重试。完整实验见 §8。

---

## 1. 关键事实清单（调研结论）

### 1.1 iroh 1.0 的现状

| 项 | 事实 | 影响 |
|---|---|---|
| 稳定版本 | 1.0.0（2026-06-15），当前 1.0.3；wire protocol 与 API 有稳定承诺（仅覆盖 v1） | 可以用于生产，别再 pin 0.9x / RC 线 |
| 连接建立 | 直连打洞（QNT，约 9/10 成功）→ relay 兜底 → 地址查找（n0 DNS/pkarr，可选 Mainline DHT） | 浏览器场景**只剩第二层** |
| 传输 | 纯 QUIC（UDP）+ TLS 1.3，ALPN 协商；无 TCP 传输 | 企业网封 UDP 时只能靠 relay（浏览器本来也只走 relay） |
| 语言绑定 | Rust 原生；官方 FFI：Python / Node.js / Swift / Kotlin | 浏览器不在 FFI 列表里，走 WASM |
| 浏览器支持 | `wasm32-unknown-unknown` + wasm-bindgen 可编译；需 `iroh = { version = "1", default-features = false }` | 见 §1.3 的坑 |

来源：<https://docs.iroh.computer/languages/wasm-browser>、<https://www.iroh.computer/blog/v1>、<https://docs.iroh.computer/compatibility>

### 1.2 中继（iroh-relay）机制

- **架构**：一个 HTTPS 监听器同时承载两件事 ——（a）WebSocket 上的中继协议（自定义分帧，`ClientToRelayMsg` / `RelayToClientMsg`，含 Ping/Pong 保活）；（b）QUIC 地址发现（QAD），让端点从服务器侧得知自己的公网 (ip, port)。
- **端口**：HTTP 80 / HTTPS 443 / QUIC 7842（`DEFAULT_RELAY_QUIC_PORT` = 7842，即手机键盘上的 "QUIC"）/ metrics 9090。
- **无状态**：relay 不存业务数据，只做按 EndpointId 路由的盲转发；端到端加密由 QUIC/TLS 保证，中继看不到内容（但能看到两个 EndpointId、连接时间、流量大小、来源 IP）。
- **选择机制**：端点启动时对 `RelayMap` 里所有中继做延迟探测（QAD over QUIC 优先，HTTPS probe 延迟 200ms 作为兜底），选延迟最低的作为 **home relay**；home relay 是"对外广播的推荐入口"，不是唯一连接 —— 端点可以同时连着多台中继，非 home 连接有空闲回收（`inactive_timeout`）。
- **可观测 API（1.0）**：`Endpoint::home_relay_status()` 返回 `Watcher<Vec<RelayStatus>>`（含 `last_error`、`auth_denied_reason`）；`Endpoint::net_report()` 返回 `Watcher<Option<NetReport>>`（含各中继 `relay_latency`，**但被 `unstable-net-report` feature 门控，不保证语义化版本兼容**）；`Endpoint::online()` 等到至少一台中继完成握手。
- **运行期可变**：`Endpoint::insert_relay(url, config)` / `Endpoint::remove_relay(&url)` 可以在不重建端点的前提下改 `RelayMap`。
- **协议版本**：relay protocol v2（0.98 起上线）。**版本兼容是单向的：老客户端能连新中继，新客户端连不上老中继。** 自建中继升级顺序必须是"先中继、后客户端"。
- **鉴权**：默认开放；支持共享 token（`access.shared_token`）和 **HTTP callout**（`access.http.url` + `bearer_token`，每次连接回调你的鉴权服务，传入 EndpointId）；支持限流（`accept_conn_limit` / 每客户端 `bytes_per_second`）。

来源：<https://docs.iroh.computer/concepts/relays>、<https://docs.iroh.computer/deployment/troubleshooting>、<https://docs.rs/iroh/latest/iroh/endpoint/struct.Endpoint.html>、iroh-relay README（`defaults.rs` / 配置示例）

### 1.3 浏览器端的硬限制（本节是方案的核心约束）

官方原文要点：

> "No direct connections. All connections from browsers to somewhere else need to flow via a relay server."

- 不能发 UDP → 打洞逻辑无法移植 → **浏览器端点永久 relay-only**。
- 没有官方 npm 包 → 必须自建一个 `wasm-bindgen` wrapper crate 暴露 JS API。
- 必须 `default-features = false`（丢失 metrics 等 feature）。
- `iroh-gossip` 自 0.33 起支持编译到浏览器（1.0 同样可用），官方有 `browser-chat` 示例（React + Vite + wasm-pack）。
- iroh 团队明确表态：浏览器里永远做不到比 WebRTC 更好；未来可能用 WebRTC DataChannel 交叉隧道化 QUIC 报文，但**当前未实现**。

来源：<https://docs.iroh.computer/languages/wasm-browser>、<https://github.com/n0-computer/iroh-examples/tree/main/browser-chat>

### 1.4 Cloudflare 侧能做什么、不能做什么

| 能力 | 支持情况 | 对你的方案 |
|---|---|---|
| 静态前端托管（Pages / Workers Assets） | ✅ | 主战场，WASM 也放这里 |
| 出站 TCP（`connect()`） | ✅ | 无用于此 |
| WebSocket（服务端） | ✅，单条消息上限 32 MiB；配合 Durable Objects 做协调 | 只在你自研协议时才用得上 |
| **WebTransport** | ❌ Workers 运行时 API 列表里没有 | 意味着**不能用 Workers 做 iroh 的 QUIC/WebTransport 端点** |
| **UDP / 入站 TCP / QUIC 服务端** | ❌ | **跑不了原生 iroh-relay**（QAD 需要 UDP 7842） |
| 代理 UDP | ❌（仅 Enterprise Spectrum 可代理 UDP） | **中继必须直连暴露，别挂 Cloudflare 代理** |

来源：<https://developers.cloudflare.com/workers/runtime-apis/>、<https://developers.cloudflare.com/workers/runtime-apis/websockets/>

> 注：网上有文章声称 "Cloudflare Workers 原生支持 WebTransport" 并给出 `new WebTransport(request.url)` 示例。**该说法无法在 Cloudflare 官方文档中得到印证，官方运行时 API 清单中没有 WebTransport。** 不要基于这个说法设计架构；如需用，先自己写一个最小 worker 验证。

---

## 2. 架构评估：成立，但要分清控制面与数据面

```
┌─ Cloudflare（控制面，无状态业务逻辑）─────────────────┐
│  静态前端（WASM 包 + JS 探测逻辑）                     │
│  GET /relay-config.json  → 中继名单 + 版本 + 权重      │
│  GET /relay-auth         → iroh-relay 的 HTTP callout  │
└───────────────────────────────────────────────────────┘
             │ HTTPS（仅配置下载）
             ▼
┌─ 浏览器（relay-only 的 iroh 端点）───────────────────┐
│  wasm iroh endpoint + iroh-gossip（房间 = gossip topic）│
└───────────────────────────────────────────────────────┘
             │ wss:443（中继协议）  │ quic:7842（仅原生端点做 QAD）
             ▼                      ▼
┌─ 你的服务器（数据面，每台一个 iroh-relay，可随时丢弃）─┐
│  relay-a  relay-b  relay-c ...  无状态、不互转         │
└───────────────────────────────────────────────────────┘
             （可选）一台常驻原生 iroh 节点：消息历史 / 在线状态 / 离线消息
```

### 2.1 成立的部分

- 中继「无状态 + 可丢弃」的特性，和你「频繁更换服务器」的诉求**天然契合**：换服务器 = 换一个 relay URL，不需要迁移任何数据。
- 用 Cloudflare 承载名单下发，让你可以在不改前端的情况下增删中继 —— 这是这个方案最正确的一处设计。
- iroh 自带的中继故障切换（连不上就换下一台）+ 你的前端探测，双层保险。

### 2.2 必须纠正的部分（重要）

**误区：以为前端可以决定"这个房间走哪台中继"。**

实际语义是：

1. 每个端点**各自**选自己的 home relay（按自己的延迟探测结果），你只能给候选集。
2. 被中继的流量，走的是**对端广播的 home relay** —— A 要发给 B，若 B 的 home 是 relay-b，A 就得去连 relay-b。
3. 于是：一个房间里如果有 N 台不同的 home relay，一个浏览器可能同时维持 N 条 WebSocket 到不同中继（非 home 连接会被空闲回收，但只要还在通信就得保持）。

**推论：想让"一个房间只走一台中继"，就必须让全网客户端只配置一台中继（牺牲容灾），或者用配置把同一区域的用户钉死在同一台。** 想要"多中继容灾 + 单一数据路径"是矛盾的，只能二选一，或者接受"房间跨中继"。

> ✅ **第 2 点已于 2026-09-29 实测确认**（见 §8）：中继之间不互相转发；拨号方必须知道对端**真实所在的中继 URL**，否则连接超时失败——哪怕那台中继在拨号方的候选名单里也没用（E4 用例失败）。但有个意外的好消息：**对端的中继 URL 不必出现在拨号方的 RelayMap 里**，只要 URL 正确就能连上（E3 用例成功）。所以真正的约束是"**地址信息要正确**"，而不是"名单要完全一致"。

---

## 3. 多中继动态切换与连接质量探测：分层实现思路

### L1 名单层（Cloudflare）

- `GET /relay-config.json` 返回：`{ version, updated_at, relays: [{ url, region, weight, enabled }] }`。
- 前端**本地缓存 + 启动即用**（localStorage / IndexedDB），网络挂了也能拿到上次的名单 —— 否则 Cloudflare 一抖全站不可用。
- 名单带 `version`，探测结果上报时带版本号，方便你在后台看"哪个版本的中继质量最差"。

### L2 探测层（前端 JS，在启动 wasm 之前跑）

这是**你最该投入的地方**，因为 iroh 自带的探测（`net_report`）在浏览器里可能退化甚至不可用（QAD 需要 UDP；HTTPS probe 是兜底路径）。

两种可行探针，都能在纯 JS 里做：

1. **HTTPS RTT 探针**（与 iroh 内部 HTTPS probe 口径一致：它对 `GET /` 计时）：
   `performance.now()` 包一个 `fetch(relayUrl + '/', {cache:'no-store'})`，取 RTT。注意需要中继根路径可用（iroh 自己的 HTTPS probe 就是打 `/`）。
2. **WS 握手探针**：`new WebSocket('wss://<relay>/...')` 并测量 `onopen` 时间（≈ 1 RTT + TLS 握手）。中继协议需要加密握手，JS 侧无法完成，所以**只测握手时间，不要试图发协议帧** —— 它足够作为相对质量排序依据。

采样策略：

- 每台中继并发跑 5 次，取 `median`，同时记录 `min`（代表理想路径）与 `p90`（代表抖动）。
- 单次超时阈值 2s（`DIAL_ENDPOINT_TIMEOUT` 在 iroh 里是 1500ms，对齐）；连续 2 次超时直接剔除。
- 探测结果缓存 5～10 分钟，避免每次进房都探一遍。

### L3 判定层（打分 + 滞回）

```
score = w1·normalize(median_rtt) + w2·normalize(jitter) + w3·(fail_count>0 ? 1 : 0) + w4·region_penalty
```

- **滞回必须有**：只有当候选比当前优 20% 以上、或当前中继连续 N 次探测失败，才触发切换。否则网络一抖就反复换中继，gossip 连接来回重建，体验比慢更差。
- 用户可感知的质量指标不是"到中继的 RTT"，而是**端到端消息延迟**。建议在 gossip 消息信封里带 `seq + sent_at`，在客户端统计"到各 peer 的投递延迟 / 丢失率"，这才是 dashboard 上该展示的数。

### L4 生效层（iroh API）

| 场景 | 做法 | 代价 |
|---|---|---|
| 软控制（正常情况） | 按探测排序，把**前 K=2~3 台**放进 `RelayMode::Custom(RelayMap)`，让 iroh 自己挑最快 | 你无法精确指定，但换起来无感 |
| 硬指定 | `RelayMap` 里**只放 1 台** | 100% 指定，但没有容灾 |
| 运行期剔除坏中继 | `endpoint.remove_relay(&bad)` + `endpoint.insert_relay(good, cfg)` | 待验证：是否会触发 iroh 重新探测并切 home relay（`insert_relay` 的文档只说"加入 RelayMap"） |
| 保底手段 | 销毁旧 endpoint、用新 RelayMap 重建 | 必然生效；代价是 gossip 重连、几百 ms 消息中断、EndpointId 需从 IndexedDB 恢复才不变 |
| 状态观测 | 订阅 `home_relay_status()`，把 `last_error` / `auth_denied_reason` 接到 UI 与上报 | 这是"识别各中继连接状态"的原生抓手 |

---

## 4. 技术难点与风险点

| # | 难点 / 风险 | 严重度 | 说明与缓解 |
|---|---|---|---|
| 1 | **浏览器永久 relay-only** | 高 | iroh 的性能叙事对你不成立。中继的选址、带宽、机房质量 = 产品体验上限。→ 中继选址优先于功能开发 |
| 2 | **中继是流量的扇出点** | 中 | 一条消息 × N 个订阅者全部经过你自己的服务器。**带宽本身不是问题**（自建的理由就是要有大带宽、不限速，所以不要配 `[limits]`）。真正要防的是两件事：① 开放的 relay URL 被陌生人当免费代理白嫖（→ 上 EndpointId 白名单 / HTTP callout 鉴权）；② 单机被打爆（→ 加机器，中继无状态，横向扩展成本极低）。按房间分片到不同中继仍然值得，但目的是**就近接入降低延迟**，不是省流量 |
| 3 | **跨中继会导致连接数膨胀** | 中 | 见 §2.2。→ 要么接受，要么单中继配置（牺牲容灾），要么按区域 pin |
| 4 | **relay protocol 版本单向兼容** | 中高 | 新客户端连不上老中继。你"频繁换服务器"意味着经常有新老混部窗口。→ 固化发布流程：**先升中继、再发前端**；中继版本号写进名单接口，前端启动时校验并提示 |
| 5 | **WASM 无官方 npm 包** | 中 | 得自己维护一个 Rust wrapper crate + CI（wasm-pack / wasm-bindgen / wasm-opt）。产物体积需优化（`opt-level="z"`、brotli）。→ 把 wasm 构建纳入 CI，把 crate 版本号透传到前端 |
| 6 | **中继鉴权在浏览器里等于公开** | 中 | 共享 token 写进前端 JS 就是公开的。→ 用 HTTP callout 指向 Cloudflare Worker 做 EndpointId 白名单/配额（这是 Workers 最合适的用武之地），并开启 relay 侧限流 |
| 7 | **EndpointId 跨刷新不稳定** | 中 | 每个标签页默认生成新身份，会让白名单、房间身份、消息归属全乱。→ 把 SecretKey 持久化到 IndexedDB，启动时注入；同时处理"多标签页同一起点"的竞争（BroadcastChannel 选主） |
| 8 | **证书与 DNS 自动化** | 中 | 每台新服务器需要域名 + 有效 TLS 证书；relay 内建 ACME（Let's Encrypt）需要 80/443 可达，服务器在 NAT/代理后就拿不到证书。→ 用固定的 `relay-1/2/3.example.com` 做 A 记录切换，或 `cert_mode = "Reloading"` 读 Caddy 签发的证书；提前发 DNS 降低切换空窗 |
| 9 | **别把中继放在 Cloudflare 代理后面** | 中 | 443/WS 能过，但 7842/UDP 的 QAD 过不去 → 探测退化、公网地址发现缺失、可能触发空闲断连。→ 中继用 DNS-only（灰云）直连；Cloudflare 只管前端 |
| 10 | **纯 gossip 没有历史消息** | 中 | relay 无状态 + gossip 短暂 → 新进房间看不到历史，且必须有至少一个 peer 在线。→ 加一台常驻原生 iroh 节点（或应用层落库到 D1/KV） |
| 11 | **`net_report` 是 unstable feature** | 中 | 不保证语义化兼容；且在 WASM 下可用性未经验证。→ 前端探测逻辑不要依赖它，自己做 JS 探针，`net_report` 仅作为加分项 |
| 12 | **移动端/后台标签页** | 中 | iOS Safari 后台节流会挂起 WebSocket；切换网络后 WASM 端点的恢复行为与原生不同。→ 移动端体验单独测试，做好重连与"消息补发"逻辑 |
| 13 | **自建中继的滥用风险** | 中 | 开放的 relay URL 会被陌生人拿来跑流量（法律与成本风险）。→ 默认开鉴权（callout 白名单），只对自家前端签发的 EndpointId 放行 |

---

## 5. 方案对比（含替代路径）

| 维度 | A. iroh + WASM + 自建中继（你的方案） | B. iroh + 常驻原生节点 | C. Workers + Durable Objects 自研 WS 中继 + 应用层 E2E 加密 | D. WebRTC DataChannel + CF 信令 |
|---|---|---|---|---|
| 浏览器直连 | ❌ 永久 relay | ❌（浏览器侧） | ❌ | ✅ 真正的 P2P |
| 多中继可控性 | 中（能筛候选，不能强制路径） | 高（节点可 pin） | 高（自己写） | 低（ICE/TURN 决定） |
| 开发成本 | 高（Rust + WASM 工具链） | 高 | 低（纯 TS） | 中高 |
| 运维成本（换服务器） | **低（中继无状态，随换随扔）** | 中 | 高（DO 有状态、成本与迁移） | 中（需要 TURN） |
| 消息历史 / 持久化 | ❌ 需另加 | ✅ | ✅ | ❌ 需另加 |
| 身份模型 | 密钥身份，无中心签发 | 同左 | 自研 | 自研 |
| 生态可扩展 | ✅ 未来接原生/嵌入式客户端 | ✅ | ❌ | ❌ |

**判断：**

- 如果你**确定客户端只有浏览器**，C 的开发成本最低、可控性最高，iroh 的核心优势（打洞、无状态中继）你只能用到"无状态"这一半。
- 如果你**计划以后接原生客户端 / 嵌入式设备 / 桌面端**，A 是对的：那时打洞、Multipath、密钥身份全部生效，浏览器只是降级客户端。
- **B 建议无条件加上**：一台常驻原生 iroh 节点解决历史消息、在线状态、离线投递、以及"最后一个人退出房间后消息还在"的问题，成本极低（一台小机器跑一个 node，不需要它当中继）。
- 建议把"中继选择"抽象成一层传输接口（`TransportProvider`），业务层只依赖"发消息 / 收消息 / 当前连接质量"，这样将来从 A 换到 C 或 D 不用重写业务。

---

## 6. spike 清单与状态（截至 2026-09-29）

1. **WASM + 自定义 RelayMap + 鉴权跑通** —— 🟢 **核心已通（鉴权待做）**，见 §10。wasm 包已编出并在真实 Chrome 中连上自建中继；尚未接中继鉴权（当前两台都是 `access = "everyone"`）。
2. **跨中继互通语义** —— ✅ **已完成，见 §8.3**。结论：中继不互转；必须拿到对端**正确**的 home relay 地址；该中继不必在自己的 RelayMap 里；指向错误中继会 13s 超时失败。
3. **运行期切换 / 故障切换** —— 🟡 **部分完成**：故障自动切换已验证可用（§8.3 第 4 条），无需应用层重试。仍待验证：`remove_relay` + `insert_relay` 是否会重新探测并切 home relay（需自建 Rust 客户端；用 `iroh-doctor` 无法测）。
4. **Cloudflare 前端落地** —— 🟡 本地/服务器已跑通（静态托管可行），待上 Pages 实测 MIME/缓存/COOP-COEP。release wasm 实测 **2.67 MB（gzip 后 1.03 MB）**，低于 3MB 目标。

---

## 7. 建议路线

- **P0（1～2 天）**：4 个 spike，产出结论文档 + 一个能跑通的浏览器聊天 demo（单中继）。
- **P1（MVP）**：单中继 + 名单下发接口 + 中继状态面板（把 `home_relay_status` 的状态可视化）+ 自建中继鉴权（Worker callout）。同时加上常驻原生节点解决历史消息。
- **P2（多中继）**：JS 探测 + 打分 + 前 K 台候选 + 滞回切换 + 端到端质量统计上报。
- **P3（运营）**：中继版本/健康度后台、按房间分片、限流配额、CI 化的 wasm 构建与发布流程（含"先升中继再发前端"的强制检查）。

---

## 附：主要参考来源

- iroh 官方文档：<https://docs.iroh.computer/>（Browsers/WASM、Compatibility、Relays、Dedicated infrastructure、Troubleshooting、Net diagnostics）
- iroh 1.0 发布说明：<https://www.iroh.computer/blog/v1>
- API 参考：<https://docs.rs/iroh/latest/iroh/endpoint/struct.Endpoint.html>、<https://docs.rs/iroh/latest/iroh/endpoint/enum.RelayMode.html>
- 浏览器示例：<https://github.com/n0-computer/iroh-examples>（browser-chat / browser-echo / browser-blobs）
- iroh-relay 架构与配置：<https://deepwiki.com/n0-computer/iroh/6-relay-system>、iroh-relay README 与 `defaults.rs`
- Cloudflare：<https://developers.cloudflare.com/workers/runtime-apis/>、<https://developers.cloudflare.com/workers/runtime-apis/websockets/>

---

## 8. 实测验证记录（2026-09-29）

### 8.1 环境

| 项 | 值 |
|---|---|
| 服务器 | 189.24.68.147（Ubuntu 22.04，x86_64，8C / 16G / 155G，已用 59%） |
| 现有业务 | 1Panel 面板 + OpenResty 占用 80/443（TCP 与 UDP/443 即 HTTP/3），28 个 Docker 容器 |
| 公网出口 | 直连公网（egress IP == 189.24.68.147，无 NAT） |
| 防火墙 | ufw active，INPUT 默认 DROP；实测 80/443/15601 可入 |
| 部署内容 | `iroh-relay 1.3.0`（musl 静态二进制）+ systemd 模板单元，两个实例：中继 a = :3340，中继 b = :3341，均监听 `0.0.0.0`，纯 HTTP（本轮验证用），开启每客户端限速（2 MiB/s，突发 8 MiB） |
| 验证工具 | `iroh-doctor 0.101.0`（`report` / `accept` / `connect`） |

部署件在工作区 `deploy/relay/`（幂等安装脚本 + 配置 + systemd 单元 + 实验脚本），可复用到后续服务器。

### 8.2 可用性验证（通过）

- `GET http://189.24.68.147:3340/healthz` → `{"status":"ok","version":"1.3.0","git_hash":"unknown"}`，公网可达。
- 服务器本地 `iroh-doctor report`：中继被识别，`preferred_relay` = `http://127.0.0.1:3340/`，HTTPS 探测延迟 412µs（另一个 680µs）→ **"探测延迟、选最低者"的选择机制按预期工作**。
- **真机架客户端延迟**（探测机 → 该中继，纯 TCP 层）：`connect` 38–62 ms，TTFB 82–115 ms（5 次采样）。

### 8.3 多中继语义实验矩阵（关键结论）

| 用例 | 对端所在中继 | 拨号侧 RelayMap | 拨号时指定的 relay-url | 结果 |
|---|---|---|---|---|
| E1 | a | [a] | a | ✅ 连通 |
| E2 | a | [b] | **b**（对端不在 b） | ❌ 13s 超时失败 |
| E3 | a | [b]（**不含 a**） | **a**（对端真实所在） | ✅ **连通** |
| E4 | a | **[a, b]** | **b**（对端不在 b） | ❌ 13s 超时失败 |
| E5 | a | [a, b] | a | ✅ 连通 |

**结论（这四条直接决定架构）：**

1. **中继之间不互转，也没有"对端其实在别处"的兜底重试。** E4 说明：即使 a 就在拨号方的候选名单里、对端也确实在 a 上，只要拨号时被指向 b，连接照样失败。→ **生产实现里必须确保拿到的是对端最新的 home relay 地址**（靠地址发现 / 业务层交换地址），并且**对端换中继后要能通知出去**，否则会出现"双方都在线但连不上"的诡异故障。
2. **对端的中继不必出现在自己的 RelayMap 里。** E3 说明名单不完全一致也能连通——约束是"URL 正确"，不是"名单一致"。这降低了配置分发的一致性要求。
3. **空闲时只会维持到 home relay 一条连接**（阶段 1 实测：只有到 a 的连接，b 无连接）。所以"一个房间里 N 个对端分布在不同中继 → 浏览器开 N 条 WebSocket"这个担心在**空闲时**不成立，但在**活跃通信时**仍需实测（未能验证：需要多端同时在线）。
4. **自动故障切换可用（这是"频繁更换服务器"的关键能力）**：客户端候选名单 [a,b]，`systemctl stop` 掉 a 之后 **25 秒内**自动切到 b（b 的 `accepts_total` 5→6），恢复 a 后又自动重新连回，**应用层零重试代码**。

### 8.4 顺带拿到的可观测能力

中继自带 Prometheus 指标（`metrics_bind_addr`），实测可用字段包括：`relayserver_bytes_sent_total` / `recv_total`、`send_packets_{sent,recv,dropped}_total`、`got_ping_total` / `sent_pong_total`、`accepts_total`、`disconnects_total`、`unique_client_keys_total`、`http_connections_total`、`qad_*`。
→ **中继健康度面板可以用它做服务端指标**，与客户端的 RTT 探测互补（前端探测解决"选哪台"，服务端指标解决"哪台在被打爆"）。

### 8.5 本轮踩到的坑（会影响你的后续开发）

1. **`iroh-doctor 0.101.0` 的预编译二进制 TLS 是坏的**：任何 HTTPS relay 都报 `No rustls crypto provider configured while both ring and aws-lc-rs feature flags are disabled`。→ 该工具只能用纯 HTTP 中继做验证；要测 HTTPS/QAD 路径必须自建客户端（`iroh = "1.3"` 自己编）。
2. **`iroh-relay` 默认绑 80 端口**（`http_bind_addr` 不配就是 `[::]:80`），在有 OpenResty 的机器上直接报 `Address in use`。必须显式配置端口。
3. **`--dev` 与 TLS 配置互斥**，且 dev 模式不启动 QUIC 端点（无 QAD）。
4. **zsh 的 `timeout` 不存在**（macOS 默认），脚本里别用。

### 8.6 尚未验证（需要域名或第二台服务器）

1. **HTTPS/WSS + QAD 路径**：~~需要域名 + 可信证书~~ → **✅ 已完成，见 §9**。
2. **浏览器 wasm 客户端**：TLS 已就绪，剩编 wasm 包（Rust + wasm-pack，无官方 npm 包）。
3. **多个对端同时活跃时跨中继的连接数**：需要两个真实客户端同时在线。
4. **运行期 `insert_relay` / `remove_relay` 是否触发重新择优**：需要自建 Rust 客户端。

---

## 9. 中继舰队上线状态（2026-09-29）

两台自建中继已带 TLS 上线，**不限速**，`wss` 升级握手实测通过：

| | iroh1 | iroh2 |
|---|---|---|
| 域名 | `iroh1.editor.vip` | `iroh2.editor.vip` |
| 机器 | 189.24.68.147（**香港**，8C16G） | 85.209.49.6（**欧洲**，1C1G） |
| 中继地址 | `https://iroh1.editor.vip:8443` | `https://iroh2.editor.vip:8443` |
| TLS 终止 | 中继自身（`https_bind_addr=0.0.0.0:8443`） | nginx 终止 → `127.0.0.1:8342` |
| QAD | `7842/udp` | `7842/udp` |
| 证书续期 | acme.sh + `iroh-cert-sync.timer`（变更即重启中继） | certbot deploy hook |
| 限速 | 无 | 无 |
| 鉴权 | `everyone`（待改） | `everyone`（待改） |

**实测延迟基线：**

| 路径 | 新建连接（含握手） | 复用连接后的真实 RTT |
|---|---|---|
| 香港 → iroh1 | 59 ms | ~0.1 ms |
| 香港 → iroh2 | 754 ms | **233 ms** |
| 香港 ↔ 欧洲 ICMP | — | 250 ms |

**两个必须写进前端实现的结论：**

1. **探测必须复用连接。** `GET /ping` 端点本身零开销（复用后 0.1–0.3ms），但新建 TLS 连接要付 2–3 个 RTT：
   同一条路径量出 754ms 与 233ms，差了 3 倍。用 `PerformanceResourceTiming` 的
   `requestStart → responseStart`，并先预热。实现见 `frontend/probe.js`。
2. **浏览器连中继要靠 query 参数鉴权。** WS 子协议必须在 `Sec-WebSocket-Protocol` 里带
   `iroh-relay-v2`（不带会 400）；浏览器设不了自定义 header，所以鉴权 token 走 `?token=`。
   nginx 反代场景下还要确保 `Upgrade`/`Connection` 头透传、`proxy_read_timeout` 足够大。

前端消费的中继名单见 `frontend/relay-config.json`，探测与择优模块见 `frontend/probe.js`。


---

## 10. 浏览器客户端验证（2026-09-29 完成）

### 10.1 做了什么

自建了一个 wasm wrapper crate（`client-wasm/`，官方无 npm 包，必须自己写），三块结构：

| 文件 | 作用 |
|---|---|
| `src/node.rs` | 与平台无关的核心：`RelayMode::Custom` 建端点、观察 `home_relay_status`、收发消息 |
| `src/wasm_api.rs` | wasm-bindgen 暴露给 JS（feature `wasm`，默认开） |
| `src/bin/relay_probe.rs` | **原生验证客户端**（feature `cli`），用来验证 HTTPS/QAD 路径——`iroh-doctor` 的 TLS 是坏的，测不了 |

关键依赖（照抄官方示例才一次编过）：`iroh = { version = "1.3", default-features = false, features = ["tls-ring"] }`。
`ring` 需要 clang 才能编 wasm 目标，构建机要 `apt install clang lld llvm`。

### 10.2 实测结果（全部通过）

**原生客户端（服务器上）：**

| 用例 | 结果 |
|---|---|
| 单台中继 `https://iroh1.editor.vip:8443` | ✅ `home is now relay https://iroh1.editor.vip:8443/`，`connected=true` |
| 两台都在名单里 | ✅ 选 **iroh1**（香港，本机所在，延迟最低）作为 home relay；iroh2 空闲不连 |
| 跨中继投递：发送端 home=iroh1，对端在 iroh2，拨号指向 iroh2 | ✅ **delivered**，监听端真的收到 `cross-relay hello` |
| 同上但拨号指向 iroh1（对端不在那台） | ❌ 20s 超时（与 §8.3 的 E4 一致） |

**浏览器（服务器上 headless Chrome 154 + wasm 包）：**

```
节点状态 : 在线
本机 ID  : cfc798d74b3c7c296b5111884005a0be4471bff56824a7affd79e01611040a11
探测状态 : 2/2 可用
  iroh1.editor.vip:8443   hk-1   1.3 ms   可达
  iroh2.editor.vip:8443   eu-1   247.4 ms 可达
中继连接 : iroh1.editor.vip:8443  已连接
```

→ **浏览器里的 iroh 端点确实通过自建中继的 wss 完成注册，前端也能拿到每台中继的真实 RTT，并按延迟排序。**

体积（release，`lto + opt-level=z`）：**2.67 MB**，gzip 后 **1.03 MB**。

### 10.3 这一轮新踩到的坑（会直接影响前端实现）

1. **中继的 `/ping` 允许跨域读**（实测 `response.type == "cors"`、`status 200`），所以浏览器可以直接拿它当探针。
2. **但中继不发 `Timing-Allow-Origin`**，跨域资源计时的明细字段被浏览器清零：
   `requestStart` / `responseStart` / `connectStart` 全是 0，**只有 `duration` 可用**。
   → 探测逻辑必须是"有明细用明细，没有就用 duration"，且**必须先预热**，否则 duration 会包含 2～3 个 RTT 的握手。
   （修好后实测：hk-1 = 1.3ms、eu-1 = 247.4ms，与实际网络完全吻合。）
3. **dev 构建的 wasm 有 20.8 MB**，主线程编译会占住几百毫秒到数秒 —— 第一轮探测超时（2.5s）就是被它拖死的，一开始被我误判成 CORS 拦截。**探测要放在 wasm 初始化之后，或放宽超时。**
4. `home_relay_status` 的 watcher 会连发几个瞬时状态（空 → 未连接 → 已连接），**UI 必须做去抖**，否则会闪。
5. `Endpoint::close()` 是异步的，不 await/不 spawn 就相当于没关（编译告警 `unused_must_use`）。
6. 沙箱环境跑不了浏览器和需要 UDP 的二进制（Chrome / iroh-doctor 都被 SIGTERM）→ **验证要放到服务器上做**。

### 10.4 仍然没做的

- **中继鉴权**：两台现在都是 `access = "everyone"`。浏览器设不了自定义 header，要么用 `?token=` query，要么上 HTTP callout + EndpointId 白名单。
- **地址发现**：crate 用 `presets::Minimal` + 关闭地址查找，拨号必须自带 `EndpointAddr`（id + relay url）。要"只给 ID 就能连"得接回 DNS/pkarr 或自建 DNS 服务。
- **群聊/历史**：当前是"一条 QUIC 流 = 一条消息"的点对点模型；群聊应换 `iroh-gossip`（topic 即房间），历史消息需要常驻节点或落库。
- **Cloudflare Pages 真机部署**：MIME / 缓存 / COOP-COEP 待实测。
