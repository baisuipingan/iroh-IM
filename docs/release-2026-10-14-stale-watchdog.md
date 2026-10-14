# 2026-10-14 连接看门狗：睡一晚后"进程活着但失联"能自愈了

## 一句话

用户实测：笔记本息屏一晚，第二天打开 room-bridge **看起来还在跑**，但 @它没反应。
根因：iroh 的 gossip/中继连接在睡眠后没有恢复，而适配器只监控了**子进程活不活**
（本地 ping 照常成功——那只是同一进程的 stdin/stdout），没人看**连接活不活**。
新增"连接看门狗"：进房后长时间（默认 120s）收不到任何房间事件 → SIGKILL `serve`
让它自动重启、重新进房、重连。

## 证据（用户日志，2026-10-13 晚 → 10-14 早）

```
[adapter] 已回复 用户7454: …（三条，睡前正常）
WARN gossip{me=8ad7278039}: failed to send: connection task send loop terminated peer=26ff3891…   @ 01:41
WARN gossip{me=8ad7278039}: dial failed: timed out peer=5bcc4ea3bb                                @ 01:41
WARN gossip{me=8ad7278039}: failed to send: connection task send loop terminated peer=26ff3891…   @ 07:38（起床）
```
进程一直活着、ping 也通，但连接已经死透，且没有任何自愈动作。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `agent-pi/src/room/client.ts` | 连接看门狗：`#lastRoomEventAt`（任何 RoomEvent 都算心跳，presence 正常约 15s 一次）+ `#joinedSeen`（进房后才判定）；超过 `staleRestartMs`（默认 **120s**，0=关）无事件 → `SIGKILL` 子进程 → 现有重启循环拉起新进程、`--room` 自动重新进房。**有在途请求（如接收文件）时不打断**，下一轮再看 |
| 2 | `agent-pi/src/cli.ts` | 新开关 `--stale-restart-ms`（默认 120000；别设得比 presence 心跳还小，否则会误杀） |
| 3 | 测试 | `test-agent-client.mjs` 新增两条：静默 fake → 重启（≥2 次启动 + 明确日志）；持续事件 fake → 不误杀 |
| 4 | 文档 | agent-pi README 开关表 + BYOA 指南 FAQ（"睡一晚后不响应"） |

## 验证

| 项 | 结果 |
|---|---|
| 单元 | `test-agent-client.mjs` 4/4（含两条新用例） |
| **真机演练（冻结子进程复刻失联）** | `SIGSTOP` serve 子进程 → 看门狗触发（日志 `强制重启 agent 进程重连`）→ 自动重启 → `已进入房间` → 用第二个身份 `@它 ping` → **回复 `pong`**（完整自愈闭环） |
| 退出速度回归 | 仍为秒级（子进程先退时 `stop()` <1s） |
| `verify.sh all` | **退出码 0**；29 处套件/子套件全 `FAIL=0`（无任何失败） |

## 发版

- `bridge-v0.2.3`：CI run **`38496187420` success**（六平台 + 逐产物 sha256）；npm `iroh-room-bridge@0.2.3` 已发布（`latest`=0.2.3）。

## 回滚

纯增量：`--stale-restart-ms 0` 可关掉看门狗，行为退回 0.2.2。
