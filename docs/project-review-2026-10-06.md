# 项目改动与服务器迁移独立 Review（2026-10-06）

> 本文记录 10 月 6 日审查时的状态，不是当前故障列表。10 月 7 日修复与验证证据见
> [`production-hardening-2026-10-07.md`](production-hardening-2026-10-07.md)：私钥权限/续期、工具链、测试配置隔离、草稿自适应、日志轮转和每日一致性备份均已处理。最终整套回归与提交门槛仍以该工作记录为准。

## 范围与结论

- 检查当前未提交的前端重构、测试和部署流程；未覆盖或提交他人的修改。
- 只读核查新服务器 `root@<SERVER_IP>:22` 与旧服务器的 roomd 状态。
- 新机运行服务、身份与数据库迁移正常；不等于已具备构建、备份与安全运维能力。
- 本轮没有部署、重启容器、修改线上权限或网络策略。
- 本轮只修改本地构建目标、构建工具预检及部署/迁移文档。
- 当前线上前端不是本地最新重构版本：`main.js`、`js/ui/sidebar.js` 哈希不同，线上没有本地新增的 `js/test-hooks.js` 和 `js/ui/sidebar/settings.js`。这些缺失对旧版线上不是运行故障，但不能把本地回归当成新版已上线验证。

## 确认的问题（按优先级）

### P1：宿主机上的身份私钥和 TLS 私钥可被其他本地用户读取

新机以下文件均为 root 所有、权限 `0644`，相关父目录允许遍历：

- `/opt/iroh/roomd/data/identity.key`
- `/opt/iroh/roomd/.env`
- `/opt/iroh/relay/relay.toml`
- `/opt/iroh/relay/certs/default.key`

其中身份私钥可用于冒充常驻锚点；TLS 私钥泄漏同样需要处理。新机的 `cert-sync.sh` 明确使用 `install -m 644` 写私钥，只执行一次 chmod 会在下次续期同步时被改回来。

建议先确认容器运行 UID 和挂载需求，再将私钥/凭据设为 `0600` 或仅必要服务组可读；同步修正续期脚本，保留公开证书的可读权限。存在不可信本地用户时，还需评估是否应轮换已经暴露的私钥。

### P2：构建工具链未迁移，原脚本默认仍写旧服务器

核查时新机没有 `/opt/iroh-build/cargo/bin/cargo`、`rustc`、`wasm-pack`，也没有原构建目录的 Rustup 工具链；PATH 中未找到这些工具或 clang。

原 `scripts/build-wasm.sh:20` 默认 `root@<OLD_SERVER_IP>:15601`，继续使用会把构建写到旧机。已将默认目标改为新机 22 端口，并在同步源码前检查主要工具；实跑 `bash scripts/build-wasm.sh native` 如预期因缺 cargo 退出，没有上传源码或构建。

发布 Rust/roomd/WASM 前，需要迁移或安装工具链、WASM 目标和原生编译依赖，并完成锁定依赖的构建验证。只改前端时，Cloudflare 发布不依赖这套远端构建，但仍应先确认前端和现有 WASM 接口匹配。

### P2：中继配置测试会改变用户原本的启用偏好

`scripts/e2e/relay-enabled.py:39` 的恢复逻辑强制所有中继 `enabled=true`，而不是恢复 `ORIGINAL`。用户故意关闭某个故障中继后，运行回归也会将它打开，随后发布将携带错误配置。

建议用独立浏览器 context 拦截配置请求或临时服务目录隔离测试；必须写真实文件时应原样恢复，并单独检查初始条件。用“全开”来修复上次中断，不能区分测试遗留和真实用户意图。

本轮开始时全部为 true，结束后已确认配置与开始一致；此缺陷没有破坏本轮配置。

### P2：缩窄窗口后长草稿被截断

Chrome 与 WebKit 均实际复现：1440px 窗口填入长草稿，再缩到 720px；输入框宽度从 1058px 降到 610px，内容需要高度从 80px 增到 132px，但输入框保持 80px、`overflow-y:hidden`。再输入一个字符才恢复到 132px。

`frontend/js/ui/composer.js:556` 的测高函数只在输入或部分业务动作时调用，没有覆盖布局宽度变化。不是草稿丢失，但用户会看不到部分草稿，横竖屏切换也有同类风险。

