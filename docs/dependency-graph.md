# 依赖关系图

> **口径**：本文件画的是**代码依赖**（谁 import / use 谁）与**产物依赖**（谁 spawn / 加载谁）。
> 运行时"谁连谁"的拓扑图不在这里，见 [architecture-refactor-plan.md §11](architecture-refactor-plan.md)
> 的 `architecture-2026-10-11.png`。两者互补：架构图回答"房间里有谁"，本图回答"改一个文件会牵动谁"。
>
> 图由实际 import / use 扫描得出（扫描方式见文末），不是凭印象画的。

---

## 1. 全局：源码 → 产物 → 运行

```mermaid
flowchart TD
  subgraph SRC["源码"]
    RUST["client-wasm/<br/>Rust crate `iroh-web`"]
    FE["frontend/<br/>纯 JS + HTML（零构建）"]
    PI["agent-pi/<br/>TypeScript"]
    MOB["mobile/<br/>React Native"]
    KOT["mobile/modules/iroh-native<br/>Kotlin"]
  end

  subgraph ART["产物"]
    WASM["frontend/pkg/iroh_web.js + .wasm"]
    AGENTBIN["iroh-agent 二进制"]
    ROOMDBIN["roomd 二进制"]
    GEN["protocol.gen.ts ×2"]
    SITE["dist/site"]
    BRIDGE["room-bridge 单文件适配器"]
    SO["libiroh-web.so (Android)"]
  end

  subgraph RUN["运行 / 部署"]
    CF["Cloudflare Worker<br/>agentchat.stream"]
    SRV["服务器 Docker<br/>roomd / relay"]
    LLM["LLM 大脑<br/>ACP / 子进程 / pi SDK"]
  end

  RUST -->|wasm-pack| WASM
  RUST -->|cargo build --bin agent| AGENTBIN
  RUST -->|cargo build --bin roomd| ROOMDBIN
  RUST -->|"bin/export-protocol (ts-export)"| GEN
  RUST -->|"cargo-ndk --features jni-bridge"| SO

  FE -->|"scripts/deploy-web.sh"| SITE
  PI -->|"scripts/build-room-bridge.sh"| BRIDGE

  WASM -->|"Worker import"| FE
  GEN --> PI
  GEN --> MOB
  SO --> KOT

  SITE --> CF
  ROOMDBIN --> SRV
  AGENTBIN -->|"spawn + JSON Lines"| PI
  PI --> LLM
  BRIDGE -.->|"npm / 安装脚本"| LLM
```

**要点**：`client-wasm`（Rust）是整张图的**根**——wasm、两个 native 二进制、三端协议类型
全部从它派生。前端是**零构建**的，所以前端唯一的"构建产物依赖"就是那份 wasm。

---

## 2. 协议单一来源链（最需要守住的一条边）

```mermaid
flowchart LR
  ROOMRS["client-wasm/src/room.rs<br/>client-wasm/src/filetransfer.rs"]
  TSX["client-wasm/src/ts_export.rs"]
  EXP["bin/export-protocol.rs"]
  GEN["mobile/src/bridge/protocol.gen.ts<br/>agent-pi/src/room/protocol.gen.ts"]
  PIW["agent-pi/src/room/protocol.ts"]
  MOBW["mobile/src/bridge/types.ts"]

  ROOMRS --> TSX --> EXP -->|"scripts/gen-protocol-types.sh"| GEN
  GEN --> PIW
  GEN --> MOBW
  GEN -->|"scripts/check-protocol-types.sh"| VERIFY["verify.sh：生成物 ≠ 提交物 → 红"]
```

前端是纯 JS、没有类型系统，所以它拿不到这条链的约束，改用等价检查：
`scripts/check-web-event-names.mjs` 断言 `net.js` 里 `case` 的事件名都真实存在于 `protocol.gen.ts`。

---

## 3. frontend/ 模块依赖（按层，非逐边）

