# ⛔ 已过时 —— 这个问题已经解决了（2026-10-05 晚）

> **先看这里再读下面。**
>
> **① 问题已修复。** 原开发者定位到根因并在服务器上做了端口级 TCP BBR 策略，
> 现在全量回归 **14 个用例 / 236 项断言全绿**（`file-recipients` 从卡死变成 26/26）。
> 修复说明见 [`../relay-tcp-bbr.md`](../relay-tcp-bbr.md)。**下面的排查建议不用再执行了。**
>
> **② 我下面写的"传输走 UDP 7842 的 QUIC"是错的。** 实际是
> **浏览器文件数据经 WSS/TCP **15443** 承载**，不是浏览器直连 UDP 7842。
> 所以服务器 TCP 拥塞算法（当时是 CUBIC）才会直接决定吞吐 ——
> 这也是为什么 BBR 一上就把 2 MiB 从 53~57 秒压到 2.4 秒。
>
> 我当时的判断只对了一半：**"HTTP 探测快 ≠ 数据面快" 这个结论是对的**
> （所以现在界面上的延迟都改标成「HTTP 探测」了），但**对协议的推理是错的**。
> 教训：拿不到确证的链路细节，不要写成结论，要写成"待确认"。

---

# 排查任务提示词（可直接复制给接手的人 / 或粘给 AI 助手）

```text
【任务】排查一个自研端到端加密聊天室的「文件传输批量吞吐不足」问题。
请先定位根因并给出可验证的证据，不要重写功能、不要重构传输逻辑。

【项目位置】
- 仓库：/Users/patrick/WorkBuddy/iroh聊天室
- 前端：frontend/（纯静态 ES module，无构建步骤）
- 传输内核：Rust + wasm（client-wasm/），浏览器端跑在 Web Worker 里
  （frontend/js/iroh-worker.js）
- 中继配置：frontend/relay-config.json
- 架构要点：**浏览器版永久 relay-only（打不了洞）**，两台浏览器之间的所有
  数据都经自研 iroh-relay 转发。文件传输走 **UDP 7842 的 QUIC**，
  和 HTTPS 探测（15443）不是同一条路 —— 这点很容易搞错。

【症状】
端到端用例 scripts/e2e/file-recipients.py 卡死在「2 MiB 文件断点续传」那一步。
失败瞬间两边的状态对不上：
    发送方视角： recipient.state = sending, done = 128/128, bytes = 2097152  ← 数据全发完
    接收方页面： transfer.state = active,  done = 104/128                      ← 只收到 104 块
45 秒超时到了，接收方还在慢慢爬。

★ 关键特征：**每次跑停住的块数都不一样**（实测见过 68 / 104 / 193）。
  数字每次不同 ⇒ 不是状态机算错，是根本没在时限内传完。
  换算下来链路吞吐只有约 2~3 块/秒（每块 16 KiB，即约 40 KB/s 量级）。

只在大批量时失败：512 KB（32 块）的步骤全部通过，
2 MiB（128 块）与 8 MiB（512 块）失败。
其余 13 个用例全绿，其中 multi-peer / file-history 也传文件，只是量小。

【复现】
前置（缺一不可，详见 scripts/e2e/README.md 顶部）：
  1) python3 scripts/dev-serve.py 8099        # 服务 frontend/，强制不缓存
  2) 无头 Chrome 带 --remote-debugging-port=9222 --no-sandbox --disable-setuid-sandbox
  3) 跑测试要清代理：
     env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy bash scripts/e2e/run.sh file-recipients
日志：/tmp/e2e-logs/file-recipients.log（失败时会打印三方完整状态快照，很有用）

【已经排除掉的 —— 请勿重复做，每条都实测过】
| 怀疑对象 | 怎么排的 | 结果 |
|---|---|---|
| 前端改造引入 | git stash push -- frontend 把前端整体回退到提交版本，跑同一用例 | 原始前端同样失败，且更严重（8 MiB 那步卡在 193/512） |
| roomd 状态累积 | docker compose restart roomd | 仍失败 |
| 测试浏览器老化 | 重启跑了 1 天 9 小时的 Chrome + 清空 profile | 仍失败 |
| 中继容器状态 | docker restart iroh-relay（已连续运行 6 天） | 仍失败 |
| 主机过载 | uptime | 负载 0.50，正常 |
| 前端 CSS 动画吃 CPU（环境是 --disable-gpu 软件合成） | Chrome 加 --force-prefers-reduced-motion | 仍失败，排除 |

★ 如果以后要重复这类判断：**第一步永远是 git stash 回退前端跑一遍**，
  几分钟就能区分"自己的改动"还是"环境"，能省掉后面全部试错。

【目前怀疑方向】
roomd 自己的中继探测（docker compose logs roomd）：
    iroh1.editor.vip (hk-1) =   8.69 ms   ← 在用，很快
    iroh2.editor.vip (eu-1) = 1.014  s    ← 秒级
    iroh3.editor.vip (fr-1) =  736   ms   ← 秒级
    另外出现 3 次  QADv4: probe timed out
三台里有两台的往返是秒级。
⚠️ 但注意：hk-1 的 HTTP 探测只有 53 ms，而传输走 UDP 7842 —
   HTTP 快**不代表**数据面快，别被这个掩盖掉。

建议按顺序：
1. 先量，别猜。项目里已有 scripts/transfer-bench.py，跑一遍拿到真实吞吐曲线。
2. 查 eu-1 / fr-1 那两台中继主机（现在秒级延迟）：是否挂了 / 带宽被占满 / 网络绕路。
3. 查 hk-1 的 UDP 7842 是否被限速或丢包。
4. 定位慢在哪一段：浏览器→中继 / 中继→浏览器 / 中继内部转发 / 锚点回源。
   可以用"同一台机器上开两个浏览器互传"和"跨机互传"对比，区分本地环回与真链路。

【访问资源】
- 服务器：root@<OLD_SERVER_IP>:15601，SSH key 在 <SSH_KEY_PATH>
  - roomd：由 docker compose 管理，目录 /opt/iroh/roomd
    （日志：cd /opt/iroh/roomd && docker compose logs --tail=200 roomd）
  - iroh-relay：**独立 docker run 启动，不由 compose 管理**，
    重启用 docker restart iroh-relay
- 本地基准脚本：scripts/transfer-bench.py
- 端到端用例：bash scripts/e2e/run.sh file-recipients

【禁止事项】
- 禁止通过调大测试超时（45s）来让用例变绿 —— 那只会盖掉"吞吐劣化"这个真实信号，
  而真实用户传大文件一样会卡。
- 禁止为了让测试通过而修改断言。
- 不要重构传输逻辑；先定位。

【期望交付】
1. 真实吞吐数字：512 KB / 2 MiB / 8 MiB 三档各自的耗时与「块/秒」。
2. 慢在哪一段（浏览器→中继 / 中继→浏览器 / 中继内部 / 锚点回源）。
3. 根因假设，以及支持它 / 反对它的证据（有数据，不要只给推测）。
4. 如果不是代码问题，明确说是哪台机器或哪个网络环节。
```
