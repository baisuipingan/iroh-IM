#!/usr/bin/env python3
"""校验产物二进制是不是**目标平台的目标架构**。

用法：
    check-arch.py <binary> <osname>-<arch>
例：
    check-arch.py client-wasm/target/aarch64-unknown-linux-gnu/release/agent linux-arm64

为什么需要它（真的踩过）：
    release workflow 的构建命令漏了 `--target`，产物落在 `target/release/`
    并且是 **runner 自己的架构**。linux/arm64 与 windows/arm64 跑在 x86_64
    runner 上，于是编出的是 x86_64 二进制，却被打上 `-arm64` 的名字发布。
    这种包能解开、能过 sha256 校验、能在 runner 上跑，**唯独在目标机器上跑不起来**
    —— 靠人眼几乎发现不了。所以必须在这里断言。

为什么自己解析 magic bytes 而不调 `file`：
    Windows runner 的 Git Bash 里 `file`／`unzip` 都可能不存在
    （同一脚本已经因为 `zip: command not found` 挂过一次）。只用标准库最稳。
"""

import struct
import sys

# ⚠️ Windows 上 Python 的 stdout 默认是 cp1252，**打印 ✅ / 中文会直接抛
#    UnicodeEncodeError: 'charmap' codec can't encode character '\u2705'**，
#    于是"校验其实已经通过了、却在打印成功消息时崩掉"（真发生过，
#    两个 Windows job 都死在这）。这里强制 UTF-8 并放宽 errors，
#    保证输出永远不是失败原因。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):  # 极老的 Python 或非标准流
        pass


def arch_of(data: bytes) -> str:
    """从文件头解析架构。只认我们实际会产出的三种格式。"""
    # ---- PE / COFF（Windows）----
    if data[:2] == b"MZ":
        # e_lfanew 在 0x3C，指向 PE 签名；签名后 2 字节（跳过 "PE\0\0"）是 machine
        pe_off = struct.unpack_from("<I", data, 0x3C)[0]
        machine = struct.unpack_from("<H", data, pe_off + 4)[0]
        return {
            0x8664: "amd64",
            0xAA64: "arm64",
            0x014C: "i386",
        }.get(machine, f"pe-{machine:#x}")

    # ---- Mach-O（macOS）----
    # 只处理 64 位且非 fat：fa/ce 是 little-endian 的小端变体
    if data[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        cputype = struct.unpack_from("<I", data, 4)[0]
        return {
            0x0100000C: "arm64",
            0x01000007: "amd64",
        }.get(cputype, f"macho-{cputype:#x}")

    # ---- ELF（Linux）----
    if data[:4] == b"\x7fELF":
        machine = struct.unpack_from("<H", data, 18)[0]
        return {
            0x3E: "amd64",
            0xB7: "arm64",
        }.get(machine, f"elf-{machine:#x}")

    return "unknown"


def main() -> int:
    if len(sys.argv) != 3:
        print("用法：check-arch.py <binary> <osname>-<arch>", file=sys.stderr)
        return 2

    path, expect = sys.argv[1], sys.argv[2]
    # 只看前 4 KiB 就够：三种格式的机器字段都在很靠前的位置
    with open(path, "rb") as f:
        data = f.read(4096)

    got = arch_of(data)
    want = expect.split("-", 1)[1]

    if got != want:
        print(
            f"❌ 产物架构与目标不符：期望 {want}，实际 {got}（{path}）\n"
            f"   常见原因：构建命令漏了 `--target {expect}`，产物回落到 "
            f"target/release/ 且是 runner 自己的架构。",
            file=sys.stderr,
        )
        return 1

    print(f"  ✅ 架构校验通过：{expect} → 实际 {got}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
