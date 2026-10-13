# 2026-10-13 昵称兜底：空昵称的消息/成员不再显示成「空白名字 + `?` 头像」

## 一句话

线上截图里那条 `?` 头像、名字空白的 "🙂" —— 是**发送方以空昵称签进消息里的**：
渲染层原样显示 `m.nickname`，空串就渲染成空白名字；头像取 `initial('')` 得到 `?`、
配色回落到 `hash('')` 的兜底色。本次只改**显示层**：昵称为空时统一兜底成
`用户+id8`（和浏览器端进房自动昵称 `用户4810` 同一风格），协议/签名/寻址不动
（@ 永远是按 EndpointId 寻址，昵称只给人看）。

## 根因与证据

- 拉取 `patrick` 房间历史（本机 v6 agent `serve` 协议，40 条）实测：

  ```
  10:01:44 | from=c0980ecf7087… | nickname="" | text="😀"
  15:47:30 | from=d98f46d1…    | nickname="" | text=""
  成员快照: [('', 'c0980ecf'), ('用户4810', 'c4a839aa'), ('体检', …), ('常驻节点', …)]
  ```

  空昵称是**签发进消息里的**（昵称在签名载荷内，中继/roomd 不改写），
  所以不是"前端查不到名字"，而是发送方进房时就没带昵称。
- 仓库内所有可控客户端都保证非空：浏览器启动兜底 `用户XXXX`（`frontend/main.js`）、
  设置页拒绝空昵称、Android 端 `nick.trim() || '匿名'`、agent CLI 默认 `命令行成员`、
  `serve` 协议 join 缺省回落到默认昵称。→ 该身份来自**外部/更老的客户端**。
- 渲染层的兜底缺口（本次修的就是这些）：
  - `timeline.js _bubble`：名字直接 `m.nickname`、头像 `avatar(m.nickname)` → 空白 + `?`
  - `timeline.js _fillMentions`：`s.nickname ?? s.id8` —— `??` 兜不住**空串**，chip 会渲染成光秃秃的 `@`
  - `roster.js` 头像 `'?'` / 名字 `'(无名)'`；`status.js` 成员行空白；
    `composer.js` @ 面板 `'(无名)'`；`notify.js` 通知正文 `'有人'`

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `frontend/js/util.js` | 新增 `U.displayName(nickname, id)`：空/纯空白 → `用户+id8`，全空 → `有人` |
| 2 | `timeline.js` `_bubble` | 名字与头像都走 `displayName(m.nickname, m.from)`（含历史消息） |
| 3 | `timeline.js` `_fillMentions` | chip 文案 `s.nickname ?? s.id8` → `known ? displayName(...) : id8`（顺带修 title 的「不在场」误标） |
| 4 | `timeline.js` 文件卡片接收者 | 收件人兜底名统一到 `displayName` |
| 5 | `timeline.js` `_profileLine` | 名片行的名字同兜底 |
| 6 | `roster.js` / `status.js` | 花名册、连接状态页成员行 → `displayName`（头像不再是 `?`） |
| 7 | `composer.js` @ 候选面板 | `'(无名)'` → `displayName` |
| 8 | `notify.js` | 桌面通知正文的发送者 → `displayName` |

零协议变更、零签名变更、零寻址变更。旧消息、旧客户端发来的空昵称消息**同样受益**
（渲染端兜底，不依赖发送方更新）。

## 测试

- 新用例 `scripts/e2e/nickname-fallback.py`（`run.sh` 已注册，9 项）：
  用 `net._dispatch`（Worker 推事件的真实路径）注入空昵称消息/成员，断言
  消息气泡、花名册、连接状态页、桌面通知四处都显示 `用户c0980ecf`，
  且**有昵称的消息照旧**（回归面，防兜底误伤）。
- 相关面回归全绿：`mention-id` 18/18、`profile` 20/20、`sidebar-pages` 7/7、
  `review-frontend` 19/19、`multi-peer` 19/19、`nickname-fallback` 9/9。
- `node scripts/smoke.mjs` 通过；`npx biome lint frontend` 无告警。

## 发版

- 前端：CF Worker `im.pinkstar.cc` 已发（Version ID `d436c3f8-f620-431f-86e0-245d773202e1`，本轮上传 6 个 JS）。
  `js/util.js`、`js/ui/timeline.js` 线上哈希与本地一致（部署后 curl 校验）。
- 回滚：前端回退上一 CF 版本即可（纯前端改动，无数据/协议迁移）。
