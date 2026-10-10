//! **协议类型的唯一来源**（阶段 D）：把 Rust 侧的类型导出成前端的 TS 定义。
//!
//! ## 为什么要有这个模块
//!
//! 改造前同一套协议在三个地方各写了一遍：Rust 的 serde 结构、`mobile/src/bridge/types.ts`、
//! `agent-pi/src/protocol.ts`。手抄的代价不是"多打几个字"，而是**静默漂移** ——
//! 已经真实发生过：Rust 发的是 `relayStatus{relays}`，移动端声明的是 `relay{status}`，
//! 类型看着对、运行期读到 `undefined`，还不报错（只能靠 UI 定时轮询兜着）。
//!
//! 现在定义只有一份（下面这些 Rust 结构），三端从它生成。
//!
//! ## 两个必须知道的细节（都是实测出来的，别想当然）
//!
//! 1. **`rename_all` 的边界**：`RoomEvent` 上写的是
//!    `#[serde(tag = "type", rename_all = "camelCase")]`，但 `rename_all` 只作用于
//!    **变体名**和**带名字段**；本项目的变体全是**匿名字段**，它们的键名保持 snake_case。
//!    实测 ts-rs 的 serde-compat **正确处理了**这个区别：
//!    `{ "type": "fileAccepted", room: string, file_id: string, receiver_relay: string }`
//!    —— 变体名 camelCase、字段 snake_case。测试 `generated_ts_uses_serde_key_names` 把它钉住。
//! 2. **大整数**：ts-rs 默认把 `u64`/`i64` 映射成 TS 的 `bigint`，而 `JSON.parse`
//!    拿到的是 `number`。必须显式 `with_large_int("number")`，否则生成出来的类型
//!    与实际数据不符（`ts: bigint` 对不上 `ts: 1728…`）。
//!
//! 导出物是**生成产物**：不要手改，改 Rust 后跑 `bash scripts/gen-protocol-types.sh`。

use crate::filetransfer::FileMeta;
use crate::room::{ChatMessage, FileRef, PeerInfo, RelayInfo, RoomEvent};
use ts_rs::{Config, TS};

/// 生成文件的开头（含"不要手改"与来源说明）
const HEADER: &str = "\
/* ============================================================================
 * 由 Rust 生成 —— **不要手改这个文件**。
 *
 * 来源：client-wasm/src/{room.rs,filetransfer.rs}
 * 生成：bash scripts/gen-protocol-types.sh
 * 校验：scripts/verify.sh 会重新生成并比对（不一致直接红）
 *
 * ⚠️ 字段名是 snake_case 而**变体名**是 camelCase，这不是笔误：
 *    serde 的 `rename_all` 只改变体名与带名字段，匿名字段的键名保持原样。
 *    详见 client-wasm/src/ts_export.rs 顶部说明。
 * ==========================================================================*/

";

/// 参与导出的类型顺序（只影响可读性；TS 类型声明会被提升）
fn export_all(cfg: &Config) -> Result<Vec<(&'static str, String)>, ts_rs::ExportError> {
    Ok(vec![
        ("FileRef", FileRef::export_to_string(cfg)?),
        ("FileMeta", FileMeta::export_to_string(cfg)?),
        ("ChatMessage", ChatMessage::export_to_string(cfg)?),
        ("PeerInfo", PeerInfo::export_to_string(cfg)?),
        ("RelayInfo", RelayInfo::export_to_string(cfg)?),
        ("RoomEvent", RoomEvent::export_to_string(cfg)?),
    ])
}

