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


if __name__ == "__main__":
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}  (no-cache)")
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
