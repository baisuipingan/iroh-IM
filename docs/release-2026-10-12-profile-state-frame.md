# 2026-10-12 V6.2：名片升为「房间状态帧」

## 一句话

名片从"约定格式的聊天消息"（R2a 过渡方案）升为**独立签名的状态帧**：
改名片 = 广播一条 `Wire::Profile`（`u`）—— **不进聊天历史**、广播即达；
常驻节点**直接记账**（新表 `profiles`，不再靠扫历史）、快照继续做"新人补全"的权威；
旧的名片消息**仍然照读**（迁移期两个来源按 `ts` 合并取新）。

## 改了什么（全部已核实）

- **Rust 核心**（`room.rs` / `sqlite_history.rs` / `wasm_api.rs`）：
  `ProfileFrame`（房间进签名载荷、标签去重+排序）；`Wire::Profile { u }`；
  `RoomEvent::Profile`（单人实时事件）；`Client::set_profile(bio, tags)`（广播 + 本端自收）；
  `HistoryStore` 增名片档案（内存 + SQLite `profiles` 表，`ON CONFLICT ... WHERE 更旧不覆盖`），
  进程启动时把档案**种回内存**（重启后"只认更新的"仍有基线）；
  `latest_profiles` = 名片消息扫描 ∪ 状态帧档案，按 `ts` 合并取新。
- **roomd**：收到 `Wire::Profile` → 验签 → `upsert_profile_async` 落账；
  拉历史时的快照照旧填"每人最新一份"（来源现在含帧档案）。
- **前端**：`net.setProfile()`（走 RPC）；`case 'profile'` 事件与快照学走同一条
  `mergeSnapshot()`；「我的名片」对话框改走帧（**不再产生聊天消息**）；
  **进房时重播自己的名片帧**（roomd 错过广播/换库时的兜底；幂等）。
- **agent-pi**：协议类型重生成（多一个事件变体）。**旧版 agent 二进制无需重发**：
  收端对未知 `Wire` 变体是"解析失败→整帧丢弃"，兼容无碍（已核实两处 receive 循环）。

## 兼容性

| 组合 | 结果 |
|---|---|
| 旧端 × 新帧 | 旧端忽略 `u` 帧（无害）；旧端**自己发**的名片消息仍被新端学习 |
| 新端 × 旧名片消息 | 照读（`parse_profile`），与帧档案按 `ts` 合并 |
| 历史/快照 | `profiles` 是新表（`CREATE TABLE IF NOT EXISTS`），**无迁移**；messages 不动 |

## 验证数字

| 项 | 结果 |
|---|---|
| Rust | 库测试 **77**（新增：帧签名/房间绑定/标签规范化；档案只认更新的、与消息按 ts 合并）+ 集成全绿 |
| SQLite 持久化 | 新增 `profile_frames_persist_and_merge_with_messages`（重开后基线仍在、旧帧/旧消息都盖不过） |
| 浏览器回归 `profile`（重写为帧语义） | **20/20**：帧**不进历史** / B 侧实时看到（广播）/ 新人只能从**快照**看到 / 55 条消息后仍看得到（快照权威）/ 「忙碌」标签 → 花名册状态 / 离线分组 |
| `verify.sh all` | **退出码 0**（干净整轮：file-recipients 34/34、redesign 127、mention-id 18、profile 20/20… 全绿） |
| 线上哈希 | roomd `0529e182750eb571…`（两侧一致；旧件备份 `roomd.bak-v61-20261012-132820`）；CF `a4e14e36-5d1c-4b14-b6b0-f7417a29bd1a` |
| 服务 | `iroh-agent-pi` active（适配器 rsync 后重启）；roomd 容器 healthy |

## 回滚

1. roomd：`cp roomd.bak-v61-20261012-132820 roomd && docker compose up -d --build`
2. 前端：回退上一 CF 版本（或 `git revert <本提交>` 后 `deploy-web.sh`）
3. 适配器：`git checkout <上一提交> -- agent-pi/src` + rsync + 重启

数据面**无需回滚**：`profiles` 表留着不碍事（旧版 roomd 不读它）。

## 反漂移自检（方案 §8 逐条）

1. **房间只是场地**：是 —— 名片是"成员自己的状态"，房间不新增任何登记表。
2. **@ 只按 id 寻址**：是 —— 本期不动寻址。
3. **加 agent = 加 spawn 配置**：是 —— 适配器零功能改动（只有类型重生成）。
4. **可单独回滚**：是 —— 见上（三件套任一退回都不破数据）。
5. **决策与现实冲突**：无。
