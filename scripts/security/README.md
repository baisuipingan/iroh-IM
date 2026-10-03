# 安全回归验证（用原始攻击脚本验证修复）

这套脚本的作用：**用审查报告里原本用来"证明漏洞存在"的攻击代码，验证修复后攻击被挡住**。
比普通单元测试更有说服力 —— 它跑的就是攻击者真正会做的事。

## 怎么跑

```bash
cd client-wasm
export PATH="$HOME/.cargo/bin:$PATH"

# 1) 签名 / 持久化 / 分页（纯内存 + 落盘，秒级）
cargo run --offline --no-default-features --features cli --example attack-verify

# 2) 文件流授权（起两个真实本地 QUIC endpoint，十几秒）
cargo run --offline --no-default-features --features cli --example attack-stream
```

两个都应输出「总计 PASS=N FAIL=0」并以 0 退出。

## 覆盖的攻击

| 脚本 | 攻击 | 修复前 | 修复后 |
|---|---|---|---|
| attack-verify | 改昵称+正文，签名仍有效 | ❌ 攻击成功 | ✅ 验签失败 |
| attack-verify | 改消息 id 后重放 | ❌ 历史多一条 | ✅ 验签失败 + 去重 |
| attack-verify | `team_a`/`研发群`/`产品群` 落盘互撞 | ❌ 历史混合 | ✅ 各自独立 |
| attack-verify | 改 `Invite.sender` / `ts` | ❌ 验签通过 | ✅ 验签失败 |
| attack-verify | 同毫秒 51 条消息翻页漏第 51 条 | ❌ 永久取不到 | ✅ `(ts,id)` 游标能取到 |
| attack-verify | 心跳文件清单分隔符歧义 | ❌ 载荷相同 | ✅ 载荷不同 |
| attack-verify | 改 `Leave.ts` / `FileQuery.want` | ❌ 验签通过 | ✅ 验签失败 |
| attack-stream | **无关身份注入文件流** + 越界块序号 | ❌ 数据进通道 | ✅ 整条流拒收 + 明确回执 |

## 改这两个脚本时注意

- `attack-verify` 里 `append()` 现在自己验签并返回 `bool`，所以"改 id 后重放"的
  断言是「历史里只有 1 条」——**这是历史存储的兜底校验**，不能删。
- `attack-stream` 里冒充者**不能**在写完帧后立刻 `outgoing.finish()`：
  半关闭会抢在服务端写回执之前断开，表现为读回执时 `connection lost`。
  真实攻击者会等回执，脚本也应如此。
- 服务端拒绝时走 `deny()`（`filetransfer.rs`）：它会等对端读完才返回。
  直接在 `accept()` 里 `write + return` 会让对端只看到 `connection lost`（已修）。

## 与审查报告的对应

原始攻击脚本在 `/tmp/iroh-review-*.rs`（报告的复现材料），本目录是它们的镜像版：
断言方向相反 —— 原版断言"攻击成功"，本版断言"攻击被挡住"。
