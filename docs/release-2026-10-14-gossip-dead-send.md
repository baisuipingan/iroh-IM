# 2026-10-14 gossip 修复：连接"发送半先死"时死邻居终于能清理

## 一句话

用户日志里 `failed to send: connection task send loop terminated peer=26ff38918c`
**每 10 秒一条、持续一小时**：gossip 与某个 peer 的直连早就坏了，但连接任务的
**发送半**先终止、任务本身还挂着（读半没有超时），而清理逻辑只挂在"任务结束"上 ——
于是死邻居永远留着、直连永不恢复、日志被刷爆（聊天仍可用只是**绕常驻节点**）。
修复：发送通道关闭 = 这条连接已经不可用，直接按"断连"处理，让协议状态机
（HyParView）走 NeighborDown → 从 passive view 补位/重拨。

## 证据

- 用户 room-bridge 终端：`WARN gossip{me=8ad7278039}: failed to send: connection task
  send loop terminated peer=26ff38918c` 以 ~10s 间隔刷屏 ≥1 小时（26ff38918c = 该用户浏览器）。
- 期间"问问题不受影响"：gossip 是网状，消息经常驻节点转一手照样送达 —— 坏掉的
  只是那条**直连冗余路径**。所以这条日志"没有功能性影响，但说明拓扑降级且不自愈"。

## 改了什么（vendor/iroh-gossip/src/net.rs）

- `OutEvent::SendMessage` 的 `Active` 分支：`send` 失败时不再只 `warn`。原注释说
  "清理交给 `handle_connection_task_finished`"——**那个清理在"发送半先死、任务没结束"
  时永远不会来**（实测一年一小时）。现在：把 `InEvent::PeerDisconnected(peer)` 产生的
  后续事件（含 `OutEvent::DisconnectPeer` → 移除 `self.peers` 条目）**续进同一轮事件队列**。
- 顺带把该函数的惰性事件迭代器改成显式 `VecDeque` 队列：既要续事件、又不能递归调用
  async 的 `handle_in_event`（会触发 `E0733: recursion in an async fn`）；
  `push_back/pop_front` 保持原顺序。
- 日志措辞改为 `... terminated; marking peer disconnected`（如实说明接下来的动作）。

## 验证

| 项 | 结果 |
|---|---|
| `cargo build`（cli features） | 通过 |
| workspace 测试（lib 80 + roomd 4 + 黄金转录 + `gossip-rejoin` + history ×11 + doc） | 全绿 |
| wasm 重建 + CF 部署 | version `eab276b3-7efc-48a1-894e-14d3cf0863ad`；线上 `pkg/iroh_web_bg.wasm` 哈希与本地一致（`ff7e30c1…`） |
| `verify.sh all` | **退出码 0**（29 处套件/子套件全 `FAIL=0`） |
| 说明 | 这个 race 无法用现有测试框架确定性复现（需要"发送半死、任务活着"的内部状态）；修复正确性由代码路径推理 + 全套回归守护，线上可观察：该 peer 若再死，只会出现**一条** "marking peer disconnected"，随后重拨恢复 |

## 发版

- 前端：CF 已发（含新 wasm；**浏览器刷新后生效**）。
- Agent：`agent-v1.5.0`（native `iroh-agent` 同源修复；`agent-install.sh` 自动取最新。
  用户重跑安装脚本即更新）。
- 回滚：`git revert` + 重发（wasm / Release 均可回退到上一版本）。
