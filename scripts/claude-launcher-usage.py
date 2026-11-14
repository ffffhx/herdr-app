"""Optional, local-only Herdr statusLine adapter for explicit Claude launchers.

Install beside launch.py as usage_bridge.py, with claude-usage.cjs beside it.
It never launches Claude, queries an account, or reads authentication files.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent


def prepare(kind, source, settings_file=None):
    if not re.fullmatch(r"t[0-9a-z]+", os.environ.get("HC_TERMINAL_ID", "")):
        return None
    node = shutil.which("node")
    script = ROOT / "claude-usage.cjs"
    if not node or not script.is_file():
        return None
    try:
        result = subprocess.run(
            [node, str(script), "register", kind],
            input=json.dumps({"previous": source.get("statusLine"),
                              "settingsFile": str(settings_file) if settings_file else None,
                              "launcherPid": os.getpid()}),
            encoding="utf-8", capture_output=True, timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            check=True,
        )
        value = json.loads(result.stdout)
        return value if isinstance(value, dict) and value.get("descriptor") and value.get("statusLine") else None
    except (OSError, subprocess.SubprocessError, ValueError):
        # An optional display must not affect account login or the network guard.
        return None


def finish(registration):
    if not registration:
        return
    node = shutil.which("node")
    if not node:
        return
    try:
        subprocess.run([node, str(ROOT / "claude-usage.cjs"), "end", registration["descriptor"]],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                       check=False)
    except (OSError, subprocess.SubprocessError):
        pass
