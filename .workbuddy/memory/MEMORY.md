# iroh 聊天室 · 项目长期记忆

## 部署（务必先看）

**顺序：先升 roomd、再上前端**（反了功能完全不生效）。

**roomd 跑在 Docker 里** —— 主机 `root@189.24.68.147:15601`，
目录 `/opt/iroh/roomd`，数据 `/opt/iroh/roomd/data`（`identity.key` 必须保留）。
Dockerfile 是 `COPY roomd /usr/local/bin/roomd`（**二进制烧进镜像**），所以：
```bash
cd /opt/iroh/roomd && install -m 755 <新二进制> ./roomd && docker compose up -d --build
```
EndpointId 现为 `5bcc4ea3bb…`，与 `frontend/pkg/relay-config.json` 的 `anchor.id` 一致。

**前端**：`build-wasm.sh release`（必须 release，dev 的 25.8 MiB 超 CF 25 MiB 上限）→ `deploy-web.sh`。

## ⚠️「改了但没生效」四条排查（本项目最痛，按序查）

1. **容器里是刚编的二进制吗？**
   `docker cp roomd:/usr/local/bin/roomd /tmp/x && strings /tmp/x | grep iroh-room-v1`
2. **构建产物旧了吗？** `build-wasm.sh` 的 rsync 会**静默断链后继续构建旧代码**；
   每轮构建后 `strings dist/relay-probe | grep iroh-room-v1` 必须为 1，
   否则 `touch src/*.rs` 强制重编。
3. **两端协议版本一致吗？** 只 cp 源码不跑 `deploy-web.sh`，`dist/site/pkg` 会停在旧 wasm
   → roomd 报「签名无效，丢弃」。
4. **线上真换了吗？** 发布后拉回线上文件比 sha256。

## 架构要点

- 房间 = gossip topic（topic id = 房间名 blake3）
- **软状态是唯一事实来源**：心跳 10s / TTL 35s；文件清单心跳 3s 且仅在持有文件时发
- 离开声明只在"主动切房间"时可靠发出；刷新/崩溃走心跳超时兜底（25~45s）
- 历史落盘：文件名 `blake3(room)`，**原始房间名存 jsonl 首行**（`RoomHeader` 自校验）；
  加载只认文件头，**绝不从文件名反推**（旧的 `sanitize` 会让 `研发群`/`产品群` 互撞）
- 签名载荷：`sigfmt.rs` 长度前缀编码（无歧义），协议 v3；`ChatMessage.id` 由载荷派生且参与签名
  —— 改这两处必须升版本号并清旧历史
- 文件流授权：接收侧 `Pending` 记 `expect_sender`，入站须 `remote_id()` 匹配 +
  header 逐项一致 + 块序号/长度合法。**file_id 是公开广播的，不是授权凭据**
- 接收内容校验在 `JsChunkSink`（增量 BLAKE3）。原生 `BytesSink` 的校验**生产不走**
- `HistoryStore::append` **自己兜底验签**（不信任调用方），返回 bool
- 拒绝文件流走 `deny()`：写回执 → finish → **等对端读完**再返回（否则对端只见 connection lost）

## 常用命令

```bash
cd client-wasm && export PATH="$HOME/.cargo/bin:$PATH"
cargo test --offline --no-default-features --features cli   # 37 个单元测试
cargo check --locked --no-default-features --features cli   # 验证 Cargo.lock 同步
bash scripts/security/run.sh    # 安全回归：attack-verify 17/17 + attack-stream 1/1
```

## 跑回归的正确姿势

**每个测试前清一次浏览器存储**（`/tmp/clear-storage.py` 已封装）：
`indexedDB.deleteDatabase('iroh-transfers')` + `localStorage.clear()`。
测试用固定房名/身份 key，不清就互污（`stale`/`refresh` 必挂，表现进不了房或 `done=0`）。
测试脚本在 `/tmp`：`file-history-test.py`（主）/ `review-frontend` / `dm-removed` /
`stale` / `offline-room` / `refresh` / `bu-e2e2.sh`（线上）。

## 环境注意

- **Bash 的 `grep` 多模式 `a\|b` 在本机不可靠**（静默返回空，误判"文件里没有"）；
  用 `grep -E` 或专用工具
- 访问本机端口要清代理：`env -u HTTP_PROXY -u HTTPS_PROXY ... curl`
- cargo 需 `export PATH="$HOME/.cargo/bin:$PATH"`；tuna 镜像已失效（403），已切 rsproxy.cn
- roomd 启动只订阅 `ROOMD_ROOMS`（默认 lobby），**其余房间在第一次有人拉历史时才异步订阅**
  —— 测试要等它订阅上再发消息，否则消息进不了历史
