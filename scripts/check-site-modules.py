#!/usr/bin/env python3
"""检查部署产物里的前端模块引用是否完整。

## 为什么需要

本地开发时源目录是齐全的，某个文件被错误地排除掉**根本发现不了**——
只有部署上去、浏览器请求 404 才会暴露（真实踩过：`js/probe.js` 被误排除，
线上 `main.js` 直接 404，页面卡在"启动中"）。

所以这个检查跑在**部署产物目录**上：逐个解析 JS 里的相对 import，
确认目标文件确实存在。

用法：python3 scripts/check-site-modules.py <部署目录>
退出码：0 = 全部完整；1 = 有缺失（并打印出来）
"""
import os
import re
import sys

PAT = re.compile(r"""from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]""")


def main() -> int:
    if len(sys.argv) < 2:
        print("用法：check-site-modules.py <部署目录>", file=sys.stderr)
        return 2
    out = os.path.abspath(sys.argv[1])
    bad = []

    for root, _, files in os.walk(out):
        for name in files:
            if not name.endswith(".js"):
                continue
            path = os.path.join(root, name)
            try:
                src = open(path, encoding="utf-8").read()
            except OSError:
                continue
            for m in PAT.finditer(src):
                spec = m.group(1) or m.group(2)
                target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
                if not os.path.exists(target):
                    bad.append(f"{os.path.relpath(path, out)} -> {spec}")

    if bad:
        for line in bad:
            print(line)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
