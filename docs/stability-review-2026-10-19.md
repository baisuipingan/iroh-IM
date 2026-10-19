# 跨公网闪断复盘与稳定性方案

> 日期：2026-10-19
> 范围：浏览器端（relay-only）房间连接 + 文件传输；原生端共用同一套 `room.rs`，结论同样适用。
> 结论先行：**这不是"公网偶尔抖"，是"文件传输的突发把中继连接打爆"，再叠加"断了不会自己恢复"。**
> 线上证据：香港中继 7 天内 **21,945 次** `failed to forward packet: Full`（转发队列满丢包），集中在 4 个分钟级窗口；同一出口 IP 在 11 分钟内**新建约 40 条中继连接**。
>
> ⚠️ **本文的 P0/P1 是"止血"，不是终局。** 结构层面的选型复核（浏览器 relay-only、自研文件协议、是否换 HTTP/对象存储）见
> [`file-transfer-architecture-review-2026-10-19.md`](file-transfer-architecture-review-2026-10-19.md)。

---

## 0. 一句话结论

`INITIAL_CWND = 2 MB` + QUIC 默认流窗口 `1.25 MB`，远大于中继单客户端转发队列 `512 包（约 0.6–0.77 MB）`。文件一开传，发送端会在**收到第一个 ACK 之前**就把 1.25 MB 的流窗口打满（2 MB 的 cwnd 允许它一直发）；慢上行（< 2–3 Mbps）排不空，中继队列满 → 丢包 → 中继 ping 5 秒超时 → **整条中继连接被重置** → 同一 WebSocket 上的**所有** QUIC 连接（gossip 心跳、文件流）一起断。于是：

- 纯聊天：只有几 KB 的心跳，永远打不满队列 → 看起来正常。
- 传文件：1.25 MB 流窗口瞬间打满队列（2 MB cwnd 允许它不等 ACK），触发中继 ping/写超时 → 掉线（慢上行下几乎每次传输都会撞上一次）。
- 多人互传：N 个接收方并发 = N 条流同时起速 → 更容易掉线。
- 不同公网环境：上行越慢、离中继越远，越容易触发 → "有的人没事，有的人一直闪"。

**最小行动清单（如果只看三件事）**：

1. **今天**：把 `INITIAL_CWND` 2 MB → 256 KB、流窗口 1.25 MB → 1 MB（P0-1，一处配置）。
2. **本周**：传输加 AIMD 限速 + 并发 ≤2（P0-2/P0-3），再补常驻 relink + 前端重建（P1-1/P1-4）。
3. **下周**：自动断点续传（P2-1），让 30 秒闪断只损失 1 MB，而不是整份文件。

---

## 1. 现场证据

### 1.1 线上中继（HK / iroh1，近 7 天）

只读检查（`docker logs` + `iroh-relay-tcp-bbr status`）：

| 时间窗 | `failed to forward packet: Full` | 说明 |
|---|---:|---|
| 2026-10-13 11:20–11:26 | **6,097** | 6 分钟窗口，峰值 3,086/分钟 |
| 2026-10-13 13:50–13:56 | **6,053** | 6 分钟窗口，峰值 2,969/分钟 |
| 2026-10-14 05:00–06:59 | **7,407** | 跨 2 小时，峰值 4,312/小时 |
| 2026-10-15 06:00–12:59 | 569 | 小规模复现 |
| **7 天合计** | **21,945** | 全部是转发队列满导致的丢包 |

同一时段，同一出口 IP（`139.226.122.225`；也可能包含同一 NAT 后的多个标签页/设备）在 13:50–13:57 之间：

- 中继侧 `connection_id` 从 **3843 连续涨到 3883**（约 40 条新连接 / 11 分钟）；
- 每条连接很快出现 `actor errored Stream terminated`；
- 13:26–13:29 还出现大量 `Connection did not reach established state within timeout`（重连都来不及建立）。

这不是"网络抖一下"，是**客户端在反复重连**。BBR 当前是 `applied`（`ip rule 15443` → 路由表里 `congctl bbr` 存在），所以本轮不是 CUBIC 回退导致，而是**发送突发 + 队列满**。

### 1.2 关键常量对照（代码 / 上游）

