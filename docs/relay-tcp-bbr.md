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
systemctl daemon-reload
systemctl enable --now relay-tcp-bbr
```

上线前保存 `ip rule show`、`ip route show table all` 和全局拥塞算法；本次备份在服务器 `/opt/iroh/relay/backups/tcp-bbr-20261005/`。
脚本发现策略优先级或路由表占用、多条默认路由时拒绝猜测，失败时撤销新增规则。

回滚：

```sh
systemctl disable --now relay-tcp-bbr
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
