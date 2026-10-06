#!/usr/bin/env python3
"""Isolated throughput test: [port] [MiB or comma-separated MiB] [opfs|mem].
PLAYWRIGHT_MODULE selects an installed Playwright module.
mem is a no-write diagnostic, not a verified file delivery.
BENCH_MIN_KIBPS defaults to 128; set 0 for measurement without a speed assertion.
"""
import os
from pathlib import Path
import subprocess
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
sizes = sys.argv[2] if len(sys.argv) > 2 else '0.5,2,8'
mode = sys.argv[3] if len(sys.argv) > 3 else 'opfs'
if mode not in ('opfs', 'mem'):
    raise SystemExit('mode must be opfs or mem')
environment = dict(os.environ)
environment.setdefault('E2E_SITE', f'http://127.0.0.1:{port}')
environment['BENCH_SIZES'] = sizes
environment['BENCH_SINK'] = 'noop' if mode == 'mem' else 'opfs'
root = Path(__file__).resolve().parent.parent
raise SystemExit(subprocess.call(['node', str(root / 'scripts/transfer-bench.mjs')], env=environment, cwd=root))