| 项 | 值 | 位置 | 含义 |
|---|---:|---|---|
| 初始拥塞窗口 | **2 MB** | `client-wasm/src/room.rs:2566` | 每个新 QUIC 连接允许 2 MB 在途（实际还受下面流窗口 1.25 MB 限制） |
| QUIC 流接收窗口（默认） | **1.25 MB** | `noq-proto` `STREAM_RWND = 12.5MB/s × 100ms` | 接收方允许发送方“未确认”1.25 MB |
| 本端发送缓冲（默认） | **10 MB** | `noq-proto` `send_window = 8 × STREAM_RWND` | `write_all` 可先把数据堆在本地 |
| 中继单客户端转发队列 | **512 包** | `iroh-relay` `PER_CLIENT_SEND_QUEUE_DEPTH` | 约 0.6–0.77 MB，满了就丢 |
| 中继 ping 间隔 / 超时 | 15 s / **5 s** | `iroh` `PING_INTERVAL` / `ping_tracker` | pong 5 秒不回 → 断开中继连接 |
| 中继客户端单次发送超时 | 15 s | `iroh` `run_sending(send_timeout = PING_INTERVAL)` | 一次 WebSocket 写 15 秒没完成 → 断开 |
| 中继路径空闲超时 | **30 s** | `iroh` `RELAY_PATH_MAX_IDLE_TIMEOUT` | 30 秒收不到包 → QUIC 路径死 |
| 中继服务端写超时 | **2 s** | `iroh-relay` `SERVER_WRITE_TIMEOUT` | 往客户端写一帧 2 秒没完成 → 关连接 |

**数量级对比**：接收方广告的流窗口是 `1.25 MB`，本身就已经大于中继队列（`≈0.7 MB`）；发送端的初始 cwnd `2 MB` 又保证它能在收到任何 ACK 之前把这一整个窗口打满。**结构性超灌约 2 倍，而且是瞬时突发而不是平滑起速。**

### 1.3 故障链（按时间顺序）

```text
用户点“发送文件”
  │
  ├─ 新开一条 QUIC 连接（FILE_ALPN），但和 gossip 共用同一条「到中继的 WebSocket」
  │
  ├─ BBR3 起手 cwnd=2MB，pacing 按 initial_cwnd/1ms 计算 → 几乎瞬时把 1.25MB 流窗口打满
  │
  ├─ 上行只有 200–600 KB/s → 本地 TCP 发送缓冲 + 中继队列同时积压
  │     ├─ 中继 per-client 队列 512 包满 → `failed to forward packet: Full`（实测 2–4 千次/分钟）
  │     └─ 中继 ping/keepalive 排在同一队列后面 → pong 5s 不回
  │
  ├─ iroh relay client：`PingTimeout` → 关闭这条 WebSocket
  │     └─ 同一 WebSocket 上的 gossip 连接 + 文件连接 + 其他房间连接**一起断**
  │
  ├─ iroh 自动重连中继（25s 内），但：
  │     ├─ gossip topic 的邻居全没了，presence 30–45s 后才恢复
  │     ├─ 文件传输已经失败（发送端 30s 单块超时 / 接收端 60s 空闲超时）
  │     └─ 前端只把这条传输标成 failed，不会自动续传
  │
  └─ 用户看到：成员“退出又进来”、文件“传输失败”、状态“正在重连”
```

---

## 2. 根因（按贡献排序）

### RC-1｜2 MB 初始窗口 × 1.25 MB 流窗口 ≫ 512 包中继队列（主因，置信度高）

- 代码：`room.rs:2566` `const INITIAL_CWND: u64 = 2 * 1024 * 1024;`
- 上游：`noq-proto` 默认 `STREAM_RWND = 1.25 MB`、`send_window = 10 MB`；BBR3 的初始 pacing rate 按 `initial_cwnd / 1ms` 计算，起手几乎是**突发**而不是平滑起速。
- 中继：`PER_CLIENT_SEND_QUEUE_DEPTH = 512`，满了直接丢。
- 结果：任何上行 < 约 2–3 Mbps 的环境，1.25–2 MB 的瞬时突发需要 5–10 秒排空；而中继 ping 只等 5 秒 → **很容易掉**（线上实测就是每分钟 2–4 千次丢包 + 反复重连）。
- 为什么之前没人发现：注释里假设 `2MB ÷ 0.26s ≈ 7.8 MB/s`，但那只在“链路本身有 7.8 MB/s”时成立；慢上行恰恰是这个假设的反面。