```mermaid
flowchart TD
  subgraph L4["组装层"]
    MAIN["main.js"]
    TH["js/test-hooks.js"]
    PM["probe-main.js"]
  end

  subgraph L3["视图层 ui/"]
    SIDEBAR["sidebar.js"]
    TL["timeline.js"]
    COMP["composer.js"]
    FT["filetransfer.js"]
    NOTIF["notify.js"]
    ROSTER["roster.js"]
    MOTION["motion.js"]
    TOPO["topology.js"]
    THEME["theme.js"]
    DLG["dialog.js"]
    PRIM["primitives.js"]
    CHATS["sidebar/chats.js"]
    STATUS["sidebar/status.js"]
    SET["sidebar/settings.js"]
  end

  subgraph L2["动作 / 状态层"]
    NET["js/net.js"]
    PROBE["js/probe.js"]
    PROF["js/profile.js"]
    MENTION["js/mention.js"]
    RELAYM["js/relay-model.js"]
    PLUG["js/plugins.js"]
  end

  subgraph L1["内核（无 DOM 副作用）"]
    BUS["js/bus.js"]
    STORE["js/store.js"]
    UTIL["js/util.js"]
  end

  subgraph WK["Worker / wasm"]
    WORKER["js/iroh-worker.js"]
    PKGJS["pkg/iroh_web.js (.wasm)"]
  end

  MAIN --> L3
  MAIN --> NET
  MAIN --> PLUG
  MAIN --> TH
  TH --> L3
  TH --> NET
  PM --> PROBE

  %% 视图层的内部耦合（少数几条，逐条）
  SIDEBAR --> CHATS
  SIDEBAR --> STATUS
  SIDEBAR --> SET
  COMP --> FT
  MOTION --> ROSTER
  SET --> ROSTER
  ROSTER --> TL

  %% 视图 → 动作层
  L3 --> NET
  L3 --> PROF
  L3 --> MENTION
  TOPO --> RELAYM
  STATUS --> RELAYM
  MOTION --> RELAYM
  THEME --> STORE

  %% 动作层 → 内核
  NET --> BUS
  NET --> STORE
  NET --> PROBE
  NET --> PROF
  PROBE --> RELAYM
  NET --> WORKER
  WORKER -->|"await import()"| PKGJS

  %% 内核是全图共享依赖
  NET --> BUS
  L3 -.->|"全部视图"| BUS
  L3 -.->|"全部视图"| STORE
  L3 -.->|"全部视图"| UTIL
```

### 边界规则与现状

README「组装与依赖边界」定的两条规矩，以及目前的实际执行情况：

| 规则 | 是否有工具强制 | 现状 |
|---|---|---|
| 视图不得**反向依赖 `main`** | ❌ 靠约定 | ✅ 干净：无任何 view → main.js 的 import |
| 视图不得**导入另一个视图的门面** | ❌ 靠约定 | ⚠️ 有 4 条：`composer→filetransfer`、`motion→roster`、`settings→roster`、**`roster→timeline`** |
| 相对 import 的目标文件必须存在 | ✅ `scripts/check-site-modules.py` | 绿（但它**只查存在性，不查方向**） |

值得注意的一条：`roster.js` 直接读 `timeline._recent` / `timeline.room` / `timeline.me`
（下划线私有字段），这是"名册页要拿本次会话的历史窗口"。方向是**新视图 → 旧视图的状态**，
不是循环依赖，但确实越过了 README 里说的门面边界。

---

## 4. client-wasm/ Rust 模块依赖

```mermaid
flowchart TD
  subgraph LIB["lib.rs（crate iroh-web）"]
    ROOM["room.rs<br/>gossip + Wire + CapabilityRegistry"]
    FT["filetransfer.rs<br/>FILE_ALPN + BLAKE3"]
    SQL["sqlite_history.rs<br/>（cli feature）"]
    TS["ts_export.rs<br/>（ts-export feature）"]
    SIG["sigfmt.rs<br/>PROTO_V5"]
    ORCH["transfer_orchestrator.rs"]
    NODE["node.rs<br/>relay 探测专用 endpoint"]
    WAPI["wasm_api.rs<br/>（wasm feature）"]
    JNI["jni_api.rs<br/>（jni-bridge feature）"]
  end

  subgraph BIN["bin/"]
    B_ROOMD["roomd.rs"]
    B_AGENT["agent.rs (iroh-agent)"]
    B_PROBE["relay_probe.rs"]
    B_FT["filetest.rs"]
    B_ROOMT["roomtest.rs"]
    B_EXP["export-protocol.rs"]
  end

  ROOM --> FT
  SQL --> ROOM
  TS --> ROOM
  TS --> FT
  ORCH --> FT
  WAPI --> NODE
  WAPI --> ROOM
  WAPI --> ORCH
  JNI --> ROOM

  B_ROOMD --> ROOM
  B_ROOMD --> SQL
  B_AGENT --> ROOM
  B_AGENT --> FT
  B_AGENT --> ORCH
  B_PROBE --> NODE
  B_FT --> FT
  B_FT --> ROOM
  B_FT --> ORCH
  B_ROOMT --> ROOM
  B_EXP --> TS

  EXT["外部 crate：iroh / noq-proto / iroh-gossip(vendored) / blake3 / rusqlite"]
  ROOM --> EXT
  FT --> EXT
  NODE --> EXT
```

