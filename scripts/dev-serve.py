#!/usr/bin/env python3
"""本地开发静态服务：frontend 根目录 + 强制不缓存。

为什么需要：`python -m http.server` 会带 Last-Modified，浏览器会缓存 ES 模块，
改了 JS 却还在跑旧代码（本项目踩过这个坑，浪费了很多时间）。

用法：python3 scripts/dev-serve.py [端口]   （默认 8099）
"""
import functools
import http.server
import mimetypes
import pathlib
import socketserver
import sys

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")

ROOT = pathlib.Path(__file__).resolve().parent.parent / "frontend"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    # ⚠️ 必须调大 accept 队列（默认只有 5）。
    #
    # 页面的 ES 模块是**一次性并行**拉取的（index.html → main.js → ~25 个模块
    # + 3.6 MB 的 wasm），Chrome 会同时开 6~10 条连接。默认 backlog=5 一旦溢出，
    # 内核**直接 RST** 掉多出来的连接，浏览器侧报 `ERR_CONNECTION_RESET`
    # / `ERR_SOCKET_NOT_CONNECTED`。
    #
    # 症状极具迷惑性：页面停在"启动中"、`window.__state` 永远不出现，
    # 而同一个文件用 curl 怎么拉都是 200（单个请求永远不会打满队列）——
    # 实测在 theme-sync / file-history 上稳定复现，而换成线上域名就好。
    request_queue_size = 128
    daemon_threads = True


if __name__ == "__main__":
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}  (no-cache)")
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
