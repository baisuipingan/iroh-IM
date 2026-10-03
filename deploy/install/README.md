# 一条命令装中继

## 你要的形态

```bash
bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"
```

**只需回答一个问题：域名**（端口默认 15443，回车即可）。其余全自动，最后打印一条可用的中继地址。
卸载：把同一行命令末尾加上 `remove` 即可。

## 托管在哪：GitHub 存源码 + Cloudflare 分发

两个都能做，我建议**两个都用**：GitHub 管版本，Cloudflare 管访问速度和稳定 URL（你自己的域名）。

### 1. 放 GitHub（版本管理）

1. 建一个公开仓库，例如 `iroh-relay-install`
2. 把本目录的 `install.sh` 推上去（内容一个字不改）
3. 得到一个永久地址：
   ```
   https://raw.githubusercontent.com/<你的账号>/iroh-relay-install/main/install.sh
   ```

### 2. 挂 Cloudflare（稳定 URL + 国内更顺）

1. Cloudflare 后台 → Workers & Pages → 新建 Worker
2. 把 `worker.js` 内容粘进去，改掉里面的 `GH_RAW` 为你上面那个 GitHub 地址
3. 给 Worker 加一条路由：`get.editor.vip/*`（先给 `get` 加一条 **A 记录指向任意 IP 并开启代理**，Worker 路由需要这个占位记录）
4. 完成，得到 `https://get.editor.vip/iroh/install.sh`

> 不想折腾 Worker 也行，上面那条 GitHub 地址可以直接用，只是国内偶尔慢。
> 想再稳一点可以套 jsDelivr：`https://cdn.jsdelivr.net/gh/<账号>/<仓库>@main/install.sh`

## 脚本会问什么

| # | 问题 | 说明 |
|---|---|---|
| 1 | 中继域名 | 必须**已在 Cloudflare 解析到本机**；脚本会比对解析结果与本机出口 IP，不一致会警告 |
| 2 | Cloudflare API Token | **只在机器上第一次装时问一次**（acme.sh 会保存，后续不再问） |
| 3 | 对外端口 | 默认 **15443**，直接回车即可 |

证书只有一条路径：**Cloudflare DNS-01 签发**（不占 80/443/任何端口）。
Token 存在 `/root/.iroh-relay-cf-token`（600），同一台机器只问一次。
续期由脚本自己的 cron 负责（每 6 小时），**续期后最长 24 小时内自动生效**（中继的重载轮询间隔就是 24h）；要立刻生效就 `docker compose restart`。
Token 权限：`Zone → DNS → Edit` + `Zone → Zone → Read`，范围限定到你的域名。

支持环境变量非交互运行（CI / 批量装机）：

```bash
DOMAIN=relay-3.editor.vip CF_TOKEN=xxx CONFIRM=yes \
  bash -c "$(curl -sSL https://get.editor.vip/iroh/install.sh)"
```

## 脚本会做什么

1. 检查：root、docker、域名解析、端口占用（占用者是自己的容器时按"重装"处理）
2. 写文件到 `/opt/iroh/relay/`：`relay.toml` + `docker-compose.yml` + `.env` + `cert-sync.sh`
3. 证书：acme.sh 走 Cloudflare DNS-01 签发 → 同步成中继要求的 `default.crt`/`default.key`
4. `docker compose up -d`（host 网络；**只对外绑一个端口**，不占 UDP、不占 80）
5. 放行防火墙那一个端口 + 加一条 cron（每 6 小时同步证书，中继自动重读，**不重启**）
6. 自检：HTTPS 健康检查 + 中继协议握手（期望 `101 Switching Protocols`），并打印中继地址

## 脚本不会做什么

- 不装 systemd 服务（只用 docker compose）
- 不装 nginx、不动机器上任何其它服务
- 不占用 80/443、不占用任何 UDP 端口
- 不用中继自带的 `LetsEncrypt` 模式（那个会让中继长期占着 80 端口）
- 只对外绑一个端口，其余监听一律在 `127.0.0.1` 的随机口上

## 前置条件

- root 权限
- 已装 docker（脚本只检查并提示，不会替你装）
- 域名已解析到本机，且 **Cloudflare 的云朵是灰色（DNS only）**

## 已验证（2026-09-29，在真实服务器上）

| 场景 | 结果 |
|---|---|
| 全新安装（Cloudflare DNS-01 签发证书） | ✅ 容器 2 秒起、HTTPS 健康检查 200、WS 握手 101 |
| 重复安装（幂等） | ✅ 识别为"重建"，再次装完仍全绿 |
| 卸载 | ✅ 容器、端口、cron、防火墙规则、目录全部清掉，无残留 |
| 只对外绑一个端口 | ✅ 实测除 `0.0.0.0:15443` 外，只有一个 `127.0.0.1:<随机>` |