建议观察实际输入区域宽度（ResizeObserver），宽度变化时重测；避免高度写入产生自触发循环，并回归贴底与用户上翻不被拉回的逻辑。

复现截图位于 `output/playwright/review-20261006/composer-resize-{chrome,webkit}.png`。

### P2：Docker 日志没有轮转，且未发现当前数据的自动备份

roomd 与 relay 的 Docker 日志均为 `json-file`，`Config={}`，没有 `max-size` / `max-file`。roomd 的环境仍启用 iroh debug，核查时约 6 小时日志已达 96 MiB。持续增长会占满磁盘，影响 SQLite 写入和其他服务。

未发现当前 SQLite 历史与 identity 的自动备份任务；已迁入的旧 JSONL 备份不能替代当前数据库备份。

建议设置日志限额并将长期运行日志恢复为适量级别；用 SQLite backup API 做一致性备份，包含 identity、配置、保留策略和异机副本，实际做一次恢复验证。不要在运行中只复制 `.db` 而忽略 WAL。

## 迁移核查通过项

- DNS `iroh1.editor.vip` 已指向新机；中继 HTTP `/ping` 返回 200。
- roomd、iroh-relay 容器运行，重启策略为 unless-stopped。
- 宿主与容器内 roomd 二进制哈希一致；迁移前后 identity 文件哈希一致。
- EndpointId 保持 `5bcc4ea3bb56f17041390a9f171bb03a16f107f95ecb93097f80a985845aaab6`，前端 anchor 无需换。
- 旧机 roomd 已停止，未发现同身份双实例运行。
- SQLite `quick_check` 返回 `ok`，WAL 模式，核查时约 1987 条消息（后续测试会增加）。
- 中继共享令牌配置存在；容器与宿主证书/配置哈希一致。
- TLS 证书有效至 2027-01-04；acme 与续期 cron 存在。仅确认配置链存在，未强制续签。
- relay 15443 端口的 BBR 策略服务 active/enabled、规则和路由存在；没有将整台服务器全局 TCP 改成 BBR。
- 磁盘约余 97 GiB、内存 available 约 4.3 GiB，未发现当前资源压力。

## 浏览器验证

本地前端使用线上中继/常驻锚点，不是 mock 网络：

- `scripts/e2e/run.sh`：14 个用例，257 项通过、0 失败，涵盖三人同步/晚加入历史、文件接收者状态、断点续传、刷新、离线、房间隔离、界面重构。
- `history-scroll.mjs`：20 项通过；`theme-sync.mjs`：16 项通过。
- `image-layout.mjs`：94 项通过；`redesign-sync.mjs`：4 项通过，覆盖 Chrome 与 WebKit。
- 冒烟、模块引用检查、改动 whitespace 检查通过；冒烟只检 JS 初始化，不替代实际连接测试。
- 生产站点独立三浏览器存储实际通过：互发、第三人晚加入历史、第三人发送同步到另外两端、刷新保留历史；在线界面显示 3 人。

默认候选中继的 OPFS 真实落盘逐字节校验基准：

| 文件 | 总时长 | 吞吐 |
|---|---:|---:|
| 512 KiB | 2.743 s | 186.7 KiB/s |
| 2 MiB | 7.294 s | 280.8 KiB/s |
| 8 MiB | 25.537 s | 320.8 KiB/s |

这是当前一次测量，不是 SLA；默认候选可能选到其他中继，不能单凭此表证明新 hk-1 的吞吐。强制仅 hk-1 的补测结果单独保存在 `output/playwright/review-20261006/bench-hk/`。

日志、截图、吞吐结果均位于 `output/playwright/review-20261006/`。

## 后续发版与运维建议

1. 后续服务器端发布统一使用 `<SERVER_IP>:22`，SSH key 已实测可登录，无需使用聊天中提供的密码。
2. 先处理凭据权限、工具链、日志/备份，再发布涉及服务端的新代码；前端发布前修复两项已复现问题。
3. root 密码认证仍开启；建议轮换已经在聊天中提供的密码，并在确认保留可用密钥和救援通道后关闭密码登录。未自行修改 sshd。
4. 15443/TCP 当前已放行，但规则注释与 1Panel 管理规则不同；应确保面板批量修改不会覆盖它。当前连通，不将潜在覆盖当作已经发生的故障。
5. 迁移记录与 relay README 中的早期服务器清点不是当前部署指令；当前目标以 `docs/deploy.md` 为准。