`iroh-gossip` 被 `[patch.crates-io]` 指到本仓库的 `vendor/iroh-gossip`
（改过上游代码，所以这是**源码依赖、不是版本依赖**，升级 iroh 时要注意）。

---

## 5. agent-pi/ TypeScript 模块依赖

```mermaid
flowchart TD
  CLI["src/cli.ts"]
  MOD["src/mod.ts（对外入口）"]
  SUM["src/summoner.ts<br/>（召唤别的 agent 进房）"]

  subgraph ROOMD["room/"]
    CLIENT["client.ts<br/>spawn `iroh-agent serve`"]
    ADAPTER["adapter.ts"]
    PROTO["protocol.ts"]
    PGGEN["protocol.gen.ts（生成物）"]
    PROFILE["profile.ts"]
    BOOT["bootstrap.ts"]
    PRESET["presets.ts"]
  end

  subgraph BRAIN["agent-io/"]
    IDX["index.ts<br/>AgentBrain 接口"]
    RULE["rule.ts"]
    CMD["command.ts"]
    ACP["acp.ts"]
    PISDK["pi-sdk.ts"]
    TOOLS["tools.ts"]
  end

  PI["@earendil-works/pi-coding-agent"]
  AGENTBIN["iroh-agent 二进制（Rust bin/agent.rs）"]

  CLI --> CLIENT
  CLI --> ADAPTER
  CLI --> RULE
  CLI --> CMD
  CLI --> BOOT
  CLI --> PROFILE
  CLI --> PRESET
  SUM --> CLIENT
  SUM --> ADAPTER
  SUM --> IDX
  MOD --> ROOMD
  MOD --> BRAIN

  CLIENT --> PROTO
  PROTO --> PGGEN
  ADAPTER --> CLIENT
  ADAPTER --> IDX
  PROFILE --> CLIENT
  RULE --> IDX
  CMD --> IDX
  ACP --> IDX
  PISDK --> IDX
  PISDK --> PI
  TOOLS --> PI
  CLIENT -->|"spawn + stdin/stdout"| AGENTBIN
```

**两个"跨语言"的边**，是这张图里最容易断的地方：
`client.ts → iroh-agent`（行协议 + `IPC_VERSION`）与 `protocol.gen.ts`（版本串必须与 Rust 一致）。
协议 bump 时，`iroh-agent` 二进制、`protocol.gen.ts`、`IPC_VERSION` 三者要同窗口换完。

---

## 6. mobile/ 与 Kotlin 桥

```mermaid
flowchart LR
  UIR["mobile/src/bridge/useRoom.ts"]
  TRANS["bridge/transport.ts<br/>（接口）"]
  NAT["bridge/native.ts"]
  MOCK["bridge/mock.ts"]
  KOT["modules/iroh-native (Kotlin)"]
  JNI["Rust jni_api.rs"]
  ROOM["Rust room.rs"]
  GEN["bridge/protocol.gen.ts"]

  UIR --> TRANS
  NAT -.->|"implements"| TRANS
  MOCK -.->|"implements"| TRANS
  NAT --> KOT
  KOT -->|"nativeInitContext / nativeCreate"| JNI
  JNI --> ROOM
  NAT --> GEN
  UIR --> GEN
```

> `nativeInitContext` 必须被调用，否则 Android 直接 SIGABRT（见 `Cargo.toml` 注释）。

---

## 7. 扫描方式（图变了就重跑）

```bash
# 前端 import 图
rg -n "^import .* from ['\"]\." frontend --glob '*.js'
# Rust 模块依赖
rg -n "^(use crate|mod|pub mod) " client-wasm/src --glob '*.rs'
# agent-pi / mobile 的 TS import
rg -n "from ['\"]\." agent-pi/src mobile/src --glob '*.ts'
# 校验链（谁在强制这些边）
sed -n '1,40p' scripts/verify.sh
```
