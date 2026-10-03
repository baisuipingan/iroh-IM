# iroh 聊天室 · 项目长期记忆

（只放"不看就会踩坑"的操作性内容；设计细节看代码注释与 `docs/` 下的审查报告）

## 部署

**顺序：先升 roomd、再上前端**（反了功能完全不生效）。

**roomd 跑在 Docker 里** —— 主机 `root@189.24.68.147:15601`（key `~/Desktop/ssh/mindcrew/codex`），
目录 `/opt/iroh/roomd`，数据 `/opt/iroh/roomd/data`（**`identity.key` 必须保留**，否则 EndpointId 变、前端配置要改）。
Dockerfile 是 `COPY roomd /usr/local/bin/roomd`（**二进制烧进镜像**）：
```bash
cd /opt/iroh/roomd && install -m 755 <新二进制> ./roomd && docker compose up -d --build
```
EndpointId 现为 `5bcc4ea3bb…`，须与 `frontend/pkg/relay-config.json` 的 `anchor.id` 一致。

**前端**：`bash scripts/build-wasm.sh release`（**必须 release**：dev 产物 25.8 MiB 超 CF 单文件 25 MiB 上限）
→ `bash scripts/deploy-web.sh`。

**协议版本**：当前 **v4**（房间标识进了全部签名载荷）。改签名载荷必须 bump 版本，
并**清历史**（`data/history/*.jsonl`，保留 `identity.key`）+ 两端同时升级。

## ⚠️「改了但没生效」四条排查（本项目最痛，按序查）

1. **容器里是刚编的二进制吗？** `docker cp roomd:/usr/local/bin/roomd /tmp/x && strings /tmp/x | grep <新特征串>`
2. **构建产物旧了吗？** `build-wasm.sh` 的 rsync 会**静默断链后继续构建旧代码**；
   每轮构建后用 `strings` 验一个只在新版存在的字符串，必要时 `touch src/*.rs` 强制重编。
3. **两端协议版本一致吗？** 只 cp 源码不跑 `deploy-web.sh`，`dist/site/pkg` 会停在旧 wasm。
4. **线上真换了吗？** 见下面「校验线上内容」。

## 本地浏览器测试的前置（缺一不可）

1. `python3 scripts/dev-serve.py 8099`（服务 `frontend/`，强制不缓存）
2. Chrome **必须 `--no-sandbox --disable-setuid-sandbox`**（本环境自带沙箱初始化失败会让主进程退出）：
   `--headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-iroh-profile`
3. **用 `run_in_background: true` 启动**这两个进程 —— `nohup … &` 起的进程在本环境
   **回合一结束就被回收**（Chrome 日志出现 `parent died?`）
4. 跑测试要清代理：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy NO_PROXY=127.0.0.1,localhost`

一键跑回归：`bash scripts/e2e/run.sh [用例名]`
**每个用例之前必须清浏览器存储**（`scripts/e2e/clear-storage.py` 已封装）：
用例用固定房名 + 固定身份 key，上轮的 IndexedDB 位图与 localStorage 邀约会让
下一轮"进不了房"或 `done=0`（单独跑过、连跑挂，极易误判成代码 bug）。

## 校验线上内容

本机 curl 线上站点会被沙箱代理做 TLS 中间人（`self signed certificate`，`-k` 也不行）。
**改从构建机 curl 再比哈希**。另外 `curl -o` 失败时**不会清空旧文件**，先 `rm`
（否则把上次残留当成线上内容 —— 误判过一次：8 个文件算出同一个哈希）。
`/index.html` 返回 307 是 Cloudflare 规范化到 `/`，正常。

## 常用命令

```bash
cd client-wasm && export PATH="$HOME/.cargo/bin:$PATH"
cargo test  --offline --locked --no-default-features --features cli   # 单元测试
cargo check --offline --locked --no-default-features --features cli   # 验证 Cargo.lock 同步
bash scripts/security/run.sh    # 安全攻击镜像（attack-verify + attack-stream），必须全绿
```

## 关键设计约束（改动前必看）

- 软状态（心跳 + 超时派生）是唯一事实来源；事件只加速，不决定事实
- 历史落盘文件名 = `blake3(room)`，**原始房间名存 jsonl 首行**（`RoomHeader` 自校验）；
  加载只认文件头，**绝不从文件名反推**
- 文件流授权：`Pending` 记 `expect_sender`，入站须 `remote_id()` 匹配 + header 逐项一致 +
  块序号/长度合法。**`file_id` 是公开广播的，不是授权凭据**
- 接收内容校验在 `JsChunkSink`（增量 BLAKE3）；原生 `BytesSink` 那条路**生产不走**
- `HistoryStore::append` **自己兜底验签**（不信任调用方）
- 拒绝文件流走 `deny()`：写回执 → finish → **等对端读完**再返回（否则对端只见 connection lost）
- 前端 `syncAvailableFiles()` 只广播**当前房间**的文件（防跨房间 file_id 泄露）
- roomd 启动只订阅 `ROOMD_ROOMS`（默认 lobby），其余房间在**第一次有人拉历史时**才异步订阅
  —— 测试要等它订阅上再发消息（主测试里已加探针）

## 环境注意

- **Bash 的 `grep` 多模式 `a\|b` 在本机不可靠**（静默返回空，误判"文件里没有"）；用 `grep -E` 或专用工具
- cargo 需 `export PATH="$HOME/.cargo/bin:$PATH"`；tuna 镜像已失效（403），已切 rsproxy.cn
- 访问本机端口要清代理（同上）
