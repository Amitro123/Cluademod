#!/usr/bin/env python3
# version: 1.0.0
"""Stop hook: detect git revert/reset at end of each turn (once per turn, not per command).

Replaces PostToolUse:Bash for revert detection. Python starts once per turn
instead of once per bash command — ~90% latency reduction for heavy bash sessions.

Detection (two mechanisms, state-based):
  1. HEAD moved to a new commit whose subject starts with "Revert" → git revert
  2. Reflog tip changed to a "reset: moving to ..." entry → git reset --hard

State file: .claude/mb-head-state.txt
  Line 1: HEAD SHA seen at end of previous turn
  Line 2: reflog@{0} message seen at end of previous turn

Known limitation vs the old PostToolUse:Bash predecessor:
  - `git checkout -- <path>` and `git clean -f` are NOT detected (no commit,
    no reflog entry). These fall back to skill-description trigger recall
    (27-73% depending on CLAUDE.md reinforcement).
  - git revert and git reset --hard are caught reliably.

Always exits 0. Never blocks Claude's response.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"
_STATE_FILE = ".claude/mb-head-state.txt"


def _git(args: list[str], cwd: Path) -> str | None:
    """Run a git command; return stdout or None on error."""
    try:
        r = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def _read_state(project_dir: Path) -> tuple[str | None, str | None]:
    """Return (last_head, last_reflog_count). Both None on first run."""
    try:
        lines = (project_dir / _STATE_FILE).read_text(encoding="utf-8").splitlines()
        return (lines[0] or None), (lines[1] if len(lines) > 1 else None)
    except Exception:
        return None, None


def _write_state(project_dir: Path, head: str, reflog_count: str) -> None:
    try:
        path = project_dir / _STATE_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{head}\n{reflog_count}", encoding="utf-8")
    except Exception:
        pass


def _detect(
    project_dir: Path,
    old_head: str | None,
    old_reflog: str | None,
) -> tuple[str | None, str | None]:
    """Return (event_type, description) or (None, None).

    event_type is "revert" or "reset".
    """
    new_head = _git(["rev-parse", "HEAD"], project_dir)
    new_reflog = _git(["reflog", "-1", "--format=%gs"], project_dir) or ""
    reflog_entries = _git(["reflog", "--format=%gD"], project_dir) or ""
    new_reflog_count = len(reflog_entries.splitlines())

    if not new_head:
        return None, None  # not a git repo or empty repo

    _write_state(project_dir, new_head, str(new_reflog_count))

    if old_head is None:
        return None, None  # first run — just established baseline

    # 1. HEAD moved → check if it's a revert commit
    if new_head != old_head:
        msg = _git(["log", "-1", "--format=%s", new_head], project_dir) or ""
        if msg.startswith("Revert"):
            body = _git(["log", "-1", "--format=%b", new_head], project_dir) or ""
            m = re.search(r"This reverts commit ([0-9a-f]{7,})", body)
            suffix = f" (reverted {m.group(1)[:8]})" if m else ""
            return "revert", f"{msg}{suffix}"

    # 2. A new reflog entry is a reset. Count distinguishes identical messages.
    try:
        old_reflog_count = int(old_reflog) if old_reflog is not None else None
    except ValueError:
        old_reflog_count = None  # migrate legacy message-based state safely
    if (
        old_reflog_count is not None
        and new_reflog_count > old_reflog_count
        and new_reflog.startswith("reset:")
    ):
        return "reset", new_reflog

    return None, None


def _draft_entry(project_dir: Path, event_type: str, description: str) -> bool:
    """Write an auto-draft MISTAKES.md entry. Returns True if written."""
    mistakes_path = project_dir / "MISTAKES.md"
    if not mistakes_path.exists():
        return False
    text = mistakes_path.read_text(encoding="utf-8")
    if MARKER not in text:
        return False

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    verb = "Revert commit" if event_type == "revert" else "Hard reset"
    entry = (
        f"## [{now}] [auto-draft] {verb} detected: `{description[:120]}`\n"
        f"- **Type:** mistake\n"
        f"- **What happened:** [auto-draft, needs detail] {verb} ran — "
        f"this hook detected *that* it happened, not *why*. Fill in the real story.\n"
        f"- **Root cause:** [auto-draft, needs detail]\n"
        f"- **Consequence:** [auto-draft, needs detail]\n"
        f"- **Prevention rule:** [auto-draft, needs detail]\n"
        f"- **PARA route:** unrouted\n"
        f"- **Status:** unrouted\n"
    )
    text = text.replace(MARKER, MARKER + "\n\n" + entry, 1)
    text = re.sub(r"\n{3,}", "\n\n", text)
    mistakes_path.write_text(text, encoding="utf-8")
    return True


def _emit(context: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "Stop",
                    "additionalContext": context,
                }
            }
        )
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    project_dir = Path(
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    )
    # The plugin runs this in every project: outside a mistake-brain one it
    # does nothing, and writes no state file.
    if not (project_dir / "MISTAKES.md").is_file():
        return 0

    old_head, old_reflog = _read_state(project_dir)
    event_type, description = _detect(project_dir, old_head, old_reflog)

    if not event_type:
        return 0

    if _draft_entry(project_dir, event_type, description):
        _emit(
            f"[mistake-brain] auto-drafted a MISTAKES.md entry for: `{description}`\n"
            "1 unrouted entry now in the inbox. "
            "Fill in the [auto-draft] placeholders and run /brain-hud:mistake-brain route "
            "to classify it into PARA memory before completing the turn."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