/// 渲染成**单个** TS 文件的内容。
///
/// 拼成一个文件的原因：ts-rs 默认每类型一个文件，且互相 `import type ... from "./X"`；
/// 三端各自只有一个消费点，拼平更省事（也就不需要给移动端的 Metro 配 watchFolders）。
pub fn render() -> Result<String, ts_rs::ExportError> {
    let cfg = Config::new().with_large_int("number".to_owned());
    let mut out = String::from(HEADER);
    // 协议版本串也一起生成：它同样是"必须三端一致"的常量，
    // 手抄一份就多一个 v5 切换时会漏改的地方（Rust 是 `sigfmt::PROTO_V5`）。
    out.push_str(&format!(
        "/// 聊天协议版本（Rust 侧 `sigfmt::PROTO_V5`）。三端必须一致；\n\
         /// v5 切换时**只改 Rust**，然后重跑 scripts/gen-protocol-types.sh。\n\
         export const CHAT_PROTOCOL = \"{}\";\n\n",
        crate::sigfmt::PROTO_V5
    ));
    for (_name, body) in export_all(&cfg)? {
        for line in body.lines() {
            // 去掉 ts-rs 自己的文件头与跨文件 import（拼平后它们指向不存在的文件）
            if line.starts_with("// This file was generated") || line.starts_with("import type ") {
                continue;
            }
            if line.trim().is_empty() {
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ 把"生成的字段名必须与 serde 实际输出一致"钉死。
    ///
    /// 这条测试防的是一整类**静默**缺陷：生成器（或某个 `rename` 注解）一旦把
    /// 匿名变体字段也改成 camelCase，TS 侧就会去读 `fileId`，而真实事件里是
    /// `file_id` —— 编译通过、运行期 `undefined`，只有上手机/浏览器才看得出来。
    #[test]
    fn generated_ts_uses_serde_key_names() {
        let ts = render().expect("导出失败");

        // 直接拿真实序列化结果当"字典"：TS 里出现的每个键，都必须是 serde 真的会发的键
        let sample = RoomEvent::FileAccepted {
            room: "r".into(),
            file_id: "f1".into(),
            have: "0".into(),
            receiver_relay: "https://relay".into(),
            by: "peer".into(),
        };
        let json = serde_json::to_value(&sample).unwrap();
        let obj = json.as_object().expect("事件应当是对象");

        for key in obj.keys() {
            // ⚠️ 判别标签 `type` 在 TS 里是**带引号**的（`"type": "fileAccepted"`），
            //    其余字段是裸标识符 —— 所以两种写法都要认。
            let needle = if key == "type" {
                "\"type\":".to_string()
            } else {
                format!("{key}:")
            };
            assert!(
                ts.contains(&needle),
                "生成的 TS 里缺少 serde 实际会发的键 `{key}`"
            );
        }
        assert!(ts.contains("\"type\": \"fileAccepted\"") || ts.contains("type: \"fileAccepted\""));
        // 反面：不能凭空造出 camelCase 版本
        assert!(!ts.contains("fileId:"), "不该出现 fileId（serde 发的是 file_id）");
        assert!(!ts.contains("receiverRelay:"), "不该出现 receiverRelay");
        // 大整数必须是 number（默认的 bigint 与 JSON.parse 的实际值不符）
        assert!(ts.contains("done_chunks: number"), "u64 必须映射成 number");
        assert!(!ts.contains("bigint"), "不该出现 bigint");
    }

    /// 协议版本常量必须与 Rust 一致（它是 v5 切换时最容易漏改的一处）
    #[test]
    fn generated_chat_protocol_matches_rust() {
        let ts = render().expect("导出失败");
        assert!(
            ts.contains(&format!("export const CHAT_PROTOCOL = \"{}\";", crate::sigfmt::PROTO_V5)),
            "生成的 CHAT_PROTOCOL 与 sigfmt::PROTO_V5 不一致"
        );
    }

    /// 浮出"哪些类型参与导出"这件事，防手滑漏掉一个（漏了就会退回手抄）。
    #[test]
    fn all_client_visible_types_are_exported() {
        let ts = render().expect("导出失败");
        for name in ["FileRef", "FileMeta", "ChatMessage", "PeerInfo", "RelayInfo", "RoomEvent"] {
            assert!(ts.contains(&format!("export type {name} =")), "缺少 {name}");
        }
    }
}