> 这条解释了为什么"纯聊天没事、传文件必闪、多人互传更闪、不同公网环境差异巨大"。

### RC-2｜控制面与数据面共用同一条中继 WebSocket（结构性，置信度高）

- 浏览器不能发 UDP → 永久 relay-only；一个 endpoint 到一台中继只有**一条 WebSocket**，所有 QUIC 连接（gossip、history、每个文件流）都复用这条 WebSocket 的 datagram 帧。
- 文件流虽然开了独立 QUIC 连接，但**没有独立的中继 socket**，所以文件数据会排在心跳/控制包前面（TCP 队头阻塞）。
- 表现：文件一开传，房间内**所有人**（不只是传输双方）都开始闪——因为中继的上行/下行是共享的；旁观者自身没有传输活动，`LAST_TRANSFER_ACTIVITY_MS` 为 0，TTL 仍是 35s，照样被误判掉线。

### RC-3｜presence TTL 与拥塞不匹配，且“传输期放宽”覆盖不到旁观者（中高）

- `PRESENCE_INTERVAL = 10s`、`PRESENCE_TTL_MS = 35s`（`room.rs:89–95`）。
- 传输期 TTL 放宽到 3×（105s）只在 `LAST_TRANSFER_ACTIVITY_MS` 之后 **60 秒内**生效（`room.rs:103–135`）；而 `note_transfer_activity()` 只在**成功写入一块**时刷新。传输一卡住（正是心跳被拖住的时候），60 秒窗口过期 → TTL 回到 35s → 开始闪。
- 旁观者（C 没传文件）永远用 35s；中继拥塞是共享的，C 的心跳也会被拖 → 全房间一起闪。
- roomd 的心跳快照也不感知“传输在途”（文档已承认），新进房的人看到的名册可能残缺。

### RC-4｜运行期失联没有自愈闭环（置信度高）

| 缺口 | 代码 | 后果 |
|---|---|---|
| `spawn_relink_task` 只在**进房时** `isolated` 才启动 | `room.rs:3393–3399` | 进房成功后中途失联，不会启动重连任务 |
| 心跳里的 `join_peers(bootstrap)` 是唯一周期性重拨 | `room.rs:3338–3340` | bootstrap 为空（入口没配上/解析失败）时永不重拨；且和用户发送共用同一把 `sender` 锁 |
| gossip 消费任务 `Err(e) => break` | `room.rs:3282–3285` | 一旦 gossip 流报错，消费任务**永久退出**；没有重启、没有 `Isolated` 事件；UI 仍显示“在线”，但收不到任何消息/心跳/文件控制 |
| 前端“重连”只调 `online()` + `joinRoom()` | `frontend/js/net.js:283–343` | 复用同一个 wasm 节点；gossip actor/事件流已经 wedge 时救不回来，只有刷新页面能重建 |
| 浏览器没有看门狗 | — | 睡眠/切网/代理切换后的“假在线”不会自愈（agent-pi 有 120s 看门狗，Web 没有） |

### RC-5｜传输没有自动续传，错误即终态；超时口径互相打架（置信度高）

- 发送端：单块写 30s 超时（`transfer_orchestrator.rs:514–522`）→ 直接 `bail`，整条传输失败。
- 接收端：两块之间 60s 空闲超时（`filetransfer.rs:88`）、等上层确认 600s（`filetransfer.rs:1077–1090`）。
- 发送端等回执 120s（`transfer_orchestrator.rs:576–591`），比接收端的 600s 短 5 倍；大文件校验慢时发送端会**先报失败**，接收端随后报成功。
- 失败后：UI 只给「继续接收」按钮（`frontend/js/ui/timeline.js:706–714`），**不会自动重试**；`ev.retry` 在 Worker 里是死代码，全仓库没有任何地方置位。
- 断点续传本身可用（IndexedDB 位图 + 每 64 块落一次），但完全依赖用户手动点。

### RC-6｜跨区/错中继：中继不互转，13 秒超时才失败（中）

