# 2026-10-10 阶段 C′：能力注册表 + 插件事件 + 显式加入声明

## 一句话

核心不再"认识"历史或入口：它们只是**注册进来的能力**；
而"服务端订阅房间"也从「拉一次历史的副作用」换成了**一条明确的加入声明**。

## 改了什么

### 1. 能力注册表（终态 ③）
```rust
pub trait RoomCapability: Send + Sync + Debug + 'static {
    fn alpn(&self) -> &'static [u8];
    fn name(&self) -> &'static str;
    fn handler(&self) -> Box<dyn DynProtocolHandler>;
}
pub struct CapabilityRegistry { /* 已注册的能力 */ }
```
- 四个能力现在都实现这个 trait：`files`（所有端）、`history`、`rendezvous`、`announce`（服务端）。
- `CapabilityRegistry::install(RouterBuilder)` 是**整份代码里唯一**知道"一共有几种能力"的地方：
  核心的 gossip 消费、事件分发、房间订阅对具体能力一无所知。
- **插件入口** `RoomNode::start_with(opts, extra_registry)`：调用方可以追加自定义能力，
  核心**原样收下**、不做任何判断。测试 `a_custom_capability_is_served_and_can_emit_plugin_events`
  用一个核心完全不认识的 `echo` 能力证明：注册进去就能被服务。
- roomd 也改用注册表组装，启动日志会打印能力表（现网实测：`["history", "rendezvous", "announce"]`）。

### 2. 插件事件变体（终态 ③，决策 ③ 的形态）
```rust
RoomEvent::Plugin { name: String, payload: serde_json::Value }
```
- 加它是为了**不再为每个新能力改这张枚举**：核心只负责把插件的消息原样端给 UI。
- **既有强类型事件一个都没动**（决策 ③）；需要签名/验签的东西仍必须走 `Wire` —— 这条边界写在代码注释里。
- 三端类型由 Rust 生成（阶段 D 的机制），所以这个变体**自动**出现在移动端/agent 的 TS 里；
  web 侧的事件名校验会把它列为"协议里有、net.js 未处理"（只提示不拦，符合脚本设计）。

### 3. 显式加入声明（取代"敲门"）
- 新 ALPN `editor.vip/iroh-announce/1` + `AnnounceService`：`{room}` → 让服务端订阅该房间，回一个 ack。
  自带闸门（并发 64 / accept 5s / 请求 1 KiB / 读 5s / 写 5s / 关 5s），房间名校验复用同一条规则。
- 客户端进房时改成 `announce_room(room)`：向每个服务端角色（入口 / 历史）发一条声明，
  **按 EndpointId 去重**、**尽力而为**（失败只记 debug，绝不影响进房），每目标预算 `join_timeout/8`。
- **删掉了**原来的"敲门"（`fetch_history(room, 1)` 只为触发订阅、拿到结果又丢掉）——
  把"读数据"当信号的那条路没有了。

## 顺带修掉的一个回归（拆掉敲门暴露出来的）

去掉进房时的历史查询后，**原生路径**少了"进房即看到屋里有哪些人"的来源
（wasm 侧本来在包装层手动 `apply_snapshot`，原生没有）——
现有用例 `three_users_exchange_messages_and_late_joiner_gets_history` 当场变红。
修法：把"拿到快照就并进成员表"**统一收进 `RoomNode::fetch_history`**（谁拉的都算），
并删掉 wasm 包装层里那次重复调用。**这类回归正是"拆掉隐式耦合"应有的代价与收益**。

## 验证

| 项 | 结果 |
|---|---|
| **`bash scripts/verify.sh all`** | **退出码 0** |
| Rust 单元/集成 | **70 通过**（新增 `a_custom_capability_is_served_and_can_emit_plugin_events`、`join_announcement_subscribes_the_provider`） |
| 安全攻击回归 | 17 + 1 通过 |
| 浏览器回归 | **618 项通过 / 0 失败**（28 个套件） |
| 线上 `im.pinkstar.cc` | 入口拆分 6/6、孤立进房 7/7 |
| 线上产物哈希 | `main.js`、`js/net.js`、`js/iroh-worker.js`、`pkg/iroh_web_bg.wasm`（`000b2470…`）与本地逐一致 |
| roomd | `running` / `healthy` / `restarts=0`，容器内哈希 = `77280f12…`；启动日志 `房间能力：["history","rendezvous","announce"]`；**EndpointId 未变** |

新增的两条测试各自证明一件事：
- `a_custom_capability_…`：**注册一个核心不认识的能力就能用**，且它能通过 `Plugin` 事件把消息端给 UI。
- `join_announcement_subscribes_the_provider`：复刻 roomd 形态（controller 从 `join_rx` 收房间名），
  客户端只发声明 → 服务端订阅 → 消息进历史 → 后进房的人看得到。**全程没有任何"为触发订阅而拉历史"。**

> 备注：本轮完整 `verify.sh all` 的第一次跑里 `redesign` / `relay-enabled` 因**本机内存压力**
> （16G 机器只剩 ~107MB，Chrome 渲染进程被杀）出现 CDP `连接关闭`；两条用例单独复跑均 127/0、6/0。
> 重跑整轮即 **退出码 0**。这是环境问题，与本轮改动无关（阶段 D 也记录过同一现象）。

## 发布与回滚

- 顺序：**先 roomd、后前端**。
- 前端：Cloudflare Worker `iroh-chatroom`，版本 **`7eb4fa8a-f7f5-4a58-8b5a-10f9126c6051`**。
- 后端：roomd `77280f12…`（本次重建并替换容器内二进制）。
- 回滚点：
  - 数据：`/opt/iroh/backups/roomd/roomd-20261010T094757150567Z.tar.gz`
  - 二进制：`/opt/iroh/roomd/roomd.bak-20261010-174756`
  - 前端：上一个版本 `77b7da5e-5f14-44da-9334-93efa15358d2`
- 本轮**不动协议版本、不清历史**（v5 那次才清）。
