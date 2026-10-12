# 2026-10-12 R2b：名片进房间快照（老名片新人也看得到）

> 这是 R2 的后半。前半（客户端侧：签名消息 + 本地聚合）见
> `docs/release-2026-10-12-profile-r2a.md`。R2a 的缺口是：
> **名片一旦被后来的消息挤出"最近一页"，客户端就再也学不到了**（它只加载一页）。

## 一句话

常驻节点手上有**全量历史**，于是让它在"首次拉历史"时顺手把
**每人最新的一份名片**填进房间快照 —— 新人一进房就有，不必翻页。

## 怎么做的（以及为什么这样最省）

| 决定 | 理由 |
|---|---|
| 不新增协议帧，只在**快照**里加字段（`bio`/`tags`/`profile_ts`，都带 `#[serde(default)]`） | 快照是"服务端 → 客户端"的响应体，加字段是**非破坏性**的；旧客户端忽略未知字段照常工作 |
| 不维护"增量名片状态" | 历史才是权威。查一次比"每条消息都更新一份内存副本 + 重启还要重建"简单，也不会出现两份真相 |
| **只在首次拉历史时查**（`before` 为空） | 这个查询要按房间把"名片那些行"挑出来 —— 翻页时反复跑不划算，而名片本来就只在"刚进房"那一下有用 |
| 查询用 `json_extract(json,'$.text')`，**不是** `LIKE` 扫整列 | 见下面那个真 bug |

### 顺手挖出的一个"静默失效"的真 bug

第一版我写的是 `CAST(json AS TEXT) LIKE '%{"t":"profile"%'`。它**永远返回空**、
而且**不报错** —— 因为 `text` 在整条消息 JSON 里是**被转义的**（实际是 `{\"t\":...`）。
表现就是"名片查询一直是空的"，而且没人会发现。

改用 `json_extract`（先把字符串解码）后正常；并把这个假设**钉成回归断言**
（`client-wasm/tests/history-storage.rs` 的 `profile_lookup_is_a_two_stage_filter`：
断言那条朴素 `LIKE` 的命中数**必须是 0** —— 如果哪天它不为 0，说明存储格式变了，
得重新审视这个查询）。

## 改了什么

| 文件 | 改了什么 |
|---|---|
| `client-wasm/src/room.rs` | `MemberSnapshot` 加 `bio`/`tags`/`profile_ts`；新增 `MemberProfile`、`PROFILE_PREFIX`（**与前端 `js/profile.js` 严格一致**）、`is_profile_text`、`parse_profile`（带上限、永不 panic）、`latest_profiles_from`（按 ts 折叠，**不依赖输入顺序**）、`fill_snapshot_profiles`；`HistoryService` 在首页把名片填进快照；新增事件 `RoomEvent::Profiles` |
| `client-wasm/src/sqlite_history.rs` | 新增 `messages_with_text_prefix`（`json_extract` 版本） |
| `client-wasm/src/lib.rs` 等导出 | `MemberProfile` 进 TS 生成物（三端类型同步） |
| `frontend/js/profile.js` | 抽出唯一的写入口 `upsert`；新增 `mergeSnapshot`（快照来的名片也走同一套"只认更新"的规则） |
| `frontend/js/net.js` | `case 'profiles'` → 并进本地名片表（花名册立刻可见） |
| `scripts/e2e/profile.py` | 新增 E 段（R2b 验收，见下） |

## 验证

| 项 | 结果 |
|---|---|
| Rust 单测 | **72 通过**（新增"名片只认固定前缀并按时间取每人最新一份"）；`history-storage` **9 通过**（新增两层过滤 + 那个回归断言） |
| 新 e2e 段（`profile.py` 的 E 段） | **15/15 全绿**。做法：先把名片"挤出去"（发 55 条填充 → **等到**"名片之后 ≥50 条"这个前提成立）→ 新成员进房 → 断言 ①它的最近 50 条里**没有**名片消息 ②它的时间线里**没有**名片行 ③**花名册里仍然看得到简介**（只能来自快照） |
| `verify.sh local` | 退出码 0 |
| `mobile` tsc | 通过（新事件与 `MemberProfile` 已进三端类型） |
| `bash scripts/verify.sh all` | **退出码 0**（一次干净整轮：Rust / 安全攻击 / 4 组 Node 套件 / 17 组浏览器套件，含新增的 `profile` E 段） |

> ⚠️ 写这条用例时**测试自己踩了两个坑**，都靠"前提断言"揪出来：
> ① `Page.ev` 不传参数，而我把填充循环写成 `(async (n) => …)` → `n` 是 undefined，
> 循环一次都没跑、**而且不报错**；② 定位"老名片"却用 50 条那页去查 —— 它早就不在那一页里了。
> 现在的写法：数字内联、查询放大窗口、并且**等前提成立**再断言结论（而不是睡固定秒数）。

## 发版与回滚

- 顺序：**先 roomd、后前端**（同窗口）。
- roomd：`b64e61f9a29c67e6`（容器内 `sha256sum` 实测相等）；
  回滚副本 `/opt/iroh/roomd/roomd.bak-20261012-161421`（= v5 那份）。
- 前端：Cloudflare Worker `iroh-chatroom` → **`786ab6d6-4d7a-4476-902b-9f48be492396`**；
  线上哈希与本地逐一相等：`pkg/iroh_web_bg.wasm` `c2a9957bf92f5a3e`、
  `js/profile.js` `bb259aa6a314aa9a`、`js/net.js` `bd2fe394dd2dc1b1`、`js/ui/roster.js` `6a614ce7b66a1265`
  （回滚点：上一个 CF 版本 `443786c0-be5c-4630-9bcc-339db78abef5`）。
- agent：**未动**（本次改动在 roomd 与客户端，不影响 agent 的行为）。
  它仍来自 Release `agent-v1.2.0` —— 部署的二进制与它那个 Release 的源码一致。
- 数据面：无 schema 变更（快照字段是响应体，历史表不动）。

## 反漂移自检（方案 §8 逐条）

1. **有没有让"房间只是场地"变差？** 没有：名片仍是**成员自己发的消息**；
   常驻节点只是"顺手把它带给新人"，没有登记任何"清单"。
2. **有没有把昵称当寻址依据？** 没有：名片按 `from`（EndpointId）索引与填充。
3. **新增 agent 接入要不要改房间侧？** 不需要：agent 只要发同样格式的一条消息就能有名片。
4. **能不能单独回滚？** 能：roomd 二进制换回 `.bak`，前端切回上一个 CF 版本。
   ⚠️ 顺序：先回 roomd、再回前端（新客户端对旧 roomd 是**兼容**的：拿到没有名片字段的快照
   就退回 R2a 的行为）。
5. **有没有已拍板决策与现实冲突？** 没有。R2 的两半（客户端聚合 + 快照聚合）都完成了。
