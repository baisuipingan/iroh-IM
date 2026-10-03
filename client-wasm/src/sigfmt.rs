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
pub const PROTO_V3: &str = "v3";

/// 把若干字段编码成**无歧义**的规范化字符串。
///
/// 每个字段编码为 `<字节数>:<内容>`，字段间不再有任何分隔符，
/// 因此内容里含什么字符都不会影响解析边界。
///
/// ```
/// use iroh_web::sigfmt::encode_fields;
/// let a = encode_fields(&["v3", "abc", "hello", "a|b|c"]);
/// let b = encode_fields(&["v3", "abc", "hello|", "b|c"]);
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
        let a = encode_fields(&["v3", "Alice", "A|B"]);
        let b = encode_fields(&["v3", "Alice|A", "B"]);
        assert_ne!(a, b, "分隔符歧义没有被消除");
    }

    #[test]
    fn 字段边界由长度决定() {
        // 内容含冒号也无所谓，冒号前的是长度不是内容的一部分
        let a = encode_fields(&["v3", "x:1", "y"]);
        let b = encode_fields(&["v3", "x", "1:y"]);
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
