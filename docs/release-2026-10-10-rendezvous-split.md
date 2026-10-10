# 2026-10-10 阶段 B′：把「常驻节点」拆成两个能力（入口 / 历史）

## 一句话

原来笼统的"常驻节点"在代码里拆成了**两个独立能力**：**房间入口**（rendezvous，回答"这房间现在有谁"）
与**历史提供者**（history）。各有各的 ALPN、开关与资源闸门 —— 今天仍跑在同一个 roomd 进程里，
但没有任何共享状态，要拆成两台机器只需要改配置。

## 改了什么

### 核心（`client-wasm/src/room.rs`）
- 新 ALPN `editor.vip/iroh-rendezvous/1` + `RendezvousService`：
  `{room}` → `{members:[EndpointId], truncated}`。
  只回 EndpointId（不回昵称/文件清单）—— 入口的职责是"让你找得到人"，其余进房后由 presence 得到。
- **自己的四道闸门**（与历史各管各的，不共用信号量/超时/上限）：
  并发 32、accept 5s、请求体 1 KiB、读 5s、响应 ≤64 个成员 + 16 KiB、写 5s、关 5s；
  房间名复用**与历史同一条**校验（不是各写一遍）。
- `RoomOptions` 拆成两组角色：`rendezvous_id/relay`、`history_id/relay`，
  `anchor_*` 保留为**共同回退**（老配置行为完全不变，实测确认）。
  半配（只给 id 或只给 relay）**明确报错**，不再静默忽略。
- 进房时的候选：**先问入口**"这房间有谁" → 候选 = 入口报的成员 + 入口自己 + 历史提供者；
  入口拿不到（连不上/超时）只记 debug 并继续，仍走阶段 A 的降级。查询预算 = 进房预算的 1/4。
- 拉历史连的是 `history`（没配才回退 `rendezvous`）—— 语义上与"入口"彻底分开。
- 两个开关独立：`serve_history` / `serve_rendezvous`（谁开谁装；快照维护任一开着就做）。

### 服务端（`client-wasm/src/bin/roomd.rs`）
- 增加 `accept(RENDEZVOUS_ALPN, RendezvousService::new(...))`，并把它加进 advertised ALPN 列表。
- 房间订阅入口的 `join_tx` 现在**两个服务共用同一个通道**：入口被问到某个房间时，
  roomd 也会去订阅它（"有人来问"就是最自然的加入信号）。

### 前端 / 客户端
- `relay-config.json` 增加 `rendezvous` 与 `history` 两段（今天与 `anchor` 同值），
  `anchor` 标注为兼容回退；`relay-model.js` 对三个角色**同一套规则校验**。
- `net.js` / `iroh-worker.js` 把四个新字段透传进 `RoomOptions`。
- 移动端：配置模块解析并校验这两个角色，但**仍只把 `anchor` 传下去** ——
  Android 桥（Kotlin）目前是一个个参数搬运的，没有这两个角色的入口；
  Rust 侧缺省即回退到 `anchor`，所以行为与拆分前一致。
  等 C′ 把 Android 桥改成"直传 RoomOptions JSON"时一并接上（已记进架构方案）。

## 验证

| 项 | 结果 |
|---|---|
| **`bash scripts/verify.sh all`** | **退出码 0** |
| Rust 单元/集成 | **68 通过**（新增 `rendezvous_and_history_are_independent_capabilities`） |
| 安全攻击回归 | 18 通过 |
| 浏览器回归 | **618 项通过 / 0 失败**（各套件自报 PASS 之和）（CDP 主套件 265、polish 90、孤立进房 7、入口拆分 6、历史滚动 20、主题同步 16、图片布局 94、修复回归 52、消息归属 38、存储与第四人 12 …） |
| 前端配置单测 | 9 通过（新增"两个角色可各自独立配置"） |
| 线上 `im.pinkstar.cc` | 入口拆分 6/6、孤立进房 7/7 |
| 线上产物哈希 | `js/net.js`、`js/iroh-worker.js`、`js/relay-model.js`、`relay-config.json`、`pkg/iroh_web_bg.wasm` 与本地逐一致 |
| roomd | `running` / `healthy` / `restarts=0`，容器内哈希 = 新候选；**EndpointId 未变**（`5bcc4ea3…`，配置与它一致） |

### 一条**专门为这次拆分写的线上回归**（`scripts/e2e/rendezvous-split.mjs`）

手法：拦截 `relay-config.json`，**把兼容字段 `anchor` 整个去掉**，`rendezvous` 指向真 roomd，
`history` 指向一个**合法但不存在**的节点。断言：

1. 仍然进得了房，而且**不是孤立进房**（`anchor` 去掉后，客户端若没用 rendezvous 就一个人都连不上
   → 界面会显示"暂时联系不上其他人"）；
2. 两个人能互发消息 —— **历史提供者挂着也不影响房间里的实时通信**；
3. 两端都没有孤立提示。

这条用例的价值在于：哪天有人把两个角色又合成一个（或 rendezvous 被忽略），去掉 `anchor` 后第 1 条立刻红。

### 顺带发现的一件事（测试前提过期）

`isolated-room.mjs` 原来只把 `anchor` 换成死 id。B′ 之后客户端优先用 `rendezvous`，
于是它**仍然连得上** —— 用例因此失败，而这恰恰是拆分生效的证据。已改成三个角色全指向死节点。

## 发布顺序与回滚

- 顺序：**先 roomd、后前端**（前端的新 wasm 会主动去问入口；先发前端也无害，只是问不到）。
- 回滚点：
  - 数据：`/opt/iroh/backups/roomd/roomd-20261010T085708341997Z.tar.gz`（一致性备份）
  - 二进制：`/opt/iroh/roomd/roomd.bak-20261010-165707`
  - 前端：Cloudflare 上一个版本 `77f83798-6860-4181-a52b-8ec9ef1bd458`
- 本轮**不动协议、不清历史**（v5 那次才清）。
