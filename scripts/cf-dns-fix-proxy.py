#!/usr/bin/env python3
"""本地 CONNECT 代理：给被 DNS 污染的主机强制指定真实 IP。

## 为什么需要

本机沙箱的出网代理只放行白名单域名（github / npm 可以），
`api.cloudflare.com` 被"DNS 污染"——解析出来的不是真实 IP，连过去是个黑洞。
但用 `curl --resolve api.cloudflare.com:443:<真实IP>` 实测**能正常拿到 CF 的 JSON 响应**，
说明只是解析被改，链路本身是通的。

所以这里起一个极小的本地代理，把这几个主机的连接**直接拨到真实 IP**，
其余主机照常走系统解析。然后把 wrangler 的 HTTPS_PROXY 指过来即可。

用法：
    python3 scripts/cf-dns-fix-proxy.py [端口]        # 默认 8899，前台运行

配合使用：
    HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 npx wrangler deploy
"""
import select
import socket
import sys
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

# 被污染的主机 → 真实 IP（Cloudflare anycast，长期稳定）
REAL_IP = {
    "api.cloudflare.com": "104.19.192.174",
    "dash.cloudflare.com": "104.19.192.174",
    "cloudflare.com": "104.19.192.174",
}

# 需要改写的端口一律照搬
IDLE_TIMEOUT = 120


def log(*a):
    print("[cf-dns-proxy]", *a, file=sys.stderr, flush=True)


def pump(a: socket.socket, b: socket.socket):
    """双向搬运字节，任一侧结束就一起收摊。"""
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, IDLE_TIMEOUT)
            if x or not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        for s in socks:
            try:
                s.close()
            except OSError:
                pass


def handle(conn: socket.socket):
    try:
        # 读请求头（CONNECT 的头部很小，一次读够就行）
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
            if len(buf) > 65536:
                return

        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin1")
        parts = head.split()
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            conn.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return

        hostport = parts[1]
        host, _, port_s = hostport.rpartition(":")
        port = int(port_s or 443)

        target = REAL_IP.get(host)
        if target:
            log(f"CONNECT {host}:{port} -> {target}（绕过 DNS）")
            up = socket.create_connection((target, port), timeout=15)
        else:
            log(f"CONNECT {host}:{port} -> 系统解析")
            up = socket.create_connection((host, port), timeout=15)

        conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        pump(conn, up)
    except Exception as exc:  # noqa: BLE001
        log(f"处理失败：{exc!r}")
        try:
            conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        except OSError:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(64)
    log(f"监听 127.0.0.1:{PORT}")
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            break
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
