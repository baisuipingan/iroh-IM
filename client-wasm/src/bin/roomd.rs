//! roomd · 常驻节点（房间锚点）
//!
//! 它做中继做不到的三件事：
//!   1. **历史消息**：把房间里的消息落盘（每房间一个 jsonl），新成员进房时按需返回
//!   2. **在线状态**：自己也在房间里发 presence，别人能看到"锚点在线"
//!   3. **房间锚点**：所有人只需要知道它一个地址就能进房；没有它，纯 gossip 得先有人在线
//!
//! 与中继的关系：它是**客户端**，不监听任何端口、不开防火墙；自己连中继（本地那台 ~0.1ms）。
//! 一个进程同时看住多个房间（每个房间一个 gossip topic 订阅）。
//!
//! 环境变量：
//!   ROOMD_DATA_DIR  数据目录（默认 /data），身份与历史都在这里
//!   ROOMD_RELAYS    逗号分隔的中继列表
//!   ROOMD_ROOMS     启动时自动订阅的房间，逗号分隔（默认 lobby）
//!   ROOMD_NICKNAME  在房间里显示的名字（默认 常驻节点）
//!   ROOMD_MAX_ROOMS     同时订阅的房间数上限（默认 256）；到顶会 LRU 淘汰
//!   ROOMD_ROOM_IDLE_MS  空闲多久退订一个房间（默认 30 分钟）
//!
//! ⚠️ **房间是"随用随建"的，而请求方只要报一个房间名就能让锚点去订阅它。**
//!    所以订阅这一侧必须同时有：容量上限、LRU 淘汰、新房间限速、空闲回收
//!    （见 `Subs` / `pick_victim` 与 main 里的 rate limit + reaper）。
//!    `ROOMD_ROOMS`（启动配置）里的房间是 **pinned**：永不淘汰、永不被回收。

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use iroh::{
    endpoint::presets,
    protocol::Router,
    Endpoint, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey,
};
use iroh_gossip::{
    api::{Event as GossipEvent, GossipSender},
    net::{Gossip, GOSSIP_ALPN},
};
use iroh_web::room::{
    decode_wire, encode_presence, new_snapshots, snapshot_drop, snapshot_upsert,
    topic_id, HistoryService, HistoryStore, MemberSnapshot, Wire, HISTORY_ALPN,
};
use n0_future::{task, time::Duration, StreamExt};
use tokio::sync::Mutex as AsyncMutex;
use tracing::{debug, info, warn};

fn env_list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 一个房间的订阅状态
struct RoomSub {
    sender: Arc<AsyncMutex<GossipSender>>,
    /// 消费任务 + presence 任务的句柄。
    ///
    /// ⚠️ **淘汰房间时必须把这两条任务一起中止**：`GossipReceiver` 没有 `close()`，
    /// 只有任务结束、receiver 被 drop，这个 topic 才真正退订。
    /// 只从表里删掉 sender 是不够的（任务仍持有 receiver，房间照旧占着资源）。
    ///
    /// 这个字段**永远不被读**，作用完全在 `Drop` 上（`AbortOnDropHandle` 析构即 abort）
    /// —— 所以显式允许 dead_code，免得被当成无用字段清掉。
    #[allow(dead_code)]
    tasks: Vec<task::AbortOnDropHandle<()>>,
    /// 最近一次"有动静"的时间（收到消息 / 被拉历史），LRU 淘汰与空闲回收都看它。
    last_active_ms: u64,
}