- 项目文档已实测（`docs/iroh-chatroom-feasibility.md` §8.3 E4）：**中继之间不互转**；拨号指向对端不在的那台中继，会 **13 秒超时**，不会自动换一台重试。
- `my_relay_url()` 取“第一台已连接的中继”（`room.rs:4072–4092`），可能是临时非 home 连接；`receiver_relay` 在 `Accept` 时只采样一次，传输中途对端切 home relay 不会更新。
- `MemoryLookup` 只增不减：`send_file_data` 每次都把 `receiver_relay` 写进去（`room.rs:4112`），从不移除；陈旧 relay 地址会一直留在候选里。
- 中国大陆用户 → 香港中继是正常路径；但如果 iroh 因探测抖动把 EU/FR 选成 home，跨境三跳会同时放大 RTT 和丢包。

### RC-7｜运维可观测性缺口（中）

- `deploy/relay/relay-docker.toml` 里 `enable_metrics = false` → 丢包/断连指标不可见，只能翻日志。
- BBR 曾被 systemd-networkd 静默清掉（`docs/relay-tcp-bbr.md` 2026-10-14），已修 + 已加 `relay-tcp-bbr-check.timer`；但没有告警，下一次静默失效仍然只能靠用户报障。
- 15443 的 `listen` backlog 是 **128**（`ss -lnt`），重连风暴时容易排队/超时；`somaxconn` 是 4096，但应用只 listen 128。

---

## 3. 优化方案

> 原则：**先止血（不改协议、1–2 天可上）→ 再自愈（不改协议、3–5 天）→ 最后改传输协议（1–2 周）**。
> 每条都给“改哪里 / 适用场景 / 预期效果 / 成本与风险”。

### 方案总览（按投入产出排序）

| 优先级 | 方案 | 主要解决 | 预期效果 | 工期 |
|---|---|---|---|---|
| P0 | cwnd / 流窗口降档 | 传输首秒灌爆中继 | `Full` 丢包 -90%，整链路闪断基本消失 | 0.5 天 |
| P0 | 传输 AIMD 限速 | 慢上行 / 多人互传 | 控制面 RTT 稳定，完成率↑ | 1 天 |
| P0 | 并发传输 ≤ 2 | N 倍突发 | 峰值突发降 N 倍 | 0.5 天 |
| P0 | 中继告警 | 运维盲区 | 2 分钟内发现 BBR 失效/丢包突增 | 0.5 天 |
| P1 | 常驻 relink 监督器 | 运行期失联 | 30–60 秒自愈，无需刷新 | 2 天 |
| P1 | 控制面 await 超时 | gossip actor 卡死 | 心跳/发送不再永久挂起 | 0.5 天 |
| P1 | 前端重建节点 + 看门狗 | 假在线 / wedge | 睡眠、切网、代理切换后自愈 | 1 天 |
| P2 | 自动断点续传 | 一断就整份失败 | 断 30 秒只重传 ≤ 1 MB | 3–5 天 |
| P2 | 数据面隔离 / 区域 pin | 队头阻塞 / 跨区三跳 | 传文件时聊天完全不抖；RTT 降 3–5× | 1–3 天 |
| P3 | roomd 中转兜底 | 极端弱网 / 大文件 | “一定能传完” | 1 周+ |

### P0｜止血（1–2 天，建议立刻做）

#### P0-1 把初始窗口和流窗口降回“中继队列能接住”的量级

**改哪里**：`client-wasm/src/room.rs:2566–2577`

```rust
// 2 MB → 256 KB：仍是默认 14.7 KB 的 17 倍，但小于中继 512 包队列（≈0.6–0.77 MB）
const INITIAL_CWND: u64 = 256 * 1024;
const STREAM_RWND: u32 = 1024 * 1024;  // 默认 1.25 MB → 1 MB（要容得下 512 KB 的 gossip 单条）
const SEND_WINDOW: u64 = 2 * 1024 * 1024; // 默认 10 MB → 2 MB，给 write_all 真背压

bbr.initial_window(INITIAL_CWND);
iroh::endpoint::QuicTransportConfig::builder()
    .congestion_controller_factory(std::sync::Arc::new(bbr))
    .stream_receive_window(iroh::endpoint::VarInt::from_u32(STREAM_RWND))
    .send_window(SEND_WINDOW)
    .build()
```

