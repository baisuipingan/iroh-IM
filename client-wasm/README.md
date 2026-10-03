# 浏览器 wasm 客户端（iroh-web）

在浏览器里跑 iroh 端点，**只连自建中继**（`RelayMode::Custom`），并把中继连接状态与消息事件暴露给 JS。

## 为什么要有这个 crate

iroh 官方**不提供 npm 包**，且浏览器构建必须 `default-features = false`。所以想用就得自己写一个 wasm-bindgen wrapper —— 就是这里。

## 一个必须先接受的前提

**浏览器里的 iroh 永久 relay-only。** 浏览器沙箱不能发 UDP → 打洞逻辑无法移植 → 所有流量必经中继。
中继之间也不互转，所以拨号时必须知道对端**真实所在**的那个中继 URL（填错会 13s 超时，实测）。

## 目录结构

```
client-wasm/
├── Cargo.toml
├── src/
│   ├── node.rs        # 与平台无关的核心逻辑（浏览器 / 原生共用）
│   ├── wasm_api.rs    # wasm-bindgen 包装（feature = wasm，默认开）
│   ├── lib.rs         # 模块声明
│   └── bin/
│       └── relay_probe.rs   # 原生验证客户端（feature = cli）
```

## 构建

不要在本机直接编（拉依赖不稳、且 ring 需要 clang）。用统一脚本在构建机上编：

```bash
./scripts/build-wasm.sh           # dev 构建，产物拉到 frontend/pkg/
./scripts/build-wasm.sh release   # release（lto + opt-level=z）
./scripts/build-wasm.sh native    # 编原生 relay-probe 到 dist/
```

构建机（默认 `root@189.24.68.147:15601`）首次需要：

```bash
# Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
rustup target add wasm32-unknown-unknown
# wasm-pack
curl -sSL https://github.com/rustwasm/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz | tar xz -C /tmp
install -m755 /tmp/wasm-pack-v0.13.1-x86_64-unknown-linux-musl/wasm-pack /usr/local/bin/
# ring 需要 C 工具链
apt-get install -y clang lld llvm
```

## 本地验证

```bash
cd frontend && python3 -m http.server 8099
# 浏览器打开 http://127.0.0.1:8099/ ，点「探测全部中继」→「启动 iroh 节点」
```

自动化（无头 Chrome + CDP，零依赖）：

```bash
# 1) 起静态服务
cd frontend && python3 -m http.server 8099 &
# 2) 起无头 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
    --remote-debugging-port=9222 --no-first-run --user-data-dir=/tmp/chrome-iroh \
    "http://127.0.0.1:8099/?autostart=1" &
# 3) 抓结果
node scripts/browser-test.mjs http://127.0.0.1:8099/ 30
```

## JS API

```js
import init, { WebNode } from './pkg/iroh_web.js';
await init();

const node = await WebNode.start(JSON.stringify({
  relays: ['https://iroh1.editor.vip:8443', 'https://iroh2.editor.vip:8443'],
  secret_key_hex: keyFromIndexedDBOrLocalStorage,   // 不传则随机，刷新就换身份
}));

node.endpoint_id();          // 本机 ID（hex）
await node.online();         // 等至少一台中继握手完成（自己 race 超时）
node.relay_status_json();    // 同步读中继状态快照
const stream = node.events();// 事件流：relayStatus / peerConnected / message / error（只能取一次）
await node.send(peerIdHex, peerRelayUrl, 'hello');
node.shutdown();
```

## 已知限制 / 待办

- **中继鉴权未接**：现在中继是 `access = "everyone"`。要上鉴权时，浏览器设不了自定义 header，
  得走 `?token=` query（`RelayConfig::with_auth_token` 系列 API），或改用 HTTP callout + EndpointId 白名单。
- **地址发现未启用**：crate 用 `presets::Minimal` + `clear_address_lookup`（隐式），拨号必须自带
  `EndpointAddr`（id + relay url）。要"只给 ID 就能连"需要接回 n0 的 DNS/pkarr 或自建 DNS 服务。
- **消息协议很原始**：一条 QUIC bi stream = 一条消息。群聊应换成 `iroh-gossip`（topic 即房间）。
- **无历史消息**：relay 无状态 + 无持久层，新进房间看不到历史。需要一台常驻节点或落库。
- **身份持久化在 JS 侧**：`localStorage` 存 hex 私钥，生产建议换 IndexedDB + 多标签页选主。

## 验证结果（2026-09-29，全部通过）

原生客户端（`relay-probe`，在服务器上跑）：

| 用例 | 结果 |
|---|---|
| 单台中继 `https://iroh1.editor.vip:8443` | ✅ `home is now relay https://iroh1...`，`connected=true` |
| 两台都在名单里 | ✅ 选 iroh1（最近）做 home relay，iroh2 空闲不连 |
| 跨中继投递（发送端 home=iroh1，对端在 iroh2） | ✅ delivered，对端真收到 |
| 拨号指向对端不在的中继 | ❌ 20s 超时 |

浏览器（服务器 headless Chrome 154）：

```
节点状态 : 在线
探测状态 : 2/2 可用     hk-1 1.3ms / eu-1 247.4ms
中继连接 : iroh1.editor.vip:8443  已连接
```

体积：release wasm **2.67 MB**，gzip 后 **1.03 MB**（dev 构建 20.8 MB，别用它做首屏）。

## 探测的两个坑（已修，别再踩）

1. 中继 `/ping` **允许跨域读**，但不发 `Timing-Allow-Origin` → 计时明细被清零，**只能用 `duration`**，
   而且必须先预热（否则含 2～3 个 RTT 的握手，实测差 3 倍）。
2. **不要在 wasm 初始化期间探测**：dev wasm 20MB，主线程编译会让 2.5s 的探测超时，表现为"全部不可达"。
