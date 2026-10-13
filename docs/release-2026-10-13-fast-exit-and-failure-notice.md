# 2026-10-13 退出提速 + 失败要说话：Ctrl-C 从 ~7 秒 → 0.5 秒

## 一句话

用户实测两件事：① "这个后台怎么退出这么慢"——根因是 Ctrl-C 打到**整个进程组**
（`serve` 比适配器先退），而 `stop()` 还在等一个永远不会再触发的 `close` 事件；
② "等了半天也没回复"——brain 失败只写日志，房间里**没有任何声音**。
两个都修了，并各自钉了回归。

## 改了什么

| # | 位置 | 改动 |
|---|---|---|
| 1 | `agent-pi/src/room/client.ts` | `stop()` 先看 `#childExited`（`#onClose` 置位）：子进程已退就直接返回，不再白等 5s→SIGKILL→再等 2s；`request('shutdown')` 之后**再同步查一次**（await 期间退出的竞态也堵住） |
| 2 | `agent-pi/src/room/adapter.ts` | brain 失败除了写日志，**在房间里如实说一句**（限频 120s）：`⚠️ 我这轮没处理成功：<原因>（稍后可以再 @ 我一次）`——与"权限/预算被拒都要说出来"的既有原则一致，用户不用再干等 |
| 3 | 测试 | 新 `scripts/test-agent-client.mjs`（已并入 `npm test`）：正常退出 <1.5s、**子进程先退**场景 stop() <1s（旧代码 ~7s）；`test-agent-adapter.mjs` 新增失败播报 + 120s 窗口不刷屏 |

## 验证

| 项 | 结果 |
|---|---|
| 单元 | `npm test` 全绿（adapter+client+bootstrap+acp+summoner；新增 2 + 1 条） |
| 真·终端 Ctrl-C（给整个进程组发 SIGINT，复刻用户场景） | **479 ms** 从 SIGINT 到进程完全退出（修复前 ~7s，日志里能看到 `5s 未退出，SIGKILL`）；日志 `收到 SIGINT → 优雅退出 → 已退出` 完整 |
| 失败播报 | 假 brain 抛 `Authentication required…` → 房间收到 `⚠️ 我这轮没处理成功：…`；120s 内第二次触发只尝试、不重复播报 |
| `verify.sh all` | 全部套件绿；`fix-review` 首轮偶发超时（传输出取消/拒绝统计那步，与本轮改动面无关），**单跑复验 52/52** |

## 发版

- `bridge-v0.2.2`：CI run **`38410416796` success**（六平台 + 逐产物 sha256）；npm `iroh-room-bridge@0.2.2` 已发布（`latest`=0.2.2）。

## 回滚

纯增量：`git revert`；不传任何新参数的行为与 0.2.1 基本一致（退出更快、失败多一句房间播报）。