> ⚠️ 这会**全端点生效**（gossip 也用小窗口）。真正的“网络在途”上限是 `INITIAL_CWND`；`STREAM_RWND`/`SEND_WINDOW` 只限制应用层能提前堆多少。三项一起降，才能既防突发又不误伤大消息。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有 relay-only 浏览器客户端；原生端可跟 | 传文件时中继 `Full` 丢包预计下降 **≥90%**；因 relay ping 超时导致的“整房间闪断”基本消失；8 MB 文件完成时间持平或略好（BBR 会在 1–2 个 RTT 内涨回来） | 高 BDP/高速链路首秒吞吐略降；需要 A/B 实测 8 MB / 50 MB 两档 |

**为什么不是 2 MB 但加 pacing**：pacing 只能平滑“发出去”的节奏，管不住中继队列；初始窗口是“允许在途”的上限，必须 ≤ 队列。这是硬约束。

#### P0-2 文件传输加自适应限速（AIMD），别让 BBR 裸奔

**改哪里**：`client-wasm/src/transfer_orchestrator.rs` 的 `send_file` 循环（`for (i, seq) in need.iter()`）

- 起始速率 **256 KB/s**，每 10 秒无卡顿 +25%，出现“单块写 >5 秒”或“中继丢包”则 **减半**；
- 上限 2 MB/s（可配置）；下限 64 KB/s；
- 用 token bucket 实现，只在 `sent_bytes` 上记账，不改协议。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 共享中继、家庭宽带低上行、多人同时传 | 传输期间控制面 RTT 稳定，成员表不闪；完成率大幅上升；总耗时可能 +10–20%，但“传不完”变成“慢一点传完” | 高速链路被限到 2 MB/s；建议做成 `?rate=` 或配置项，默认 2 MB/s |

#### P0-3 全局并发传输上限（默认 2）

**改哪里**：`frontend/js/iroh-worker.js` 的 `onAccepted`（每个接收方一次）或 Rust 侧 `send_file_data` 外层加 `Semaphore(2)`。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 一个文件同时发多人、多人互传 | 峰值突发从 `N × 2 MB` 降到 `2 × 256 KB`；总吞吐不变，抖动显著下降 | 多接收方排队，单个接收方等待变长；需要 UI 显示“排队中” |

#### P0-4 中继队列临时扩容（可选，过渡期）

**改哪里**：`iroh-relay` 是上游二进制，`PER_CLIENT_SEND_QUEUE_DEPTH` 是编译期常量，不能只改 TOML。要么等 P0-1 上线，要么自行 patch 镜像。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 无法立刻发客户端版本的窗口期 | 吸收 1–2 秒突发，丢包峰值下降 | 每活跃客户端多占 0.6–1.8 MB；队列更长 = bufferbloat，延迟更大；**不解决根因** |

#### P0-5 中继健康告警（零代码）

- `enable_metrics = true` + `metrics_bind_addr = 127.0.0.1:9090`，用 Prometheus/node_exporter 抓；
- 告警规则：
  - `rate(relayserver_send_packets_dropped_total[5m]) > 10` 持续 5 分钟；
  - `iroh-relay-tcp-bbr status != applied`；
  - `accepts_total` 与 `disconnects_total` 比值突增；
  - 15443 的 `ss -lnt` 的 `Recv-Q > 0` 持续。
- 没有 metrics 时，先用日志：`docker logs --since 5m iroh-relay | grep -c "failed to forward packet"`。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有中继 | BBR 失效/丢包突增 **2 分钟内**发现，不再靠用户报障 | 需要 Prometheus；无 metrics 时用 cron + 日志计数也能做 |

---

### P1｜连接自愈（3–5 天）

#### P1-1 常驻“失联监督器”，不再只在进房时重连

**改哪里**：`room.rs` 的 `Joined` 增加 `last_event_ms` 和 `relink` 监督任务；`spawn_relink_task` 不再只在 `isolated` 时调用。

触发条件（任一）：

1. `peers.is_empty()` 持续 > 20 秒；
2. 距最后一次收到**任何** gossip 事件 > 45 秒；
3. `relay_status()` 全部 `connected == false`。

动作：

