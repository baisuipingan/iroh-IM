# 部署与变更

> 这份文档是**唯一权威**的上线流程。`deploy/roomd/README.md` 讲 roomd 的细节，
> `deploy/relay/README.md` 讲中继，`scripts/e2e/README.md` 讲本地回归。
> 本文只讲"**改了代码之后，怎么把它安全地弄上线**"。
>
> 里面每条注意事项都是**踩过坑之后写进去的**，不是预想的风险。

---

## 0. 一句话版本

```bash
# 1) 改完代码，先本地验证
cd client-wasm && cargo test --offline --locked --no-default-features --features cli
cd .. && bash scripts/security/run.sh          # 安全攻击回归
bash scripts/e2e/run.sh                        # 浏览器回归（前置见 scripts/e2e/README.md）

# 2) 判断要重建什么（见 §2 的表）

# 3) 先升 roomd、再上前端（顺序不能反）
bash scripts/build-wasm.sh native              # → dist/roomd
#   （按 deploy/roomd/README.md 上传 + docker compose up -d --build + 验证容器内二进制）

bash scripts/build-wasm.sh release             # → frontend/pkg（必须 release，见 §2）
bash scripts/deploy-web.sh                     # → dist/site + 发布到 im.editor.vip

# 4) 验证线上（见 §6）
```

---

## 1. 两条部署线

| | roomd（常驻节点） | 前端（浏览器站点） |
|---|---|---|
| 跑在哪 | 服务器 Docker：`root@189.24.68.147:15601`（key `~/Desktop/ssh/mindcrew/codex`），目录 `/opt/iroh/roomd` | Cloudflare Worker，自定义域名 `https://im.editor.vip` |
| 构建 | `bash scripts/build-wasm.sh native` → `dist/roomd` | `bash scripts/build-wasm.sh release` → `frontend/pkg`，再 `bash scripts/deploy-web.sh` |
| 数据 | `/opt/iroh/roomd/data`（`identity.key` + `history/`） | 无（状态在浏览器 localStorage / IndexedDB） |
| 细节文档 | `deploy/roomd/README.md` | `scripts/deploy-web.sh` 头部注释 |

**顺序不能反。** 协议或接口有变时，先升 roomd 再上前端；反了会出现"新前端连旧节点"，
表现为功能完全不生效或连接超时。

---

## 2. 改了什么 → 要重建什么

| 改动的文件 | wasm | roomd | 前端 | 备注 |
|---|---|---|---|---|
| `frontend/**`（js / css / html） | — | — | ✅ | 只需 `deploy-web.sh` |
| `client-wasm/src/**`（room.rs / filetransfer.rs / wasm_api.rs…） | ✅ | ✅ | ✅ | 两份产物都要重建 |
| `client-wasm/src/bin/roomd.rs` | — | ✅ | — | |
| `frontend/relay-config.json` | — | — | ✅ | 改 `anchor.id` 时要与 roomd 实际 EndpointId 一致 |
| `client-wasm/Cargo.toml` / `Cargo.lock` | ✅ | ✅ | ✅ | |

### ⚠️ wasm **必须** release 构建

Cloudflare Workers 单个静态资源上限 **25 MiB**。dev 构建的 wasm 是 **25.8 MiB** →
`deploy-web.sh` 会在上传阶段报 `Asset too large` 直接失败；release 构建是 **3.8 MiB**。

```bash
bash scripts/build-wasm.sh release     # 不是默认的 dev
```

---

## 3. roomd 上线（最容易搞错的一步）

**Dockerfile 是 `COPY roomd /usr/local/bin/roomd` —— 二进制被烧进镜像。**
所以**改宿主机的同名文件 + `docker restart` 完全无效**（重启用的是镜像里那份）。
这一步我排查了十几轮才发现：源码改了、编译成功、`docker logs` 看着也像新行为，
但功能就是不生效。

完整顺序见 `deploy/roomd/README.md`，要点：

