#!/usr/bin/env python3
"""无头浏览器验证用的静态服务 + 结果收集器。

- 把 frontend/ 目录当静态服务（正确给出 application/wasm）
- 接收页面 POST 到 /__result 的状态快照并打印（无头 Chrome 只负责跑页面）

用法：python3 scripts/serve_and_collect.py <站点目录> [端口]
"""
import http.server
import json
import mimetypes
import socketserver
import sys

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")

DIR = sys.argv[1] if len(sys.argv) > 1 else "frontend"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8099


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0) or 0)
        body = self.rfile.read(length)
        tag = "?"
        try:
            data = json.loads(body)
            tag = data.get("tag", "?")
            print(f"\n===== 页面状态回传 (tag={tag}) =====", flush=True)
            print(json.dumps(data, ensure_ascii=False, indent=2)[:6000], flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"\n(回传解析失败: {exc}) 原始: {body[:200]!r}", flush=True)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"serving {DIR} on http://127.0.0.1:{PORT} （等待页面回传…）", flush=True)
        httpd.serve_forever()
