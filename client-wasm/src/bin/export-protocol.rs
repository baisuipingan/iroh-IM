//! 把协议类型写成 TS 文件：`export-protocol <输出路径>...`（可给多个路径）。
//!
//! 用途见 `iroh_web::ts_export` 的模块说明；一般通过
//! `bash scripts/gen-protocol-types.sh` 调用，不要手工跑。
use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = iroh_web::ts_export::render()?;
    let paths: Vec<String> = env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("用法：export-protocol <输出路径>...");
        std::process::exit(2);
    }
    for path in &paths {
        if let Some(dir) = Path::new(path).parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, &out)?;
        println!("已写入 {path}（{} 字节）", out.len());
    }
    Ok(())
}