```bash
# 0) 本地构建并确认产物里真有新代码
bash scripts/build-wasm.sh native
strings dist/roomd | grep -c "<刚改过的特征串>"     # 0 = 构建没生效，别往下走

# 1) 备份当前容器里的二进制（回滚要用）
ssh root@<host> 'cd /opt/iroh/roomd && docker cp roomd:/usr/local/bin/roomd ./roomd.bak-$(date +%Y%m%d-%H%M%S)'

# 2) 换二进制 + 重建镜像
scp deploy/roomd/{Dockerfile,docker-compose.yml} dist/roomd root@<host>:/opt/iroh/roomd/
ssh root@<host> 'cd /opt/iroh/roomd && docker compose up -d --build'

# 3) ★ 验证容器里跑的**确实是这一份**（必做，别猜）
ssh root@<host> 'docker cp roomd:/usr/local/bin/roomd /tmp/x \
  && sha256sum /tmp/x \
  && strings /tmp/x | grep -c "<特征串>"'

# 4) EndpointId 必须没变，且与前端配置一致
ssh root@<host> 'docker compose -f /opt/iroh/roomd/docker-compose.yml logs | grep ROOMD_ENDPOINT_ID'
grep '"id"' frontend/pkg/relay-config.json      # anchor.id 应完全相同
```

当前 EndpointId：`5bcc4ea3bb56f17041390a9f171bb03a16f107f95ecb93097f80a985845aaab6`

> **只要 `data/identity.key` 还在，EndpointId 就不会变**，前端配置不用动。
> 丢了它 = 换了身份，所有人都得重新认你。

---

## 3b. 中继名单（`enabled` 改了会怎样）—— 实测结论

`frontend/relay-config.json` 里每台中继有 `enabled` 开关（`net.js` 在 boot 前过滤）。
**不要随手裁这个名单。** 实测（2026-10-04）：

| 客户端名单 | 结果 |
|---|---|
| `hk-1 + eu-1 + fr-1`（默认） | ✅ 进房成功 |
| 只有 `hk-1` | ✅ 进房成功 |
| 只有 `eu-1` | ❌ **95s 进不去房** |
| 只有 `fr-1` | ❌ **100s 进不去房** |
| `eu-1 + fr-1`（无 `hk-1`） | ❌ **95s 进不去房** |
| `eu-1 + fr-1 + hk-1` | ✅ 进房成功 |

**结论：名单里必须包含「常驻节点当前所在的中继」**（现在是 `hk-1`，
因为 `anchor.relay` 指向它、roomd 也挂在它上面）。
缺了它 → 客户端够不到锚点 → 拿不到 bootstrap → 一直在 `subscribe_and_join`
重试（4×20s）直到失败，**表面上只是"进不了房"，没有任何明确报错**。

反过来，**两个普通用户用不同中继没有任何影响**（实测）：
A 落在 `eu-1`、B 落在 `fr-1`，即使**双方的名单里都没有对方所在的中继**，
仍能互通（3s 内互相看见，双向消息各 1.5s 送达）。
iroh 会按最近 5 分钟延迟自动选 home relay，所以"不同人落在不同中继"是**常态**，不是异常。

> 所以：**默认的三台全放行就是最稳的配置**。真要裁，只裁掉你确定没人在用的，
> 并且**永远保留 `anchor.relay` 指向的那台**。

⚠️ 注意 iroh 的选路有随机性：同一份配置、同一台机器，实测会分别落到 `eu-1` / `hk-1` / `fr-1`
（按当时的延迟测量结果）。所以"谁在哪台"不固定，同一个人刷新后也可能换台 —— 排查时别假设。

## 4. 协议版本变更（破坏性，慎重）

签名载荷带协议版本（`v4` / `p4` / `l4` / `q3` / `f3` …）。**改签名载荷 = bump 版本**，
这会同时废掉新旧两端，必须做三件事：

1. roomd 与前端**同时**升级
2. **清掉旧历史**（旧 `.jsonl` 在新代码下验不过，加载时会被当作无效记录丢弃）：
   ```bash
   ssh root@<host> 'mv /opt/iroh/roomd/data/history /opt/iroh/roomd/data/history-v<旧版本>-$(date +%Y%m%d-%H%M%S)'
   # 轮换而不是删除 —— 万一要回滚还能拿回来
   ```
   **`identity.key` 绝对不能动。**
3. 第 1、2 步之间有一个"混跑窗口"：先升级的那一侧发出的消息会被另一侧静默丢弃。
   自建小规模场景通常可接受；要完全避免就挑没人用的时候做。

**只在 `canonical()` 里加了字段、没 bump 版本**，是最危险的情况 ——
两端都认为自己是对的，但签名对不上，表现为大面积"签名无效，丢弃"。

---

## 5. ⚠️「改了但没生效」四条排查

**看到"行为完全没变"时，按顺序查这四条，再怀疑逻辑。**
这四条覆盖了我遇到过（或差点遇到）的全部"假失败"。

