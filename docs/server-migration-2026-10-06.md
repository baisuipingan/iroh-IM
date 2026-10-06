# 香港服务器迁移清点（2026-10-06）

> 老服务器 `189.24.68.147:15601` → 新服务器 `189.24.70.253:22`
> DNS 已切：`iroh1.editor.vip` → `189.24.70.253`（eu-1/fr-1 不受影响）
> **最终状态：中继与 `roomd` 均已迁至新服务器，旧 `roomd` 已停止，身份与历史数据库校验通过，见 §4。**
> 2026-10-06 独立复核：运行服务正常，但构建工具链未迁移；未来发版目标为新机，发布前待办见 [`project-review-2026-10-06.md`](project-review-2026-10-06.md)。

---

## 1. 一台服务器上其实有两个东西

先分清，否则会漏搬：

| 角色 | 在哪 | 说明 |
|---|---|---|
| **iroh-relay**（hk-1） | 老：`/opt/iroh/relay`（Docker compose 项目 `relay`）| 对外的中继，监听 **15443/TCP**，TLS 由它自己终结 |
| **roomd**（常驻节点 / 锚点） | 老：`/opt/iroh/roomd`（Docker compose 项目 `roomd`）| **不监听任何端口**，作为客户端连中继；保存各房间的文本历史 |

最初只切换了 `iroh1.editor.vip` 并迁移中继；随后 `roomd` 也已迁移（见 §4），此处描述最初排查状态。

---

## 2. 新服务器上「已经有的」（你搬过去的，我核对过，都是对的）

`/opt/iroh/relay/` 下与老服务器**逐字节一致**（只有 `access` 一行不同，见 §3.3）：

```
docker-compose.yml    relay.toml    .env
renew.sh              cert-sync.sh  certs/default.crt|key
```

- 容器：`iroh-relay`，镜像 `n0computer/iroh-relay:v1.3.0`（与老的一致）
- 挂载：`relay.toml` + `certs/`（与老的一致）
- 证书：CN=`iroh1.editor.vip`，**2026-10-06 → 2027-01-04**（今天新签的）
- 续期链完整：`/root/.acme.sh/iroh1.editor.vip_ecc` + `/root/.iroh-relay-cf-token`（Cloudflare DNS 令牌）
  + 两条 crontab（acme 全局 cron、`renew.sh` 每 6 小时）

---

## 3. 我这次补上的三个缺口

### 3.1 ★★ 防火墙没放行 15443 —— 这是当时**整个应用不可用**的原因

`1Panel` 在今天 17:10 左右启动并接管了 iptables，`INPUT` 策略变成 **DROP**，
白名单里只有 `80 / 443 / 22 / 17054`，**唯独没有 15443**。

表现（当时的现象，供以后对照）：

| 现象 | 解释 |
|---|---|
| 从服务器**本机** `curl https://127.0.0.1:15443/` → **200，0.03 秒** | loopback 不走 INPUT 策略 |
| 从**外部** curl → **全部超时** | 外部包被 DROP（当时已丢 1098 个包） |
| 浏览器 `phase=online`（中继连上了）但**永远进不了房**，约 30 秒后"连接中断" | 中继日志 `Connection did not reach established state within timeout` |
| 中继日志里出现 `peer=<客户端IP>` 的 timeout | 能定位到具体客户端 |

**已修**：`ufw allow 15443/tcp`

> ⚠️ **但这条是我用命令行加的，1Panel 面板里看不到。**
> 建议你在 **1Panel → 防火墙** 里也加一条 `15443/tcp`，让它成为"面板管理的规则"，
> 否则以后在面板里做批量操作（比如切防火墙开关）可能把它冲掉，应用会再次不可达。
> 老服务器上这条是有的（老 ufw 里 `15443/tcp ALLOW IN Anywhere`）。

### 3.2 ★ 昨天的 BBR 吞吐修复没搬

没有 `/usr/local/sbin/iroh-relay-tcp-bbr`，也没有 `relay-tcp-bbr.service`，
拥塞算法是 `cubic`、策略路由 0 条。

