# 中继 TCP 吞吐修复（2026-10-05）

浏览器文件数据使用 WSS/TCP 15443 承载 QUIC，不是浏览器直连 UDP 7842。
服务器 TCP CUBIC 在本次测试出口存在重传、乱序、拥塞窗口降至 1–2 的证据。
OPFS 每块写入与 Worker 调度不足以解释约 36–38 KiB/s 的持续低吞吐。

## 对照结果

- CUBIC 历史独立测量：2 MiB 53.521–56.968 秒，校验成功。
- 对测试出口临时设置路由级 BBR：2 MiB 3.028 秒，校验成功。
- 恢复 CUBIC 再测：2 MiB 在约 52 秒暂停，未完成。
- 中继端口级 BBR，无其他传输并发：512 KiB 1.825 秒、2 MiB 2.441 秒、8 MiB 7.287 秒，逐字节校验成功。
- 与整套文件回归并发时，2 MiB 28.62 秒（71.6 KiB/s），性能断言正确失败；不能宣称所有并发与网络都达到独立测量的速度。

这证明本出口上的 BBR 改善有效，不证明每条网络路径都能得到相同吞吐，也不能推断最初退化发生的具体时间。

## 范围与部署

`scripts/relay-tcp-bbr.sh` 与 `deploy/relay-tcp-bbr.service` 使用 IPv4 策略路由：

1. 只匹配源 TCP 端口 15443 的中继响应。
2. 优先保留主路由表的非默认路由（包括 roomd Docker 网段）。
3. 公网默认路由指定 BBR；全局 TCP 默认仍为 CUBIC。
4. 不重启中继或 roomd，不变更身份、数据库、协议或 WASM。现存连接继续使用原算法，新连接采用 BBR。
5. 当前服务器默认路由只有一条，公网为 IPv4。本方案没有调整 IPv6。

安装到服务器：

```sh
install -m755 scripts/relay-tcp-bbr.sh /usr/local/sbin/iroh-relay-tcp-bbr
install -m644 deploy/relay-tcp-bbr.service /etc/systemd/system/relay-tcp-bbr.service
install -m644 deploy/relay-tcp-bbr-check.service /etc/systemd/system/relay-tcp-bbr-check.service
install -m644 deploy/relay-tcp-bbr-check.timer   /etc/systemd/system/relay-tcp-bbr-check.timer
systemctl daemon-reload
systemctl enable --now relay-tcp-bbr relay-tcp-bbr-check.timer
```

⚠️ **必须同时装"反清道夫"配置**（见下节），否则规则会被 systemd-networkd 悄悄删掉：

```sh
mkdir -p /etc/systemd/networkd.conf.d
cat > /etc/systemd/networkd.conf.d/95-manage-foreign.conf <<'EOF'
[Network]
ManageForeignRoutingPolicyRules=no
ManageForeignRoutes=no
EOF
systemctl restart systemd-networkd
```

上线前保存 `ip rule show`、`ip route show table all` 和全局拥塞算法；本次备份在服务器 `/opt/iroh/relay/backups/tcp-bbr-20261005/`。
脚本发现策略优先级或路由表占用、多条默认路由时拒绝猜测，失败时撤销新增规则。

## 2026-10-14 复盘：规则被系统静默清掉（已修 + 已加自愈）

**症状**：用户传大文件时速度锯齿、界面频繁"断开→瞬间连上"；中继日志里同一时段
**7392 条 `failed to forward packet: Full`（转发队列满→丢包）** 与 **473 条建连超时**，
且全部来自用户 IP；而中继进程本身空闲（CPU 0.09%）、ICMP 到中继 0 丢包 40–64ms。

**根因（实测钉死）**：`relay-tcp-bbr` 服务显示 active，但 `ip rule` 里 15442/15443
两条规则和 table 15443 都**已经不存在**（全局退回 CUBIC）。实验：
`systemctl restart systemd-networkd` → 规则当场消失。原因：systemd-networkd 默认
**清理"外来"策略路由**（`ManageForeignRoutingPolicyRules=yes`），
任何一次重配置（networkd 重启/reload、netplan apply 等）都会把 BBR 规则一起删掉。
之前 2026-10-05 的 BBR 改善因此静默失效。

**修复**：
1. 根因：`/etc/systemd/networkd.conf.d/95-manage-foreign.conf`
   （`ManageForeignRoutingPolicyRules=no` + `ManageForeignRoutes=no`）——
   实测"重启 networkd 后规则存活"。
2. 兜底：`relay-tcp-bbr-check.timer` 每 2 分钟跑 `iroh-relay-tcp-bbr ensure`
   （幂等逐项修补；演练：删掉规则 → timer 服务单跑一次即恢复；并发 ensure 不再
   撞 `RTNETLINK File exists`）。
3. 脚本新增 `ensure` / `status` 子命令；`status` 可直接用于巡检：
   `iroh-relay-tcp-bbr status`（applied / MISSING）。

**生效范围提醒**：只有**新建立的** TCP 连接吃到 BBR；已存在的长连接保持原算法 ——
改完/恢复后需要客户端**刷新页面**（或重连）才能受益。

回滚：

```sh
systemctl disable --now relay-tcp-bbr relay-tcp-bbr-check.timer
```

回滚不改全局算法。已有 BBR 连接需客户端重新连接才恢复 CUBIC；无需清理浏览器数据或 roomd 历史。

## 可重复基准

```sh
python3 scripts/transfer-bench.py 8099 0.5,2,8 opfs
```

需要已安装的 Playwright（可通过 `PLAYWRIGHT_MODULE` 指定）。基准启动独立 Chrome、隔离身份、唯一房间，不关闭共享 CDP 标签页或清其他人的存储。
逐字节验证真实 OPFS 文件，等待发送端确认，记录接收实际进度与 Worker 写盘时间。
45 秒无接收进度或四分钟总时限、文件错误、低于默认 128 KiB/s 性能门槛均返回非零。
`BENCH_MIN_KIBPS=0` 只关闭性能门槛，不关闭交付与进度检查；`mem` 为 Worker 无写盘诊断，不能算文件交付。
