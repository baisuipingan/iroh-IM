//! 用报告原来的攻击（/tmp/iroh-review-stream.rs）验证文件流授权修复。
//!
//! 原始攻击：一个**无关身份**的 endpoint 只提供已登记的 file_id，
//! 它的数据就进了接收通道；序号 900000 也原样交给上层。
//! 这里断言：**整条流被拒**。

use anyhow::Result;
use iroh::{endpoint::presets, protocol::Router, Endpoint, EndpointAddr, RelayMode, SecretKey};
use iroh_web::filetransfer::{
    read_json_frame, write_frame, write_json_frame, FileAck, FileChunk, FileHeader, FileMeta,
    FileService, FILE_ALPN, FRAME_CHUNK, FRAME_DONE, FRAME_HEADER,
};
use std::time::Duration;

async fn review() -> Result<()> {
    let real_sender = SecretKey::generate();
    let expected_sender = real_sender.public();

    let endpoint = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .bind_addr("127.0.0.1:0")?
        .alpns(vec![FILE_ALPN.to_vec()])
        .bind()
        .await?;
    let service = FileService::new();

    // ⚠️ 关键差异：登记时给出**完整元信息**，其中 sender 是真正的发送方。
    //    旧实现只能给 file_id，所以无从校验谁连上来。
    let meta = FileMeta {
        file_id: "visible-file-id".to_string(),
        name: "real.bin".to_string(),
        size: 4,
        mime: "application/octet-stream".to_string(),
        chunk_size: 4,
        root_hash: "real-hash".to_string(),
        sender: expected_sender.to_string(),
        sender_relay: "https://relay.invalid".to_string(),
        ts: 1,
    };
    let (chunks, _ack) = service
        .expect("visible-file-id", meta.clone())
        .expect("登记待接收");
    let router = Router::builder(endpoint.clone()).accept(FILE_ALPN, service).spawn();

    // 冒充者：一个完全无关的身份
    let impostor = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .bind_addr("127.0.0.1:0")?
        .bind()
        .await?;
    assert_ne!(impostor.id(), expected_sender, "冒充者不该是真发送方");

    let loopback = endpoint
        .bound_sockets()
        .into_iter()
        .find(|a| a.is_ipv4())
        .unwrap();
    let address = EndpointAddr::new(endpoint.id()).with_ip_addr(loopback);
    let connection = impostor.connect(address, FILE_ALPN).await?;
    let (mut outgoing, mut incoming) = connection.open_bi().await?;

    // 冒充者连 header 都按真文件报（最大努力伪装）
    write_json_frame(
        &mut outgoing,
        FRAME_HEADER,
        &FileHeader {
            file_id: "visible-file-id".to_string(),
            name: "real.bin".to_string(),
            size: 4,
            chunk_size: 4,
            root_hash: "real-hash".to_string(),
            mime: "application/octet-stream".to_string(),
        },
    )
    .await?;
    let mut body = 900_000u32.to_be_bytes().to_vec();
    body.extend_from_slice(&[1, 2, 3, 4]);
    write_frame(&mut outgoing, FRAME_CHUNK, &body).await?;

    // ⚠️ 修过的一个测试自身问题：原来这里立刻 `outgoing.finish()`，
    //    半关闭了自己的发送方向，导致还没读到服务端的拒绝回执连接就收了。
    //    真实攻击者不会急着关 —— 他要等回执判断自己有没有成功。
    //    这里改成"先读回执，读完再关"。

    // 接收通道应当**收不到任何数据**（连 End 都不该是 ok:true）
    let mut got_data = false;
    let mut ack_ok = false;
    let t0 = std::time::Instant::now();
    while t0.elapsed() < Duration::from_secs(5) {
        match tokio::time::timeout(Duration::from_secs(2), chunks.recv()).await {
            Ok(Ok(FileChunk::Data { .. })) => {
                got_data = true;
                break;
            }
            Ok(Ok(FileChunk::End { ok, .. })) => {
                ack_ok = ok;
                break;
            }
            Ok(Err(_)) | Err(_) => break,
        }
    }

    // 冒充者那边应当收到 ok:false 的回执
    let mut denied = false;
    match tokio::time::timeout(
        Duration::from_secs(5),
        read_json_frame::<FileAck>(&mut incoming, FRAME_DONE),
    )
    .await
    {
        Ok(Ok(ack)) => {
            denied = !ack.ok;
            println!("  冒充者收到的回执: ok={} reason={}", ack.ok, ack.reason);
        }
        Ok(Err(e)) => println!("  读回执出错: {e}"),
        Err(_) => println!("  读回执超时"),
    }
    let _ = outgoing.finish();

    println!("\n【攻击 3'】无关身份注入文件流（真实本地 QUIC）");
    println!("  {}", if !got_data { "✅ 没有任何数据到达接收通道" } else { "❌ 数据被注入了！" });
    println!("  {}", if !ack_ok { "✅ 接收通道没有报成功" } else { "❌ 接收通道判成功了" });
    println!("  {}", if denied { "✅ 冒充者被明确拒绝（ok:false）" } else { "⚠️ 未观察到拒绝回执" });

    let ok = !got_data && !ack_ok && denied;
    connection.close(0u8.into(), b"review done");
    router.shutdown().await?;
    impostor.close().await;
    if !ok {
        anyhow::bail!("文件流授权仍有缺口");
    }
    Ok(())
}

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(20), review()).await?
    })?;
    println!("\n总计 PASS=1 FAIL=0");
    Ok(())
}
