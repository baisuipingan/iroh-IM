//! **签名载荷的无歧义编码**。
//!
//! ## 为什么需要这个模块
//!
//! 原来所有签名串都是 `format!("v2|{}|{}|...", ...)` 这种**分隔符拼接**。
//! 看起来没问题，实际存在语义歧义 —— 只要某个字段本身含 `|`，
//! 两组不同的字段就能拼出**完全相同**的字节：
//!
//! ```text
//! 昵称 "Alice"    正文 "A|B"  →  v2|F|1|Alice|A|B|||0|
//! 昵称 "Alice|A"  正文 "B"    →  v2|F|1|Alice|A|B|||0|     ← 相同！
//! ```
//!
//! 后果是**签名依然有效，但消息语义被改掉了** —— 拿着原作者的有效签名，
//! 可以广播一条不同含义的消息。昵称只做了 trim + 长度检查（`frontend/js/ui/sidebar.js`），
//! `|` 可以直接输入，所以这不是纯理论问题。
//!
//! ## 编码方式
//!
//! 每段用**长度前缀**（`<字节数>:<内容>`）而非分隔符：
//!
//! ```text
//! v3|3:abc|10:hello|7:a|b|c|        ← "a|b|c" 完整落在自己那段里
//! ```
//!
//! 长度按**字节**算（`str::len()`），不是字符数 —— 签名是按字节算的，
//! 按字符算会让非 ASCII 昵称的长度对不上。
//!
//! 附带好处：段数固定，解析方能立刻发现"少了一段/多了一段"，
//! 而不是像分隔符方案那样只能整体比对。

/// 协议版本。**任何签名串改动都必须 bump** —— 否则新旧签名会被互相误认。
///
/// - v1：最初版（仅文本）
/// - v2：加了文件证明的 4 个字段
/// - v3：改用无歧义长度前缀编码，并把 `id` 纳入签名
/// - v4：把「房间标识」纳入全部签名载荷（ChatMessage / Presence /
///   LeaveMsg / FileQuery / FileCtrl）
/// - **v5：把版本串**统一**成这一个**（原来每个消息族各自一个标签：
///   `l3` / `q3` / `f3` / `p4`，于是"混跑"时只有**一部分**帧会被拒，
///   语义含糊）。同时配合"服务端把协议版本放进响应"的握手：
///   新客户端能**明确**发现对端是旧版并提示刷新，而不是静默丢消息。
/// - **v6：`ChatMessage` 的载荷加入结构化 `mentions`**（去重+排序的端点 id 列表）。
///   其它消息族的载荷**没有变**，标签仍是 [`PROTO_V5`] —— 标签描述的是
///   *载荷格式*，不变就不动（presence / 文件控制在过渡期**双向互通**）。
///   v6 客户端对 ChatMessage **双读**（先按 v6 验、失败再按 v5 验），
///   旧端发来的消息与旧历史照常可读，**不需要清历史**。
///   换代信号走"握手版本"（hello 的 `chatProtocol`、响应里的 `protocol` 字段，
///   都用 [`PROTO_V6`]）：旧端会明确看到"对端是 v6"并提示升级。
///
/// ## ⚠️ 破坏性变更（必须一起升级）
///
/// v4→v5 同样要求 **roomd / 前端 / agent 同时升级，并清掉旧历史**：
/// 旧标签签出来的消息在新代码下验不过，会被当作"验签失败"丢弃。
///
/// ## v4 为什么必要
///
/// v3 及以前，签名载荷里没有任何房间信息 —— 于是**任何能进目标房间 B 的人**，
/// 都可以把他在房间 A 抓到的合法签名消息原样转发进 B：接收方验签通过、
/// `id` 校验也通过，于是原作者"在从未进过的房间里说了话"。
/// Presence（伪造在线/文件可发）、Leave（伪造刚离开）、FileQuery、
/// 文件邀约与 Accept 同理。
///
/// ## ⚠️ 破坏性变更（必须一起升级）
///
/// 载荷变了 ⇒ 旧客户端的消息在新客户端上**验签失败并被丢弃**（只有日志，
/// 用户侧无提示）。升级必须 **roomd 与前端同时**，并且**清掉旧历史**
/// （旧 `.jsonl` 里的消息在新代码下验不过，会在加载时被当作"验签失败"丢弃）。
/// **当前时代版本**（v6）：握手（`chatProtocol` / `protocol` 字段）与
/// `ChatMessage` 的载荷标签都用它。
pub const PROTO_V6: &str = "v6";

/// **v5 标签**：v6 里载荷**未变**的消息族（Presence / Leave / FileQuery /
/// FileCtrl）继续用它；同时它是 ChatMessage **双读**的回退规范（旧消息是 v5 签的）。
/// ⚠️ 别在新代码里拿它当"当前版本"—— 当前版本是 [`PROTO_V6`]。
pub const PROTO_V5: &str = "v5";

/// 把若干字段编码成**无歧义**的规范化字符串。
///
/// 每个字段编码为 `<字节数>:<内容>`，字段间不再有任何分隔符，
/// 因此内容里含什么字符都不会影响解析边界。
///
/// ```
/// use iroh_web::sigfmt::{encode_fields, PROTO_V5};
/// let a = encode_fields(&[PROTO_V5, "abc", "hello", "a|b|c"]);
/// let b = encode_fields(&[PROTO_V5, "abc", "hello|", "b|c"]);
/// assert_ne!(a, b);   // 分隔符方案下这两个是相等的
/// ```
pub fn encode_fields(fields: &[&str]) -> String {
    let mut out = String::new();
    for f in fields {
        out.push_str(&f.len().to_string());
        out.push(':');
        out.push_str(f);
    }
    out
}

/// 编码一组"标签: 数值"对 —— 用于带协议版本的规范化串。
///
/// 数值本身也带长度前缀，所以标签与值之间同样没有歧义：
/// `(ts, 12)` 编成 `2:ts2:12`。
/// 数值统一用 `u64::to_string()`（无填充），调用方不要自己拼格式。
pub fn encode_pairs(pairs: &[(&str, u64)]) -> String {
    let mut fields: Vec<String> = Vec::with_capacity(pairs.len() * 2);
    for (s, n) in pairs {
        fields.push((*s).to_string());
        fields.push(n.to_string());
    }
    let refs: Vec<&str> = fields.iter().map(|s| s.as_str()).collect();
    encode_fields(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 分隔符注入不再产生相同编码() {
        let a = encode_fields(&[PROTO_V5, "Alice", "A|B"]);
        let b = encode_fields(&[PROTO_V5, "Alice|A", "B"]);
        assert_ne!(a, b, "分隔符歧义没有被消除");
    }

    #[test]
    fn 字段边界由长度决定() {
        // 内容含冒号也无所谓，冒号前的是长度不是内容的一部分
        let a = encode_fields(&[PROTO_V5, "x:1", "y"]);
        let b = encode_fields(&[PROTO_V5, "x", "1:y"]);
        assert_ne!(a, b);
    }

    #[test]
    fn 中文按字节算长度() {
        // "研发群" = 3 个字符 = 9 字节
        let s = encode_fields(&["研发群"]);
        assert!(s.starts_with("9:"));
    }

    #[test]
    fn 相同输入产生相同输出() {
        assert_eq!(encode_fields(&["a", "b"]), encode_fields(&["a", "b"]));
    }
}