1. **容器里是刚编的二进制吗？**
   `docker cp roomd:/usr/local/bin/roomd /tmp/x && strings /tmp/x | grep <特征串>`
   （`COPY` 进镜像的东西不受宿主机文件影响，见 §3）
2. **构建产物旧了吗？**
   `build-wasm.sh` 里的 rsync **可能因网络中断而静默失败、然后继续构建旧代码**。
   每轮构建后用 `strings <产物> | grep <只在新版存在的串>` 确认；
   必要时在构建机上 `touch src/*.rs` 强制作废缓存。
   > 沙箱网络下这个 rsync 断过好几次。稳妥做法：先 `sha256sum` 对比两端源码，
   > 不一致就单独重传，再手工 `cargo build`。
3. **两端产物版本一致吗？**
   只 `cp` 源码不跑 `deploy-web.sh`，`dist/site/pkg` 会停在旧 wasm
   → 新旧协议混跑 → roomd 报「签名无效，丢弃」。
4. **线上真的换了吗？** 见 §6 —— 而且**不要用本机 curl 判断**。

---

## 6. 验证上线结果

### 本机 curl 线上站点会被沙箱代理做 TLS 中间人

报 `SSL certificate problem: self signed certificate`，连 `-k` 都过不去。
**改从构建机上 curl 再比 sha256**：

```bash
for f in js/net.js js/ui/sidebar.js css/components.css pkg/iroh_web_bg.wasm; do
  printf "%s  %s\n" "$(shasum -a 256 dist/site/$f | cut -d' ' -f1)" "$f"
done > /tmp/local.txt
ssh root@<host> "for f in <同样的列表>; do h=\$(curl -s https://im.editor.vip/\$f | sha256sum | cut -d' ' -f1); echo \"\$h  \$f\"; done" > /tmp/remote.txt
# 逐行比对
```

两个容易误判的点：
- **`curl -o <file>` 失败时不会清空旧文件** → 先 `rm`，否则会把上次的残留当成线上内容
  （踩过：8 个文件算出同一个哈希）。
- **`/index.html` 返回 307** 是 Cloudflare 规范化到 `/`，正常；根路径 `/` 才是 200。

### 端到端

```bash
bash scripts/e2e/run.sh                 # 本地（前置见 scripts/e2e/README.md）
E2E_SITE=https://im.editor.vip <某个用例>  # 直接打线上（静态资源一致时等价）
```

---

## 7. 回滚

| 对象 | 做法 |
|---|---|
| roomd | 用 §3 步骤 1 备份的二进制：`install -m 755 roomd.bak-<ts> ./roomd && docker compose up -d --build`，再按步骤 3 验证 |
| 前端 | `git revert <commit>`（或 `git checkout <上一个提交> -- frontend/`）再 `bash scripts/deploy-web.sh`。**`dist/site` 是从 `frontend/` 生成的，不要手改它** |
| 历史 | §4 里轮换出去的 `history-v<版本>-<时间戳>` 目录换回来即可（前提是协议版本也回滚了） |

---

## 8. 本机开发/测试环境

本地回归需要三样东西，缺一不可（详见 `scripts/e2e/README.md`）：

1. `python3 scripts/dev-serve.py 8099`（服务 `frontend/`，强制不缓存）
2. Chrome **必须 `--no-sandbox --disable-setuid-sandbox`**（本环境下其自带沙箱初始化失败会让主进程退出）
3. 两个进程都要用**后台任务**方式启动（`nohup … &` 起的进程回合一结束就被回收）
4. 跑测试要清代理：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy NO_PROXY=127.0.0.1,localhost`

**每个用例之前清一次浏览器存储**（`scripts/e2e/clear-storage.py` 已封装），
且**房名要唯一** —— 两者不清都会污染下一轮，表现为"进不了房"或 `done=0`。

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| `deploy/roomd/README.md` | roomd 的部署细节、环境变量、容量上限、历史访问边界 |
| `deploy/relay/README.md`、`docs/relay-deploy-minimal.md` | 中继部署 |
| `deploy/install/README.md` | 中继一键安装脚本的分发方式 |
| `scripts/e2e/README.md` | 浏览器回归：用例清单 + 前置 + 已知坑 |
| `scripts/security/README.md` | 安全攻击回归（用原始攻击脚本验证修复） |
| `docs/project-review-2026-10-03*.md` | 两轮安全审查与修复记录（含设计约束的来由） |
| `docs/iroh-chatroom-feasibility.md` | 最初的可行性分析 |