**后果**：大批量文件传输会退回 **36~38 KiB/s**（2 MiB 要 53~57 秒），
也就是昨天刚修好的那个问题会原样复发。

**已装**（源文件就是仓库里的 `scripts/relay-tcp-bbr.sh` + `deploy/relay-tcp-bbr.service`）：

```
enabled=enabled active=active
15442:  from all ipproto tcp sport 15443 lookup main suppress_prefixlength 0
15443:  from all ipproto tcp sport 15443 lookup 15443
table 15443: default via 189.24.70.254 dev ens17 proto static congctl bbr
```

### 3.3 ★ 中继的访问控制丢了

| | 配置 |
|---|---|
| 老服务器 | `access.shared_token = ["44d51ffb…"]`（要求令牌） |
| 新服务器（原样） | `access = "everyone"`（**对所有人开放**） |

对所有人开放 = 任何知道这个 URL 的人都能白用你的中继带宽。
（前端 `relay-config.json` 的 `relay_token` 和 roomd 的 `ROOMD_RELAY_TOKEN` 都还是好的，
只是中继端不校验，等于没锁。）

**已改回** `access.shared_token = [...]`，并重建容器（容器内配置已确认生效）。

> 踩到一个坑记在这里：**改 bind-mount 的文件后必须重建容器**。
> `sed -i` 会换 inode，而容器的 bind mount 是**启动时**按路径解析的，
> 之后一直指着旧 inode —— 我第一次只跑了 `docker compose up -d`（它判定"无需变更"），
> 容器里读到的还是旧配置。要用 `docker compose up -d --force-recreate`。

---

## 4. roomd 也已搬迁完成（2026-10-06 17:2x）

`189.24.68.147` 确认是要到期的机器，所以 roomd 一并搬了。

### 4.1 为什么"先停老 roomd"再拷

`data/history/history.db` 是 **SQLite + WAL** 模式。**边跑边拷很可能拷到不一致的库。**
所以顺序是：先 `docker compose stop roomd`，确认停了，再打包。
（顺带一句：用户说历史丢了也无所谓 —— 反正没上线。但停一下几乎零成本，就没省这一步。）

### 4.2 搬了什么

```
/opt/iroh/roomd/
  .env                  Dockerfile      docker-compose.yml
  roomd                 ← 二进制，8,371,008 字节（与老机器一致）
  data/identity.key     ← ★ 64 字节，绝不能丢
  data/history/         ← history.db + WAL/SHM（迁移过来的历史）
```

**没搬**（都是备份/历史版本，非运行必需，一共约 60 MB）：
`backups/`、`releases/`、`review-stage-20261004/`、`data.bak-*`、
`history-old-*`、`history-v3-*`、`roomd.bak-*`。

### 4.3 ★ 校验：EndpointId **没变**

```
ROOMD_ENDPOINT_ID=5bcc4ea3bb56f17041390a9f171bb03a16f107f95ecb93097f80a985845aaab6
```

与迁移前完全一致 ⇒ **`frontend/relay-config.json` 的 `anchor.id` 不用改**，
线上前端一个字都不用动。

### 4.4 ⚠️ 老 roomd 必须保持停止

老机器上那个 `roomd` 容器现在是 `Exited (137)`。
**不要把它再起来** —— 两个同身份（同一个 `identity.key`）的锚点同时在跑，
会同时对同一个房间写历史，行为不可预期。

### 4.5 小事

- `/opt/iroh/relay/backups/` 没搬（老的备份目录，非运行必需）
- 老服务器上的中继**还在跑**（DNS 已指到新机器，所以它是"空转"的）。
  确认新机器稳定几天后可以停掉：`cd /opt/iroh/relay && docker compose down`。

> ⚠️ 提醒：老服务器上除了本项目，还跑着**一大堆别的东西** ——
> `mindcrew-*`（backend/frontend/mysql/redis/minio/milvus/etcd）、`WeKnora-*`（postgres/redis/docreader/minio）、
> `1Panel-openresty`。那台机器到期前，**这些也都得搬**，而且是另一摊工作。