1. `sender.join_peers(bootstrap)`（带 5s 超时）；
2. 30 秒后仍无事件 → **重建 topic**（drop 旧 `GossipTopic`，重新 `subscribe(topic, bootstrap)`）；
3. 发出 `RoomEvent::Isolated { isolated: true }`，UI 显示“正在重连”，而不是静默把人清空；
4. 接上后发 `Isolated { isolated: false }`，UI 补拉历史。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有客户端；浏览器/移动端尤其 | 运行期失联 **30–60 秒自愈**，不再需要刷新页面；重连过程可见 | 重建 topic 会短暂丢消息（gossip 本来就不保证）；要防止和 `join()` 并发，需单飞锁 |

#### P1-2 所有控制面 await 加超时

**改哪里**：

- `room.rs:3344` `sender.broadcast(...)` → `timeout(5s)`
- `room.rs:3573` `send()` 的 `broadcast` → `timeout(10s)`，失败返回明确错误
- `room.rs:3339` `join_peers` → `timeout(5s)`
- `room.rs:3829` `send_ctrl_in` → `timeout(5s)`

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有客户端 | 心跳/发送不会因为 gossip actor 卡死而**永久挂起**；超时能被 P1-1 捕获并触发重连 | 超时时间要大于正常 RTT（慢链路 300ms+），5–10 秒足够宽容 |

#### P1-3 消费任务错误可恢复

**改哪里**：`room.rs:3282–3285`

```rust
Err(e) => {
    warn!("gossip 事件错误: {e}");
    events.send(RoomEvent::Degraded { room: room_s.clone(), reason: e.to_string() }).await.ok();
    break;   // 由 P1-1 的监督器重建 topic
}
```

同时在 `None`（流结束）时也发 `Degraded`。不要让“退出循环”等于“静默半死”。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有客户端 | 消灭“发得出、收不到、界面还显示在线”的静默故障 | 需要新增 `RoomEvent::Degraded` 并让前端处理 |

#### P1-4 前端“重建节点”作为最后手段

**改哪里**：`frontend/js/net.js`

- `node:degraded` 收到 1 次，或 `_goOnline` 连续失败 2 次 → `worker.terminate()` → `new WorkerClient()` → 重新 `boot` → `join(_desiredRoom)`；
- 重建期间保留 `_desiredRoom`、昵称、文件清单（`outFiles` 在 Worker 内存里，重建会丢，需要主线程保留元信息或提示“需重新分享”）；
- 重建最多 3 次，之后显示“请刷新页面”并给出诊断信息。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 睡眠唤醒、切网、代理切换、wasm 节点 wedge | 无需用户手动刷新；端到端自愈时间可控（~10–20s） | 重建会丢 Worker 内存里的 `outFiles`/接收句柄；需要把“正在传的文件”标成 interrupted 而不是 failed |

#### P1-5 浏览器看门狗（90–120 秒无房间事件）

**改哪里**：`net.js` 主线程定时器（不受 Worker 影响）：

- 进房后开始计时；收到 `message` / `presence` / `fileInvite` / `fileDone` / `history` 任一即刷新；
- 90–120 秒无事件 → 触发 P1-4；
- **不要**把 `relayStatus` 算作事件（agent-pi 的教训：relayStatus 会骗过看门狗）。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 浏览器后台/睡眠/弱网 | “假在线”能自愈；与 agent-pi 的 120s 看门狗行为一致 | 阈值太小会误杀（presence 10s 一次，120s 有 12 次余量，安全） |

---

### P2｜传输中断恢复（1–2 周）

#### P2-1 自动断点续传（不依赖用户点）

**目标**：一次 30 秒的闪断，只损失“最后 1 MB + 重连时间”，而不是整份文件。

**协议改动（向后兼容）**：

- `FileCtrl::Invite` 增加 `retry: bool`（或新增 `FileCtrl::ResumeOffer { file_id, have }`）；
- 发送端失败后：指数退避（2s/4s/8s/16s/32s）自动重发 `Invite { retry: true }`，最多 5 次；
- 接收端 Worker 看到 `retry && 本地有该 file_id 的未完成记录` → **自动 accept**，带上 IndexedDB 位图，不再弹保存框（复用 `_handles`）；
- 接收端在 `have` 里带上位图；发送端 `send_file` 已经支持 `missing_chunks`，无需改数据面；
- UI 状态：`reconnecting (2/5)`，不是 `failed`；5 次都失败才标 failed。

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 所有传输；弱网/移动网络尤其 | 闪断后自动续传；重传 ≤ 1 MB（位图每 64 块落一次）；用户无感 | 需要协议加字段（V7 或兼容字段）；接收端要持久化“已授权接收”的意图，避免重放攻击（用 `file_id + sender + root_hash` 校验） |

