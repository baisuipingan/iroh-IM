# 2026-10-09 前端发版：接收端保存位置

## 本次（第二次）

- 前端：Cloudflare Worker `iroh-chatroom`，版本 `7b278bad-227f-4172-aedf-cb8e0dc8f49e`。
- 改动：接收文件点 ✓ 时，若系统「保存位置」对话框没出现，卡片给出**「直接下载」**兜底
  —— 文件收进浏览器 OPFS，收完走一次普通浏览器下载（不依赖系统对话框）。
- 只上传 4 个 JS（`js/bus.js`、`js/ui/filetransfer.js`、`js/ui/timeline.js`、`main.js`）。
  **wasm 未重新构建、未上传**，线上哈希 `c3bc6996…` 与发布前一致。

### 关于跳过 wasm 新鲜度自检

`scripts/deploy-web.sh` 的"wasm 不比源码旧"检查本次**未通过**，已核实为误报后放行：

- 比 wasm 新的只有两个文件：
  - `client-wasm/src/jni_api.rs` —— 由 `#[cfg(any(target_os = "android", feature = "jni-bridge"))]`
    门控，wasm 构建不编译；
  - `client-wasm/src/transfer_orchestrator.rs` —— 改动全部落在
    `#[cfg(not(target_arch = "wasm32"))]` 的 `FileSink` 三块里（hunk 行号 142–164 / 180–186 /
    188–214 / 226–273，均在该门控区间内），wasm 构建同样不编译。
- 因此本次部署的 wasm 与线上已运行并验证过的那份**字节相同**。

⚠️ 后续若真的改了 wasm 会编译到的 Rust（`room.rs` / `filetransfer.rs` / 共享路径），
必须先 `bash scripts/build-wasm.sh release` 再发前端，不能套用本次的放行理由。

## 上一次（同一天，第一次）

- 版本 `daeb0004-ca8b-44a3-8492-fcb85fb507d3`。
- 改动：保存对话框的重入保护 + 等待状态如实显示（`File picker already active` 不再出现）。
- 该次包含用当前源码重建的 wasm（当时唯一新于 wasm 的 Rust 也在门控区，重建属主动对齐）。

## 验证

| 项 | 结果 |
|---|---|
| 本地 `file-recipients` | 34/34（含 3 条兜底断言） |
| 本地 `file-history` / `card-revive` / `refresh` | 17/17 / 4/4 / 4/4 |
| 生产 `https://im.pinkstar.cc` `file-recipients` | 34/34 |
| 线上 5 个产物 SHA-256 与本地 | 完全一致 |
| `smoke.mjs` / `biome lint` / `npm test` | 通过 |

`scripts/e2e/image-layout.mjs` 有 1 项失败，但**在纯净版（未含本次改动）上同样失败**，
属既有问题，与本次改动无关。
