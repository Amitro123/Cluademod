#!/usr/bin/env python3
"""Cursor sessionStart adapter.

brief_on_session_start.py prints Claude Code's hookSpecificOutput. Cursor reads
additional_context. This file selects the Cursor index and translates that
output. It never chooses where lessons are written. Always exits 0.

Register in ~/.cursor/hooks.json:
    {"version": 1, "hooks": {"sessionStart": [{"command": "python \"<skill>/hooks/cursor_brief.py\"", "timeout": 15}]}}
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_HOOKS = Path(__file__).resolve().parent
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))


def _project_dir(payload: dict) -> Path:
    roots = payload.get("workspace_roots") or []
    if isinstance(roots, list) and roots and roots[0]:
        return Path(roots[0])
    cwd = payload.get("cwd")
    if cwd:
        return Path(cwd)
    return Path(".")


def main() -> int:
    os.environ["MISTAKE_BRAIN_HOST"] = "cursor"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    try:
        import brief_on_session_start as brief

        text = brief.build_briefing(_project_dir(payload))
    except Exception:
        text = ""
    if text:
        print(json.dumps({"additional_context": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
