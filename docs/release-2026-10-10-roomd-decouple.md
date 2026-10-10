# 2026-10-10 前端发版：常驻节点不再是进房硬依赖（架构重构 阶段 A）

## 一句话

**roomd 挂了（或它那台中继不可达）不再让所有人进不去房** —— 降级为"孤立进房 + 后台重连"。

## 改了什么

背景：`join()` 原来是"连不上常驻节点就 `bail!`"。于是 roomd 从"房间里一个恰好常在线的
用户"变成了**进房必经的基础设施**：它一挂，全房间的人一起被挡在门外，哪怕彼此都在线、
中继也好好的。

- `client-wasm/src/room.rs`
  - 进房时"等第一个邻居"改成**有预算**的一次尝试（`ROOMD_JOIN_TIMEOUT`，默认 8s）；
    超时或失败 → **降级**：`subscribe(topic, [])` 照样进房，消息由 gossip 排队等邻居。
  - 新增 `RoomEvent::Isolated { room, isolated }`：如实区分"房间本来就没人"和"我联系不上人"。
  - 降级后起后台重连任务（`spawn_relink_task`，5s→60s 退避）：周期把种子重新交给 gossip，
    收到任何人的心跳就发 `isolated: false` 并收工（gossip 会补投排队期间的消息）。
  - 新增 `RoomOptions::join_timeout_ms`（可选，测试用；不传则默认）。
  - 敲门（要快照）的预算改为 `min(join_timeout, 5s)`：它只是尽力而为，不该成为新的等待大头。
- `frontend/js/{bus,net}.js` / `main.js`：接住该事件 —— 孤立时显示"暂时联系不上房间里的
  其他人，正在后台重连。这期间你发的消息会先排队。"（**不禁用输入、不报错**），
  恢复时提示并补拉一次历史。
  - ⚠️ `timeline.note` 是**单例槽位**：孤立事件在 `await joinRoom()` 期间到达，
    紧接着的"已进入「x」"会把它冲掉。所以孤立状态记在模块级 `isolatedRoom` 上，
    进房成功的文案按它二选一。
- `mobile/`：同状态进 `RoomState.isolated` + 顶部金色提示条；恢复时复用既有重连路径补历史。
- `scripts/e2e/isolated-room.mjs`（新增回归）：拦截 `relay-config.json`，把 anchor 换成一个
  **真生成的 ed25519 公钥**（格式合法、没人应答）→ 断言仍能进房、仍能发消息、如实提示孤立、
  不说成"进房间失败"；对照组（真 anchor）不出现孤立提示。已并入 `scripts/verify.sh browser`。

## 顺手修掉的两个**环境级**坑（这才是 e2e 一直飘的根因）

1. **`scripts/dev-serve.py` 的 accept 队列默认只有 5。**
   页面的 ES 模块是一次性并行拉取的（~25 个模块 + 3.6 MB wasm），Chrome 同时开 6~10 条连接，
   队列一溢出内核**直接 RST** → 浏览器报 `ERR_CONNECTION_RESET` / `ERR_SOCKET_NOT_CONNECTED`，
   页面停在"启动中"，而 `curl` 单个请求永远 200，极难往这上面想。
   症状实测：`theme-sync` 本地 100% 失败、换成线上域名就 16/16；`file-history` 稳定卡在进房。
   修法：`request_queue_size = 128` + `daemon_threads = True`。
2. **本机 CDP Chrome 走了系统代理**，localhost 被拦成 RST。带 CDP 跑浏览器回归时要加
   `--no-proxy-server --proxy-bypass-list='*'`（已记在这儿，脚本未改）。

修掉之后本地浏览器回归**从"到处飘红"变成全绿**（见下）。

## 验证

| 项 | 结果 |
|---|---|
| Rust 单元/集成/黄金转录 | 67 通过（新增 1 条：`unreachable_anchor_degrades_to_isolated_instead_of_failing`）|
| 安全攻击回归 | 17 + 1 通过 |
| CDP 主套件（14 用例） | **265 通过 0 失败**（file-history 17、multi-peer 19、file-recipients 34、review-frontend 19、dm-removed 15、stale 4、offline-room 4、refresh 4、leave-cancel 1、room-isolation 4、card-revive 4、sidebar-pages 7、redesign 127、relay-enabled 6）|
| 双内核 polish | 90 通过 |
| 历史滚动 / 主题同步 | 20 / 16 通过 |
| 图片布局 / 修复回归 | 94 / 52 通过 |
| 消息归属 / 存储与第四人 | 38 / 12 通过 |
| **孤立进房回归（线上）** | **7 通过** |
| 移动端 | `npm run typecheck`、`npm test` 通过 |
| 线上静态资源 SHA-256 | 与本地逐一致（含 `pkg/iroh_web_bg.wasm`）|

## 发布

- 前端：Cloudflare Worker `iroh-chatroom`，版本 **`57368978-3b78-4d5c-9b42-2da384201baa`**。
- 本次**重建了 wasm**（改的是 `room.rs`，会被编进 wasm），7 个产物更新。
- 后端 roomd **未动**：它自己就是 anchor（`bootstrap` 为空），阶段 A 的降级逻辑对它是**同一条既有代码路径**，
  行为不变 —— 所以没必要为一致性去重启它（真要重启会短暂断开它的 gossip 连接）。
- ⚠️ **相同 crate 编出的另外两个原生二进制仍是旧版**：`/opt/iroh/roomd/roomd` 与
  `/opt/iroh-agent/bin/agent`（`agent-v1.1.0`）。其中 **agent 目前仍带"连不上常驻节点就退出"的旧行为**，
  等阶段 B/C 的协议改动一起出 `agent-v1.2.0` 再换，避免"服务器上跑的二进制不属于任何 Release"。
- 协议版本未变（v4），历史/身份数据未动。
- 构建机：SSH 换了端口与私钥（**具体值见本机 `scripts/build.env`，不入库** —— 本仓库是公开的，
  不写主机名与密钥路径）；`scripts/build.env` 已同步。

## 回滚

前端回滚 = 在工作树里 `git checkout` 回上一个 wasm 与 JS，再 `bash scripts/deploy-web.sh`；
或直接在 Cloudflare 控制台把版本切回上一个。本轮不涉及数据迁移。

## 附：同一轮里的常驻 Agent 加固（agent-pi，2026-10-10 已上线）

同一台服务器上的 `iroh-agent-pi.service` 也做了三件事，均已生效并核对：

1. **冷却竞态**（P1）：`#lastReplyAt` 原本在"回复发出去之后"才更新，而 `#handle` 在
   `await brain` 处就让出了执行权 → 同一瞬间到达的多个触发各自打一次模型
   （实测两条回复间隔 0ms）。现在冷却在 `await` **之前**占位，并加 `#busy`
   保证"同时最多一轮在飞"。
2. **接收文件无累计上限**（P1）：单文件上限 + 并发上限都挡不住"反复发合规的小文件"。
   新增 `--files-max-total-mb`（默认 512 MiB，unit 已显式写 512）。
3. **以 root 运行**（P1）：改成专用系统账号 `iroh-agent`，并给 unit 加
   `ProtectSystem=strict` / `ReadWritePaths=/opt/iroh-agent` / `NoNewPrivileges` 等沙箱项。
   重启后已确认：进程属主 `iroh-agent`、hello 正常、成功进入房间 `patrick`。

新增单元测试 `scripts/test-agent-adapter.mjs`（7 条，覆盖并发触发、冷却窗口、id 去重、
累计上限、单文件上限、白名单），已并入根 `npm test` —— 这一层此前**一条单测都没有**。
