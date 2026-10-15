# 2026-10-15 两个"必须重启才恢复"的 bug：空昵称 join + 死邻居不重拨

## 背景（用户现象）

> "我电脑没关，他怎么又没了" —— room `agenthub` 里 OPENCODE 又不在线；
> room-bridge 日志每 10 秒一条 `failed to send: … marking peer disconnected`，
> 持续一小时以上；同时房间里的浏览器心跳显示为**空昵称**。

三条独立证据拼出了完整链条：

1. roomd：`[agenthub] 用户7454 在线` 最后一次是 **03:12Z**；**07:52Z 起变成
   `[agenthub]  在线`（空昵称）**，到排查时已 122 条 —— 浏览器在刷新后以**空昵称**进房。
2. 中继：近 12h **0 条** "same endpoint id" —— 排除"双开/双连接打架"。
3. roomd 中 OPENCODE 完全不在线（连"最近见过"都没有）—— 它的 presence 从来没送达；
   而它自己每 10s 仍在"对着一条死连接广播"。

## 根因 A：刷新后的"自动回房"用空昵称 join（前端）

`openRoom()` 在**中继还没连上**时会走离线分支：`pendingRoom = room` +
`net.noteDesiredRoom(room)`。等中继上线，`_goOnline()` 的恢复路径执行
`joinRoom(wantRoom, this._nick)` —— **新页面此时 `_nick` 还是空串**，于是
`join(room, "")`。此后：

- UI 显示的名字来自 `store.nick()`（看起来一切正常）；
- 但**线上**（presence / 消息签名）的昵称变成空 ——房间里别人看到的是空白名。
- 这同时是 **10-13 那批"空昵称成员"谜案的源头**（当时的显示层兜底只是治了标）。

**修复**：`net._joinRoomOnce()` 在唯一的 join 咽喉处兜底：
`const nick = String(nickname||'').trim() || store.nick();`

## 根因 B：gossip 死发送半"只标记、不移除"（core / vendored iroh-gossip）

10-14 的修复让发送失败时**通知协议状态机** PeerDisconnected（日志改成
`marking peer disconnected`），但**没有清掉本地 `self.peers` 条目**。
当协议状态机早已不认识该 peer（不在 active view）时，PeerDisconnected
不产生任何 OutEvent —— 条目永远留着死通道：

- 每次广播（presence 心跳，10s 一次）都对死通道重演"失败→标记"，永不重拨；
- 该 peer 的连接是"发送半死、接收半活"→ 本端仍能*收到*房间流量
  （所以连接看门狗一直被喂、不会重启它）；但对端永远看不到本端 ——
  正是"进程在跑、人在房间里却消失"的形态。

**修复**：`self.peers.remove(&peer_id)` —— 下一次 SendMessage 走 Pending
（排队 + `queue_dial` 重拨），让 HyParView 修复视图。

## 验证

| 项 | 结果 |
|---|---|
| Rust | 全绿（lib 80 + roomd 4 + 黄金转录 + gossip-rejoin + history ×11 + doc） |
| e2e `nickname-fallback`（新增 3 条双页检查） | **12/12**：空昵称 join 后**别的成员仍看到真名**、本端 store 不变、前提（B 能看到 A）成立 |
| `verify.sh all` | **退出码 0**（30 处套件/子套件全 `FAIL=0`） |
| 前端 | CF 已发（Version `32f8b18b-bbd9-409b-8fa1-a298df8034c5`）；`js/net.js`、`pkg/iroh_web_bg.wasm` 线上哈希与本地一致 |
| Agent | `agent-v1.5.1`（CI 见下） |

## 用户操作（两步）

```bash
# 1) 更新 native 侧（死邻居重拨的修复在这里）
bash -c "$(curl -sSL https://get.editor.vip/iroh/agent-install.sh)"
# 2) 强刷浏览器（wasm + net.js 修复都在前端），再重启 room-bridge
```

> 已中招的**运行中进程**不会自愈（修复在新二进制/新页面里），必须重启一次；
> 之后再遇到同样的半死连接，它会自动丢弃并重拨。