#### P2-2 统一超时口径（按“无进度”而不是“单块”）

| 位置 | 现在 | 建议 |
|---|---|---|
| 发送端单块写 | 30s | 改为“全局无进度 45s”（每成功写一块刷新） |
| 接收端两块之间 | 60s | 90s（与发送端一致，避免一端先杀） |
| 发送端等回执 | 120s | `max(120s, size / 50KB/s + 60s)`；10 GB 文件不应 120s 就判死 |
| 接收端等上层确认 | 600s | 保持，或按 `size / 20MB/s + 60s` |
| 连接建立 | 无显式超时（靠 QUIC idle） | 15s 显式超时，失败快速重试另一台中继 |

| 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|
| 慢链路（70 KB/s）、大文件 | 不再“慢但稳定”被误杀；真死链路仍能在 1–2 分钟释放资源 | 失败检测变慢；需要配合 P2-1 自动续传，否则用户等更久 |

#### P2-3 数据面与控制面隔离（中期，效果最确定）

三种做法，按改动量排序：

| 方案 | 做法 | 适用场景 | 预期效果 | 成本 / 风险 |
|---|---|---|---|---|
| **A. 区域 pin** | `relay-config.json` 增加 `region`；客户端按 `Intl`/时区/探测只连本区 1–2 台；房间入口仍可跨区 | 用户集中在少数区域（CN→HK、EU→EU） | RTT 从 200–300ms 降到 30–60ms；跨区三跳消失；吞吐 2–5× | 牺牲跨区容灾；需要给每区至少 2 台 |
| **B. 独立 data relay** | `Accept` 里带 `data_relay`；双方都 `endpoint.add_relay(data_relay)` 并保持连接；文件只走 data relay，gossip 走 home relay | 房间跨区、但想保住控制面稳定 | 控制面与数据面各一条 WebSocket，**彻底消除队头阻塞**；传文件时聊天完全不抖 | 需要验证 iroh 是否对指定 relay 保持连接（可能要周期性发小包）；多一台中继成本 |
| **C. roomd / 对象存储中转** | 文件分片上传到 roomd（或 R2/S3），接收方下载；支持 HTTP Range 断点续传 | 大文件、弱网、跨洲、企业代理 | 最稳；不受 QUIC/中继队列影响；天然可续传 | 服务器带宽/存储成本；不再是 P2P；需要清理策略与配额 |

> 推荐顺序：先 A（1 天，改配置 + 选路），观察是否足够；不够再 B；C 作为“大文件/弱网”的兜底开关。

#### P2-4 可观测性

- 客户端：把 `[stats]`（RTT/cwnd/丢包）从 console 提升为**采样上报**（每 10 秒一条，匿名聚合），字段：`relay_url / rtt / cwnd / lost / path`；
- 服务端：`enable_metrics`，抓 `send_packets_dropped_total`、`accepts_total`、`disconnects_total`、`relay_conns_*`；
- 聚合看板：按小时看“丢包/断连/传输失败率”，把“用户说闪”变成“哪条链路、哪个环节”；
- 告警：见 P0-5。

---

### P3｜架构级（可选，按业务取舍）

1. **控制面独立通道**：成员在线状态走一条轻量 WebSocket 到 roomd（或独立 presence 服务），文件走 relay；即使文件把 relay 打满，成员表也不闪。
   - 代价：多一个服务端依赖；但房间本来就有 roomd，增量不大。
2. **服务端中转兜底**：当 `send_file` 连续 2 次失败，或测得吞吐 < 64 KB/s，自动切 roomd HTTP 分片上传/下载；保证“一定能传完”。
   - 代价：服务器带宽；适合作为“最后 10% 弱网用户”的开关。

---

## 4. 验证方案（别凭感觉上线）

### 4.1 最小 A/B（1 天，先证明 RC-1）

**环境**：两台浏览器（Chrome），一台用 `tc netem`/手机热点限到上行 **200 KB/s**，另一台正常；传 50 MB。