/// 从"房间名 → 最近活跃时间"里挑淘汰对象：**最久未活跃、且不是 pinned 的**。
///
/// 抽成纯函数是为了可测：容量到顶时"淘汰谁"直接决定 lobby 这类必守房间
/// 会不会被"刷房间"的攻击挤掉。
fn pick_victim<'a, I>(live: I, pinned: &HashSet<String>) -> Option<String>
where
    I: Iterator<Item = (&'a String, u64)>,
{
    live.filter(|(k, _)| !pinned.contains(*k))
        .min_by_key(|(_, t)| *t)
        .map(|(k, _)| k.clone())
}

/// 订阅表。
///
/// `pending` 是"已经占位、正在 `await` 订阅"的房间。把**检查与占位放在同一把锁里**，
/// 是为了消除旧实现的 TOCTOU：原来是 `contains_key()` 检查 → `await subscribe` → `insert`，
/// 于是同一个新房间的 N 个并发请求会建出 **N 份重复订阅**（N 个 topic + 2N 条任务）。
#[derive(Default)]
struct Subs {
    live: HashMap<String, RoomSub>,
    pending: HashSet<String>,
}

impl Subs {
    fn known(&self, room: &str) -> bool {
        self.live.contains_key(room) || self.pending.contains(room)
    }
    /// 记一次"有动静"（收到消息 / 被拉历史）。
    fn touch(&mut self, room: &str) {
        if let Some(r) = self.live.get_mut(room) {
            r.last_active_ms = iroh_web::room::now_ms();
        }
    }
}

/// 同时订阅的房间数上限。
///
/// 房间是**随用随建**的：任何能连上锚点的人都可以请求任意房间名，让锚点去订阅它。
/// 不设上限就是一个无上限的资源放大器（topic、任务、内存、磁盘文件、
/// 以及每房间 15s 一次的 presence 广播）。默认 256 对自建聊天室绰绰有余，
/// 又能把最坏情况钉死。
const DEFAULT_MAX_ROOMS: usize = 256;
/// 空闲多久就退订（毫秒）。默认 30 分钟 —— 远大于心跳/翻页的尺度，
/// 正常使用碰不到；但攻击者刷出来的闲置房间会自己消失。
const DEFAULT_ROOM_IDLE_MS: u64 = 30 * 60 * 1000;
/// 空闲回收的扫描间隔。
const REAP_INTERVAL: Duration = Duration::from_secs(60);
/// 新房间订阅的令牌桶：突发 20 个，稳态 5 个/秒。
///
/// 这是**全局**限速，不按身份记账 —— 因为身份是免费的（可以随便生成），
/// 按 remote id 记账反而会让限流表本身变成新的内存放大点。
const SUB_BURST: f64 = 20.0;
const SUB_RATE_PER_SEC: f64 = 5.0;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let data_dir = std::env::var("ROOMD_DATA_DIR").unwrap_or_else(|_| "/data".to_string());
    std::fs::create_dir_all(&data_dir).with_context(|| format!("创建数据目录失败: {data_dir}"))?;
    let hist_dir = format!("{data_dir}/history");

    // ---- 身份持久化（EndpointId 必须稳定，前端配置里写的就是它）
    let key_path = format!("{data_dir}/identity.key");
    let key_hex = match std::fs::read_to_string(&key_path) {
        Ok(s) if s.trim().len() == 64 => s.trim().to_string(),
        _ => {
            let k = hex::encode(SecretKey::generate().to_bytes());
            std::fs::write(&key_path, &k)?;
            info!("已生成新身份并写入 {key_path}");
            k
        }
    };
    let key = SecretKey::from_str(&key_hex).context("身份私钥损坏")?;

    let relays = env_list("ROOMD_RELAYS", "https://iroh1.editor.vip:15443");
    let rooms = env_list("ROOMD_ROOMS", "lobby");
    let nickname = std::env::var("ROOMD_NICKNAME").unwrap_or_else(|_| "常驻节点".to_string());
    let relay_token = std::env::var("ROOMD_RELAY_TOKEN").ok().filter(|t| !t.is_empty());

    // ---- 端点 + gossip
    let relay_urls: Vec<RelayUrl> = relays
        .iter()
        .map(|u| RelayUrl::from_str(u).with_context(|| format!("中继 URL 无法解析: {u}")))
        .collect::<Result<_, _>>()?;
    let relay_map = {
        let mut m = RelayMap::from_iter(relay_urls);
        if let Some(t) = relay_token.as_ref() {
            m = m.with_auth_token(t.clone());
        }
        m
    };
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(key.clone())
        .relay_mode(RelayMode::Custom(relay_map))
        .alpns(vec![GOSSIP_ALPN.to_vec(), HISTORY_ALPN.to_vec()])
        .bind()
        .await?;
    // 与客户端保持一致（否则常驻节点收不下较大的消息）
    let gossip = Gossip::builder()
        .max_message_size(iroh_web::room::MAX_MESSAGE_SIZE)
        .spawn(endpoint.clone());

    let store = HistoryStore::new(Some(std::path::PathBuf::from(&hist_dir)));
    store.load_from_disk();

    // ---- 房间快照表
    //
    // 常驻节点一直在房间里、本来就收得到所有人的心跳，顺手把"谁在 + 各自还能
    // 提供哪些文件"记下来即可。新进房间的人拉历史时会顺带拿到这份快照 ——
    // **进房即刻**就知道屋里有什么，不用干等最多 10 秒的第一轮心跳。
    //
    // 注意：它是**快照不是权威**。客户端仍以自己的软状态（心跳+超时）为准，
    // 这里挂了只是回退到"等心跳"，正确性不受影响。
    let snaps = new_snapshots();

    // ---- 历史服务 + 按需订阅通道
    //
    // 通道**有界**：历史请求来自任意 peer，`unbounded` 意味着请求速率就是内存增速。
    // 满了就丢（`try_send` 已经在用），只影响"这一次自动订阅"，历史照常返回。
    let (join_tx, join_rx) = async_channel::bounded::<String>(1024);
    let _router = Router::builder(endpoint.clone())
        .accept(GOSSIP_ALPN, gossip.clone())
        .accept(
            HISTORY_ALPN,
            HistoryService::new(store.clone(), join_tx, snaps.clone()),
        )
        .spawn();

    // ---- 多房间订阅管理
    let subs: Arc<Mutex<Subs>> = Arc::new(Mutex::new(Subs::default()));
    let endpoint_id = endpoint.id().to_string();

    // 资源上限（环境变量可调）
    let max_rooms = std::env::var("ROOMD_MAX_ROOMS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_ROOMS);
    let room_idle_ms = std::env::var("ROOMD_ROOM_IDLE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_ROOM_IDLE_MS);
    // 配置里点名的房间**永久保留**，不受上限/回收影响 ——
    // 否则一场刷房间的攻击会把 lobby 这类"必守"的房间挤掉。
    let pinned: HashSet<String> = rooms.iter().cloned().collect();

    // 关键一行：让外部（前端配置 / 部署脚本）能拿到地址
    println!("ROOMD_ENDPOINT_ID={endpoint_id}");
    info!("常驻节点启动：id={endpoint_id} 房间={rooms:?} 中继={relays:?} 历史目录={hist_dir}");

    // 订阅入口：给房间开一个 topic，消费消息写历史，并周期性发 presence
    let subscribe = {
        let gossip = gossip.clone();
        let key = key.clone();
        let subs = subs.clone();
        let store = store.clone();
        let nickname = nickname.clone();
        let endpoint_id = endpoint_id.clone();
        // ⚠️ 必须像其它变量一样在这里预克隆一次。
        //    否则 `move |room|` 会把 `snaps` 整个搬进它的环境，而里面的
        //    `async move` 又会把它搬走 → 闭包从 Fn 退化成 FnOnce，
        //    而它要在循环里被调用多次（编译报 E0382 "use of moved value"）。
        let snaps = snaps.clone();
        // 同上：`pinned` 是 HashSet（非 Copy），不在这里 clone 的话，
        // 里面的 `async move` 会把它搬走 → 闭包退化成 FnOnce（编译报 E0382）。
        let pinned = pinned.clone();
        move |room: String| {
            let gossip = gossip.clone();
            let key = key.clone();
            let subs = subs.clone();
            let store = store.clone();
            let nickname = nickname.clone();
            let endpoint_id = endpoint_id.clone();
            let snaps = snaps.clone();
            let pinned = pinned.clone();
            async move {
                // ── ① 容量检查 + 占位：**必须在同一把锁里完成**（消除 TOCTOU）
                {
                    let mut s = subs.lock().unwrap();
                    if s.known(&room) {
                        // 已订阅（或正在订阅）：只更新活跃时间
                        s.touch(&room);
                        return;
                    }
                    // 到上限就先淘汰最久未活跃的房间（`pinned` 的房间不淘汰）。
                    // 淘汰会把它的两条任务一起中止 → topic 真正退订。
                    while s.live.len() + s.pending.len() >= max_rooms {
                        let victim = pick_victim(
                            s.live.iter().map(|(k, r)| (k, r.last_active_ms)),
                            &pinned,
                        );
                        let Some(victim) = victim else { break }; // 只剩 pinned，无法腾位
                        if let Some(old) = s.live.remove(&victim) {
                            warn!(
                                "房间数达上限 {max_rooms}，退订最久未活跃的房间 {victim}（中止其 2 条任务）"
                            );
                            drop(old);
                        } else {
                            break;
                        }
                    }
                    if s.live.len() + s.pending.len() >= max_rooms {
                        warn!("房间数已达上限 {max_rooms} 且无可淘汰房间，跳过订阅 {room}（历史仍可读）");
                        return;
                    }
                    s.pending.insert(room.clone());
                }

                // ── ② 真正订阅（此处 await；占位已在上面完成）
                let topic = topic_id(&room);
                let bootstrap: Vec<EndpointId> = Vec::new();
                let t = match gossip.subscribe(topic, bootstrap).await {
                    Ok(t) => t,
                    Err(e) => {
                        warn!("订阅房间 {room} 失败: {e}");
                        subs.lock().unwrap().pending.remove(&room);
                        return;
                    }
                };
                let (sender, receiver) = t.split();
                let sender = Arc::new(AsyncMutex::new(sender));
                info!("已订阅房间 {room}（现有历史 {} 条）", store.count(&room));

                // 消费消息 → 落盘
                let room_c = room.clone();
                let store_c = store.clone();
                let subs_c = subs.clone();
                let snaps_c = snaps.clone();
                let mut receiver = receiver;
                let t1 = task::spawn(async move {
                    while let Some(ev) = receiver.next().await {
                        // 收到任何东西都算"这个房间还活着"，避免被空闲回收误杀
                        if let Ok(mut s) = subs_c.lock() {
                            s.touch(&room_c);
                        }
                        match ev {
                            Ok(GossipEvent::Received(msg)) => {
                                // 注意：gossip 层的协议帧（IHave/Shuffle/…）也走这个分支，
                                // 它们不是 Wire，`decode_wire` 会返回 None —— 静默跳过即可。
                                let Some(wire) = decode_wire(&msg.content) else { continue };
                                match wire {
                                    Wire::Message { m } => {
                                        // 这里不再自己验签：`append` 内部做兜底校验
                                        // （避免"某个调用点忘了验"就让脏数据进历史）。
                                        // 返回 false 时它已经打过 warn 了。
                                        let _ = store_c.append(&room_c, m);
                                    }
                                    Wire::Presence { p } => {
                                        if !p.verify() {
                                            continue;
                                        }
                                        if p.from != endpoint_id {
                                            info!("[{}] {} 在线", room_c, p.nickname);
                                        }
                                        // 顺手更新房间快照（含他的文件清单）
                                        snapshot_upsert(
                                            &snaps_c,
                                            &room_c,
                                            MemberSnapshot {
                                                id: p.from.clone(),
                                                nickname: p.nickname.clone(),
                                                last_seen_ms: iroh_web::room::now_ms(),
                                                files: p.files.clone(),
                                                epoch: p.epoch,
                                            },
                                        );
                                    }
                                    // 对方主动离开（切房间时发的加速声明）→ 立刻从快照摘掉
                                    Wire::Leave { l } => {
                                        if !l.verify() {
                                            continue;
                                        }
                                        snapshot_drop(&snaps_c, &room_c, &l.from);
                                        debug!("[{}] {} 离开", room_c, l.from);
                                    }
                                    // 可用性质询由发送方本人应答（他重播心跳即可），
                                    // 常驻节点只做旁观，不需要参与
                                    Wire::FileQuery { .. } => {}
                                    Wire::File { c } => {
                                        // 常驻节点不参与文件中转（文件是点对点直连）。
                                        // 只在日志里留个痕，便于排查。
                                        if let Some(ctrl) = c.verify() {
                                            debug!("[{}] 文件控制：{}", room_c, ctrl.file_id());
                                        }
                                    }
                                }
                            }
                            Ok(GossipEvent::NeighborUp(id)) => info!("[{}] 邻居上线 {id}", room_c),
                            Ok(GossipEvent::NeighborDown(id)) => info!("[{}] 邻居下线 {id}", room_c),
                            Ok(GossipEvent::Lagged) => warn!("[{}] gossip 落后", room_c),
                            Err(e) => {
                                warn!("[{}] gossip 错误: {e}", room_c);
                                break;
                            }
                        }
                    }
                    // ⚠️ 这里**不要**自己去 `subs.remove(&room_c)`：
                    //    那会把本房间的 `AbortOnDropHandle` 一起 drop 掉，
                    //    等于任务中止自己（还会顺手把 presence 任务也 abort）。
                    //    订阅表由淘汰/空闲回收统一管理，见 main 里的 reaper。
                    warn!("[{room_c}] 消费任务结束（等待回收）");
                });

                // 周期性 presence（让房间里的客户端看到"常驻节点在线"）
                let room_p = room.clone();
                let key_p = key.clone();
                let nickname_p = nickname.clone();
                let subs_p = subs.clone();
                let t2 = task::spawn(async move {
                    let mut ticker = n0_future::time::interval(Duration::from_secs(15));
                    loop {
                        ticker.tick().await;
                        // 房间被淘汰后 `get` 会返回 None（此时任务也已被 abort，
                        // 这里只是双保险，保证不会给已退订的房间继续广播）
                        let sender = subs_p
                            .lock()
                            .unwrap()
                            .live
                            .get(&room_p)
                            .map(|s| s.sender.clone());
                        let Some(sender) = sender else { break };
                        let bytes = encode_presence(&key_p, &nickname_p);
                        if bytes.is_empty() {
                            continue;
                        }
                        if sender.lock().await.broadcast(bytes.into()).await.is_err() {
                            break;
                        }
                    }
                });

                // ── ③ 登记为 live（摘掉占位），并把两条任务的句柄交给订阅表保管
                {
                    let mut s = subs.lock().unwrap();
                    s.pending.remove(&room);
                    s.live.insert(
                        room.clone(),
                        RoomSub {
                            sender,
                            tasks: vec![
                                task::AbortOnDropHandle::new(t1),
                                task::AbortOnDropHandle::new(t2),
                            ],
                            last_active_ms: iroh_web::room::now_ms(),
                        },
                    );
                }
            }
        }
    };

    // 启动时订阅配置里的房间
    for r in &rooms {
        subscribe(r.clone()).await;
    }

    // 历史请求里出现的新房间 → 自动订阅（房间随用随建）
    //
    // ⚠️ 这一段是**无鉴权**的：请求方只要报一个房间名就能让锚点去订阅。
    //    所以必须限速 + 有上限 + 能回收，否则就是"用小请求换大资源"的放大器。
    {
        let subscribe = subscribe.clone();
        let subs = subs.clone();
        task::spawn(async move {
            let mut tokens = SUB_BURST;
            let mut last = std::time::Instant::now();
            while let Ok(room) = join_rx.recv().await {
                // 已知房间：只更新时间戳（不消耗令牌）
                if subs.lock().unwrap().known(&room) {
                    subs.lock().unwrap().touch(&room);
                    continue;
                }
                // 新房间：令牌桶限速，不足就跳过这次订阅（历史服务不受影响，
                // 客户端下次进房还会再来一次）
                let now = std::time::Instant::now();
                tokens = (tokens + now.duration_since(last).as_secs_f64() * SUB_RATE_PER_SEC)
                    .min(SUB_BURST);
                last = now;
                if tokens < 1.0 {
                    warn!("新房间订阅速率超限，跳过 {room}（历史仍可读）");
                    continue;
                }
                tokens -= 1.0;
                subscribe(room).await;
            }
        });
    }

    // 空闲回收：把长时间没动静的房间退订掉（drop 句柄 → 两条任务中止 → topic 退订）。
    // 这是"上限"之外的第二道闸：即使没到上限，攻击者刷出来的闲置房间也会自己消失。
    {
        let subs = subs.clone();
        task::spawn(async move {
            let mut ticker = n0_future::time::interval(REAP_INTERVAL);
            loop {
                ticker.tick().await;
                let now = iroh_web::room::now_ms();
                let victims: Vec<String> = {
                    let s = match subs.lock() {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    s.live
                        .iter()
                        .filter(|(k, r)| {
                            !pinned.contains(*k) && now.saturating_sub(r.last_active_ms) > room_idle_ms
                        })
                        .map(|(k, _)| k.clone())
                        .collect()
                };
                if victims.is_empty() {
                    continue;
                }
                let mut s = subs.lock().unwrap();
                for v in victims {
                    if let Some(old) = s.live.remove(&v) {
                        info!("退订空闲房间 {v}（超过 {room_idle_ms}ms 无动静）");
                        drop(old);
                    }
                }
            }
        });
    }

    // 保持进程存活
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[(&str, u64)]) -> HashMap<String, u64> {
        v.iter().map(|(k, t)| (k.to_string(), *t)).collect()
    }

    #[test]
    fn 淘汰挑最久未活跃的房间() {
        let live = names(&[("a", 300), ("b", 100), ("c", 200)]);
        let pinned = HashSet::new();
        let v = pick_victim(live.iter().map(|(k, t)| (k, *t)), &pinned);
        assert_eq!(v.as_deref(), Some("b"), "应淘汰最久未活跃的 b");
    }

    #[test]
    fn 淘汰不会动_pinned_的房间() {
        // b 最旧但被 pin（比如 lobby），必须退而淘汰次旧的 c
        let live = names(&[("lobby", 10), ("c", 200)]);
        let pinned: HashSet<String> = ["lobby".to_string()].into_iter().collect();
        let v = pick_victim(live.iter().map(|(k, t)| (k, *t)), &pinned);
        assert_eq!(v.as_deref(), Some("c"), "pinned 的房间不能被淘汰");
    }

    #[test]
    fn 只剩_pinned_时没有可淘汰目标() {
        // 此时必须返回 None，让调用方"拒绝新订阅"而不是把必守房间踢掉
        let live = names(&[("lobby", 10), ("ops", 20)]);
        let pinned: HashSet<String> = ["lobby".to_string(), "ops".to_string()]
            .into_iter()
            .collect();
        assert!(pick_victim(live.iter().map(|(k, t)| (k, *t)), &pinned).is_none());
    }

    #[test]
    fn 订阅表的占位能拦住并发重复订阅() {
        // TOCTOU 回归：第一个请求占位后，第二个同房间请求必须被判为"已知"
        let mut s = Subs::default();
        assert!(!s.known("r"));
        s.pending.insert("r".to_string());
        assert!(s.known("r"), "pending 必须算作已知，否则会重复订阅");
        s.pending.remove("r");
        assert!(!s.known("r"));
    }
}
