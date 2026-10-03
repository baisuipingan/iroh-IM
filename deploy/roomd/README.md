# roomd · 常驻节点（房间锚点）

中继做不到的三件事，靠它：

| 能力 | 为什么中继做不到 |
|---|---|
| **历史消息** | 中继无状态，一转手就忘。roomd 把每个房间的消息落成 `data/history/<房间>.jsonl` |
| **在线状态** | 它自己也在房间里发 presence，别人能看到"常驻节点在线" |
| **房间锚点** | 所有人只要知道它一个地址就能进房；否则纯 gossip 得先有人在线 |

它是**客户端**：不监听端口、不开防火墙、不需要 `network_mode: host`，自己连中继（同机 ~0.1ms）。

## 部署（在香港那台）

```bash
# 0) ★ 先编译出 roomd（本机没有 Linux 工具链，这一步在构建机上做）
#    `native` 模式现在会同时拉回 dist/relay-probe 与 **dist/roomd**。
bash scripts/build-wasm.sh native
#    产物校验（必做）：确认新代码真的进去了，别把旧二进制推上线
strings dist/roomd | grep -c "<刚改过的特征串>"   # 0 就说明构建没生效

# 1) 把二进制和部署件放上去
#    ⚠️ `dist/roomd` 就是上一步的产物。仓库里**不再存放**这份二进制
#       （以前放了一份 9-29 的旧货，而 Dockerfile 是 COPY 进镜像的，
#        `docker compose up -d --build` 会**成功**但跑的是旧锚点 —— 见复检缺陷 F3）。
scp deploy/roomd/{Dockerfile,docker-compose.yml} dist/roomd root@<host>:/opt/iroh/roomd/

# 2) 起容器（Dockerfile 是 COPY roomd 进镜像，所以必须先有这个文件；
#    缺了会**明确报错**，这正是我们要的"响亮失败"而不是静默上线旧代码）
ssh root@<host> 'cd /opt/iroh/roomd && docker compose up -d --build'

# 2b) 验证容器里跑的确实是这一份（必做）
ssh root@<host> 'docker cp roomd:/usr/local/bin/roomd /tmp/x && strings /tmp/x | grep -c "<特征串>"'

# 3) 拿到它的 EndpointId（写进前端 relay-config.json 的 anchor.id）
ssh root@<host> 'docker compose -f /opt/iroh/roomd/docker-compose.yml logs | grep ROOMD_ENDPOINT_ID'
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ROOMD_RELAYS` | iroh1/2/3 | 用哪几台中继（逗号分隔） |
| `ROOMD_ROOMS` | `lobby` | 启动时自动订阅的房间；其它房间在第一次有人请求历史时自动订阅 |
| `ROOMD_NICKNAME` | `常驻节点` | 在房间里显示的名字 |
| `ROOMD_DATA_DIR` | `/data` | 身份 + 历史目录（**必须持久化**，否则 EndpointId 会变） |
| `ROOMD_MAX_ROOMS` | `256` | 同时订阅的房间数上限；到顶按 LRU 淘汰（`ROOMD_ROOMS` 里的房间永不淘汰） |
| `ROOMD_ROOM_IDLE_MS` | `1800000` | 空闲多久退订一个房间（默认 30 分钟） |

### 为什么有房间数上限

房间是**随用随建**的：历史请求里出现一个新房间名，锚点就会去订阅它 ——
而这个请求**不需要任何鉴权**（房间名就是全部凭据）。不设上限的话，
任何人循环报随机房间名就能让锚点无限订阅：topic、任务、内存、磁盘、
以及每房间 15 秒一次的 presence 广播都会无限增长，直到 OOM。
所以订阅这一侧有四道闸：**容量上限 + LRU 淘汰 + 新房间限速（20 突发 / 5 每秒）+ 空闲回收**。

## 身份

`data/identity.key`（hex）是它的身份，**丢了 EndpointId 就变**，前端配置也得跟着改。备份它。

## 消息可信度

所有消息都用作者的 ed25519 私钥签名，接收方用 EndpointId（就是公钥）验签。
gossip 只负责"送到"，转发者无法伪造作者身份；中继看不到内容。