### 4.6 `get.editor.vip`（安装脚本）**不用搬**

那个 `bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"` 里的域名
解析到 **Cloudflare**（172.67.169.180 / 104.21.39.60），**不在老服务器上**。
所以它跟这次迁移无关。

---

## 5. 我验证过的（不是"应该没问题"，是实测）

| 检查 | 结果 |
|---|---|
| 外部 `curl https://iroh1.editor.vip:15443/` | ✅ 200，约 0.11-0.13 秒（连续多次） |
| 从新服务器本机访问自己的 15443 | ✅ 200，0.03 秒 |
| **线上端到端**：`https://im.pinkstar.cc` 自动进房 | ✅ 18 秒内 `joined` |
| 端到端发消息 | ✅ 发出成功 |
| 浏览器 console | ✅ **0 报错** |
| 容器内 `relay.toml` | ✅ `access.shared_token = [...]`（与老服务器一致） |
| 宿主机 vs 容器内证书 sha256 | ✅ 一致 |
| BBR 策略路由 | ✅ 两条规则 + `congctl bbr` |

**顺带排除一个我本来怀疑的坑**：`cert-sync.sh` 用 `install` 写证书，我以为会换 inode
导致容器里永远是旧证书（那样续期就白做了）。实测**原地覆盖，inode 不变**（774166 → 774166），
所以没有这个问题。

---

## 6. 两条安全建议

1. **你把 root 密码发在对话里了，而且这台新机器现在允许 root 密码登录。**
   建议改成密钥登录并关掉密码认证（`sshd_config` 里 `PasswordAuthentication no`）。
   要的话我可以帮你做：生成密钥 → 装到新机器 → 验证密钥能登 → 再关密码 → 最后你去改密码。
2. 新服务器上 `ufw` 是 active 但 1Panel 在管，**规则要统一在 1Panel 面板里维护**，
   别两边各加一半 —— 这次的故障就是"面板接管时把别人加的端口漏掉了"。


---

## 7. 关于那个一键安装脚本（`get.editor.vip/iroh/install.sh`）

用户问："我在用 `bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"`，
好像没提示 token 这件事呀？"

**脚本里其实是有这段逻辑的**，只是要**你主动传环境变量**才会触发：

```sh
# 访问控制：给了 RELAY_TOKEN 就用共享 token，否则 everyone（不推荐）
if [ -n "${RELAY_TOKEN:-}" ]; then
  ACCESS_LINE="access.shared_token = [\"$RELAY_TOKEN\"]"
  ok "已启用共享 token 鉴权"
else
  ACCESS_LINE='access = "everyone"'
  wa "未设置 RELAY_TOKEN：中继对所有人开放（谁拿到 URL 都能用）"
fi
```

也就是说：

- **不传 `RELAY_TOKEN`** → 生成 `access = "everyone"`（对所有人开放），
  只在日志里打一条 warning 就继续装了 —— 很容易被忽略。
  **这就是新服务器上最初那份配置的来源。**
- **想启用 token** → 要这么跑：

```sh
RELAY_TOKEN='44d51ffb6ddab961c6c8cdfe802e0752e0dee3b5cb486916' \
  bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"
```

### ⚠️ 这个脚本还有两个盲区（这次都踩到了）

| 盲区 | 后果 | 现状 |
|---|---|---|
| **完全不管 BBR**（`grep -c bbr` = 0） | 大文件传输退回 36~38 KiB/s | 已单独装 `relay-tcp-bbr` 服务 |
| 只在 **`ufw status` 已经是 active** 时才 `ufw allow 15443` | 若装的时候 ufw 还没启用，就**不会放行** | 已补规则；但**建议同时在 1Panel 面板里加** |

> 建议（可选）：在 `install.sh` 里加一个 `BBR=1` 开关（装完后调用仓库里的
> `scripts/relay-tcp-bbr.sh`），并把 ufw 那段的判断改成
> "无论 ufw 当前是否 active 都先 `ufw allow`"。
> 这样下次换机器就不会再漏这两样。
