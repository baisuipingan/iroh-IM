# 2026-10-12 协议 v6：结构化 mentions（进签名载荷）+ 双读 + 握手升 v6

> 方案 §V6 的第一刀（**唯一一次破坏性改动**）。与 v5 那次不同：**双读落地，历史不清**。

## 一句话

`ChatMessage` 的签名载荷加进结构化 `mentions: [EndpointId]`（@ 的寻址真相，
文本里的 `@<id8>` 降级为**渲染锚点**）；验证端**双读**（先按 v6 验、失败回退 v5）——
旧消息、旧历史、旧端发来的消息照常可读。换代信号走握手版本（v6），旧端会明确看到
"对端是 v6，请刷新/升级"，而不是静默丢消息。

## 改了什么（全部已核实）

- **Rust 核心**：`ChatMessage` 加 `mentions`（去重+排序后进签名；空列表不上线）；
  `canonical()`/`canonical_legacy()` + `verify()` 双读；`Client::send(text, mentions)`；
  `agent serve` 的 `say` 收可选 `mentions`；hello `chatProtocol` / 各响应 `protocol` 字段
  / `CHAT_PROTOCOL` 生成值 → **v6**。
- **只有 ChatMessage 的标签升 v6**：presence / leave / filequery / filectrl 载荷没变，
  标签仍是 v5 ⇒ 过渡期这些帧**双向互通**（比"全族升 v6"更稳、更省）。
- **三端接线**：agent-pi `say(mentions)` + 触发优先读结构化 mentions（token 兜底 v5 消息）；
  前端 `resolveDraft` 在改写 token 的同时产出完整 EndpointId 列表，`net.send` 一路带上去；
  召唤器转交同时带 `@<id8>`（锚点）+ mentions（真相）。
- **版本**：`iroh-web 0.3.0`（hello 报 `iroh-agent/0.3.0`）；agent Release **`agent-v1.3.0`**；
  `install-release.sh` 默认值跟到 v1.3.0。

## 与 v5 切割的关键差别：**没清历史**

v4→v5 是"旧签名验不过 ⇒ 清库"。v6 引入双读后不再需要：

> 实测证据（切换完成后）：用一个全新 v6 客户端进 `patrick` 房间拉历史，
> **10-11 00:58 的旧消息仍被验签通过、正常读出**（`signed=True`），
> roomd SQLite 里的历史一条没动。

## 部署（一次窗口：roomd → 前端 → agent）

| 环节 | 结果 |
|---|---|
| roomd | `dist/roomd` 替换 + `docker compose up -d --build`；旧二进制备份 `roomd.bak-v5-*`；新哈希 `84264e322fb39533…`；容器 healthy；历史库原样；日志出现对旧端的握手提示（"本端可双读它的消息…"） |
| 前端 | CF `888adb02-0768-4d8d-8d94-3da8a3c03aa1`（10 个文件）；线上哈希与本地逐一相等：`pkg/iroh_web_bg.wasm` `9756d355…`、`js/mention.js` `91a8e0a8…`、`js/net.js` `5351d150…`、`js/iroh-worker.js` `e6c3ce4a…` |
| agent 二进制 | Release **`agent-v1.3.0`**（12 资产 + SHA256SUMS；CI 全绿）。服务器经 `deploy/agent/install-release.sh` 安装（逐产物 sha256 校验通过，`install-ok 4d5a0d52…`） |
| agent-pi 适配器 | `rsync --delete src/`；`room/protocol.gen.ts` 两侧一致 `225c7374…`；服务重启后 active，日志：`hello：… chatProtocol=v6` → `已就绪` → `已进入房间 patrick` |

## 验证数字

| 项 | 结果 |
|---|---|
| Rust | **75** 个库测试 + 全部集成（含 golden 转录；转录 diff 只有两个版本串）全绿 |
| 新增 Rust 测试 | mentions 进签名（改/加/减都验不过）、**双读 v5 旧签名仍验得过**、旧 JSON 缺字段可读、空 mentions 不上线 |
| agent-pi | adapter **14/14**（含结构化触发/T 3 例）、summoner **11/11**（转发带 mentions）、acp **8/8**、tsc + biome 干净 |
| 前端 | test-frontend **10/10**（新增 resolveDraft→mentions）；`check-protocol-types.sh` 三端一致 |
| 真端到端（预切，真实中继） | 召唤器 e2e 全绿：@注册名 → 🫡 → 名册 → **转交带 mentions** → 拉起的成员（v6 最小示例）按 mentions 答复 |
| **`verify.sh all`** | **退出码 0**（17 组浏览器套件 + polish 全绿：file-recipients 34、redesign 127、mention-id 18、profile 21…，全部对着**已升 v6 的生产 roomd** 跑） |
| 线上抽查 | 新客户端进 `patrick`：`hello chatProtocol=v6`，旧历史可读（见上） |

## 回滚（三者一起退回，缺一即半切）

1. roomd：`cp roomd.bak-v5-<时间戳> roomd && docker compose up -d --build`
2. 前端：回退到上一 CF 版本（或 `git revert 0188f8b` 后 `deploy-web.sh`）
3. agent：`VERSION=agent-v1.2.0 bash deploy/agent/install-release.sh` + 回退适配器源码（`git checkout <上一提交> -- agent-pi/src`）+ 重启服务

**历史不受影响**（双读两侧都认；回滚也不丢）。

## 未做 / 另排（显式记录）

- **Android**：`android-v0.2.0` 的 .so/APK 是 v5 时代产物，与 v6 房间**聊不到一起**
  （它读不到 v6 聊天；但 presence/文件互通）。另排 `android-v0.3.0`（CI 有 build-android-so 工作流）。
- **V6.2 名片房间状态帧**：加法（新帧类型），不妨碍本刀；下一期。
- **V6.3 可选加密**：先写威胁模型再定。

## 反漂移自检（方案 §8 逐条）

1. **房间只是场地**：是——只往签名载荷里加了"@ 谁"，房间不新增任何登记表。
2. **@ 只按 id 寻址**：是——mentions 里就是 EndpointId；昵称仍只给人看。
3. **加 agent = 加 spawn 配置**：是——适配器只改了一行契约参数（`say(mentions)`）。
4. **可单独回滚**：是——见上，历史不受损。
5. **决策与现实冲突**：一处**显式调整**并已记录：原切割方案写"presence/文件族一起换标签 +
   五族都双读"；实现时收敛为"**只有载荷变了的 ChatMessage 升 v6**，其余族保持 v5"——
   更小改动、过渡期这些帧还能双向互通。方案文档已同步。
