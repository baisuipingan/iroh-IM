# iroh-gossip 0.101.0 本地补丁

来源：Cargo.lock 锁定的 crates.io `iroh-gossip 0.101.0`，原始校验和
`4e1dc4b05f73e7a1b9e83b531eb63c3fd671b0af3aeb13b59c546dd7ca747515`。
原始源码与许可证保留，仅修改 `src/proto/hyparview.rs` 的 `on_join`：
收到显式 Join 时清除该成员尚未完成的 Neighbor 请求，再发起新握手。

刷新时保留 EndpointId，但客户端丢失旧协议状态；服务端若仍等待旧 Neighbor
响应，`send_neighbor` 的去重会吞掉新 Join 的回复，导致同身份持续进房超时。
清除的是单成员的握手状态，不清空房间、历史或身份，也不修改线上报文格式。

回归：`client-wasm/tests/gossip-rejoin.rs` 重放三次没有 Neighbor 回执的 Join，
每次都必须收到回复。升级上游时应先确认该用例通过，再考虑移除本地补丁。
构建脚本必须同步整个 vendor 目录；不得直接修改构建机的 Cargo registry 缓存。
