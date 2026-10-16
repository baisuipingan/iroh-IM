# 2026-10-16 单实例 Agent 监督器：修复隔夜后同身份连接互相顶掉（room-bridge 0.2.6）

## 现场证据

这次截图里的核心错误是：

`Another endpoint connected with the same endpoint id. No more messages will be received.`

它不是普通的网络延迟，而是同一份 `identity.key` 同时被多个 `iroh-agent serve` 使用。现场进程树进一步确认：只有一个 `room-bridge`，但它的 PID 下面累积了 **5 个**同房间、同昵称的 `iroh-agent serve` 子进程。roomd 也在同一时间记录了 OPENCODE 重复心跳，随后邻居下线。

## 原因

原来的自动重启流程有三个状态机缺口：

1. 重启循环没有“单飞”锁，多个退出/失联信号可以同时进入重启流程；
2. `spawn` 没有保护，新的 `serve` 可以覆盖旧子进程引用；旧子进程随后退出时，会把新子进程的引用清掉并再次触发重启；
3. 某次重启握手成功后，看门狗没有重新启动。第一次恢复之后，进程就失去隔夜自愈能力。

这几个问题会把“保活”变成“不断制造同身份连接”，所以之前反复重启和调整阈值都不能根治。

## 修复

`agent-pi/src/room/client.ts` 现在保证：

- 一个 `AgentClient` 同时最多持有一个 `serve` 子进程；并发 `start()` 直接拒绝；
- 每个子进程按对象身份关联 `hello`、协议帧和 `close`，旧子进程不能污染当前子进程；
- 自动重启循环单飞；
- 重启握手超时会杀掉对应的旧子进程，再尝试下一轮；
- 重启成功后重新挂载 ping 看门狗和连接看门狗。

## 验证

| 项 | 结果 |
|---|---|
| `scripts/test-agent-client.mjs` | 8/8：退出速度、连续两次失联恢复、relayStatus 误导、并发 start 单实例、握手前崩溃不累积、正常连接不误杀 |
| agent-pi TypeScript 类型检查 | 通过 |
| 真实 Release 二进制 | 发布后复跑隔离房间 e2e：桥重启窗口补投回复 `pong`，第二次重启不重复回复 |
| 当前本机进程 | 旧版重复子进程已清理，room-bridge 重启后只保留 1 个 `iroh-agent serve` |

## 用户可见结果

room-bridge 重启或电脑从睡眠恢复时，最多只有一个身份连接。遇到真正的网络失联，它会重启同一个 `serve` 并继续运行看门狗；不会再因为监督器本身制造多个同身份连接。
