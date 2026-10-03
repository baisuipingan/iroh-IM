FROM debian:bookworm-slim

# roomd 是客户端：不监听任何端口，只主动连中继
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ `roomd` 必须由 `bash scripts/build-wasm.sh native` 生成到仓库根的 `dist/`，
#    再由部署步骤拷到本目录（README 第 1 步）。
#    这个文件**不再随仓库分发**（复检缺陷 F3）：以前仓库里放了一份 9-29 的旧二进制，
#    而这一行是 `COPY` 进镜像的 —— `docker compose up -d --build` 会**成功**，
#    但容器里跑的是那份旧锚点（本机 /usr/local/bin 改了也没用，那正是踩过的坑）。
#    现在缺文件时 COPY 会**明确报错**，比"静默上线旧代码"好得多。
COPY roomd /usr/local/bin/roomd

ENV ROOMD_DATA_DIR=/data \
    RUST_LOG=info

VOLUME ["/data"]

# 启动后第一行会打印 ROOMD_ENDPOINT_ID=...（把它写进前端配置）
ENTRYPOINT ["/usr/local/bin/roomd"]