| 组 | 配置 | 观察 |
|---|---|---|
| A（现状） | cwnd 2 MB / 流窗口 1.25 MB | 传完后 `docker logs --since 10m iroh-relay \| grep -c "failed to forward packet"`；记录首次断连时间、完成率 |
| B（P0-1） | cwnd 256 KB / 流窗口 1 MB | 同上 |

**通过标准**：

- B 组传输期间 relay `Full` 丢包 **< A 组的 10%**；
- B 组传输期间 relay 连接重置 **0 次**（A 组预期 ≥1 次）；
- B 组 50 MB 完成时间 ≤ A 组 × 1.3；
- 聊天侧：传输期间每 10 秒发一条消息，B 组无 presence 闪变。

### 4.2 线上灰度

1. 先发 P0-1 + P0-2（只改 wasm + 前端），用 `?build=` 灰度 10% 用户；
2. 观察 24 小时：relay 丢包率、`accepts/disconnects`、用户端 `transfer:*` 失败率；
3. 无回退再全量；P1 单独发版，避免一次改太多无法归因。

### 4.3 回归用例（必须补）

- Rust：`room.rs` 单测“传输期 TTL 3×”已有；新增“cwnd 配置生效”（读 `conn.stats()` 或 transport config）。
- 前端：Playwright 用例“传输中断 → 自动重试 → 续传成功”（用 `STOP_AFTER_CHUNKS` 钩子制造中断）。
- 线上冒烟：两浏览器 + 真实中继 + 50 MB，断言 `relay logs` 无 `Full` 峰值。

---

## 5. 不建议做的事（会帮倒忙）

| 做法 | 为什么不要 |
|---|---|
| 把 presence 心跳从 10s 调到 1–2s | 心跳和文件数据抢同一条队列，越勤越容易把队列打满；问题在拥塞，不在频率 |
| 只把 TTL 从 35s 调到 120s | 掩盖症状；新进房的人仍然看不到成员；而且“掉线”永远不会被及时清理 |
| 把所有用户钉死到一台中继 | 单点故障 + 跨区更慢；中继一挂全房间失联 |
| 失败就无限重连 | 11 分钟 40 条连接的现场就是重连风暴；必须指数退避 + 上限 + 重建节点 |
| 只加 `try/catch` 不上报 | 错误被吞掉，UI 仍显示在线，等于把“静默半死”藏得更深 |
| 把 `MAX_MESSAGE_SIZE` 继续调大 | 单条 512 KB 已经是广播，越大越容易堵队列；大文件走文件流，不要走 gossip |

---

## 6. 附录：关键代码索引

| 主题 | 位置 |
|---|---|
| 初始 cwnd / 传输配置 | `client-wasm/src/room.rs:2566–2577` |
| presence 常量 / TTL 放宽 | `client-wasm/src/room.rs:79–135` |
| 心跳任务（join_peers + broadcast） | `client-wasm/src/room.rs:3301–3375` |
| gossip 消费 `Err => break` | `client-wasm/src/room.rs:3282–3285` |
| 孤立进房 + relink | `client-wasm/src/room.rs:3393–3399`、`3412–3449` |
| 发送（无超时） | `client-wasm/src/room.rs:3547–3576` |
| 文件控制发送（无超时） | `client-wasm/src/room.rs:3816–3832` |
| `my_relay_url` / relay 采样 | `client-wasm/src/room.rs:4072–4092` |
| 发送循环 / 30s 单块 / 120s 回执 | `client-wasm/src/transfer_orchestrator.rs:477–607` |
| 接收空闲超时 120s | `client-wasm/src/transfer_orchestrator.rs:625`、`670–700` |
| 接收帧空闲 60s / header 30s | `client-wasm/src/filetransfer.rs:81–88` |
| 接收端等上层确认 600s | `client-wasm/src/filetransfer.rs:1077–1090` |
| 前端重连（复用节点） | `frontend/js/net.js:283–343` |
| 前端退避 / relayStatus / degraded | `frontend/js/net.js:345–358`、`379–407`、`456–463` |
| 发送看门狗 45s | `frontend/js/iroh-worker.js:457–480` |
| 手动续传入口 | `frontend/js/ui/timeline.js:706–714` |
| 中继配置（metrics off / 无 limits） | `deploy/relay/relay-docker.toml` |
| BBR 巡检 | `docs/relay-tcp-bbr.md`、`deploy/relay-tcp-bbr-check.timer` |
