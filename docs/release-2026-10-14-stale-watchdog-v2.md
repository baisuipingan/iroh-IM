# 2026-10-14（补丁）连接看门狗 v2：中继状态事件不再"骗"过它

## 一句话

昨天上线的连接看门狗（0.2.3）有个漏洞：它把**任何**协议事件都当"还连着"的心跳，
而 `relayStatus` ——"家庭中继反复横跳"时几秒一条的事件 —— **并不证明房间连通**。
用户中午回来发现又断了、且**没有任何自愈动作**：中继事件一直把心跳续着，
看门狗被骗成"一切正常"。0.2.4 修好了判定语义（并加了"中继全断"的提前判定）。

## 证据

用户 0.2.3 运行日志（2026-10-14 中午）：

```
INFO endpoint{id=8ad7278039}:relay-actor: home is now relay https://iroh2…, was Some(RelayUrl("https://iroh1…"))   ← 反复横跳
INFO … home is now relay https://iroh1…, was Some("iroh2…")
…
WARN gossip: dial failed: timed out peer=26ff3891c
WARN gossip: dial failed: timed out peer=5bcc4ea3bb
```

进程活着、relayStatus 持续在流，但房间已经联系不上 —— 全程没有任何"强制重启"日志。

## 改了什么（`agent-pi/src/room/client.ts`）

| # | 改动 |
|---|---|
| 1 | 心跳判定语义化：只有**能证明房间连通**的事件才更新心跳（presence / message / joined / peerUp / …）；`relayStatus`、`error`、`isolated:true` **一律不算**（后两者分别代表"本地错误"和"联系不上"） |
| 2 | 新增**中继全断**的提前判定：`relayStatus` 显式告诉我们所有中继都断开且已 > max(5s, staleMs/2) 没有房间事件 → 不等满 `staleMs` 就重启 |
| 3 | 检查频率从"staleMs/4（可到 30s）"收紧到 **5s 上限**：判定到动作更贴近阈值 |
| 4 | 日志把原因说清楚：`进房后 Ns 收不到任何"能证明连通"的事件（relayStatus 之类的中继事件不算数 / 且中继全部断开） → 强制重启…` |

## 验证

| 项 | 结果 |
|---|---|
| 单元（`test-agent-client.mjs`） | **6/6**：新增 ① relayStatus 每 100ms 刷屏 → 仍然判定失联并重启（日志含理由）；② 中继全断 → 不到 staleMs 提前重启。原有 4 条（快退出×2、静默→重启、事件正常→不误杀）不回归 |
| 现场复刻（真适配器 + 假 serve） | 假 serve hello+joined 后每 200ms 一条 relayStatus、永不来房间事件：`--stale-restart-ms 4000` → 5s 即打印 `收不到任何"能证明连通"的事件（relayStatus 之类的中继事件不算数） → 强制重启`，随后 `1000ms 后重启（第 1 次）` |
| 真机自愈（0.2.3 已验证，语义未变） | SIGSTOP serve → 重启 → 重新进房 → @它回 pong |
| `verify.sh all` | **退出码 0**；29 处套件/子套件全 `FAIL=0` |

## 发版

- `bridge-v0.2.4`：CI run **`38517139105` success**（六平台 + 逐产物 sha256）；npm `iroh-room-bridge@0.2.4` 已发布（`latest`=0.2.4）。

## 回滚

纯增量：`--stale-restart-ms 0` 关掉看门狗即回到"不重启"行为。
