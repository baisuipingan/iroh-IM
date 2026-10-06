"""Run isolated relay configuration regression without changing source files."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
sys.exit(subprocess.call(['node', str(root / 'scripts/e2e/relay-enabled.mjs')], cwd=root))
