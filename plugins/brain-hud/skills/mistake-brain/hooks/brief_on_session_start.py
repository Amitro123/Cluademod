#!/usr/bin/env python3
# version: 1.1.0
"""SessionStart hook: inject a bounded MEMORY.md briefing so retrieval does
not depend on the model choosing to read the index.

v1.1 additions (automatic pipeline):
- If unrouted entries exist, appends an explicit routing instruction so
  leftover inbox entries from a prior session get routed at the start of
  this one, without any manual command.
- Checks the last-dream date in MEMORY.md; if > DREAM_NUDGE_DAYS old (or
  MEMORY.md is within DREAM_LINE_WARN lines of the 200-line cap), appends
  a dream reminder.

Always exits 0 — a missing MEMORY.md or unreadable inbox must never fail
the session. Truncates MEMORY.md at 200 lines as a hard cap. Inbox stats
are grepped from field lines only (never the MISTAKES.md body).
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
import host_layout  # noqa: E402

MAX_MEMORY_LINES = 200
DREAM_LINE_WARN = 170  # suggest dream when MEMORY.md is within 30 lines of cap
DREAM_NUDGE_DAYS = 7  # suggest dream when last dream was > N days ago
DREAM_MIN_LINES = (
    10  # below this line count, MEMORY.md is empty/freshly-init — skip dream nudge
)
NOT_INITIALIZED = (
    "[mistake-brain] This project's memory is not set up: no "
    ".agent-brain/shared/MEMORY.md and no lesson files. "
    "Run /brain-hud:mistake-brain init."
)
STATUS_UNROUTED_RE = re.compile(r"^- \*\*Status:\*\*\s*unrouted\s*$", re.MULTILINE)
STATUS_VALUE_RE = re.compile(r"^- \*\*Status:\*\*\s*(\S+)\s*$", re.MULTILINE)
_USABLE_STATUS = {"unrouted", "routed", "promoted"}
TYPE_RE = re.compile(r"^- \*\*Type:\*\*\s*(\S+)\s*$", re.MULTILINE)
HEADER_RE = re.compile(r"^## \[([^\]]+)\] (.+)$", re.MULTILINE)
ENTRY_SPLIT_RE = re.compile(r"(?=^## \[)", re.MULTILINE)


def _memory_path(project_dir: Path) -> Path:
    return host_layout.memory_path(project_dir, host_layout.detect_host())


def _read_memory(project_dir: Path) -> tuple[str, bool] | None:
    path = _memory_path(project_dir)
    if not path.exists():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    truncated = len(lines) > MAX_MEMORY_LINES
    return "\n".join(lines[:MAX_MEMORY_LINES]), truncated


def _status_defects(project_dir: Path) -> list[str]:
    """Titles whose Status a router cannot match. Does not rewrite the inbox."""
    mistakes = project_dir / "MISTAKES.md"
    if not mistakes.exists():
        return []
    text = mistakes.read_text(encoding="utf-8")
    titles: list[str] = []
    for block in ENTRY_SPLIT_RE.split(text):
        if not block.startswith("## ["):
            continue
        header = HEADER_RE.search(block)
        if not header:
            continue
        found = STATUS_VALUE_RE.search(block)
        if found and found.group(1).lower() in _USABLE_STATUS:
            continue
        titles.append(header.group(2).strip())
    return titles


def _inbox_stats(project_dir: Path) -> tuple[int, list[str]]:
    mistakes = project_dir / "MISTAKES.md"
    if not mistakes.exists():
        return 0, []
    text = mistakes.read_text(encoding="utf-8")
    unrouted = 0
    handoff_titles: list[str] = []
    for block in ENTRY_SPLIT_RE.split(text):
        if not block.startswith("## ["):
            continue
        if not STATUS_UNROUTED_RE.search(block):
            continue
        unrouted += 1
        type_m = TYPE_RE.search(block)
        if type_m and type_m.group(1) == "handoff":
            header_m = HEADER_RE.search(block)
            if header_m:
                handoff_titles.append(header_m.group(2).strip())
    return unrouted, handoff_titles


# Matches the dream date in two formats dream.md may produce:
#   ## Last dream\n2026-08-20 — summary…      (date on next line)
#   ## Last dream: 2026-08-20 — summary…      (date inline after colon)
# Both yield the YYYY-MM-DD group at position 1.
_LAST_DREAM_RE = re.compile(
    r"^## Last dream(?::\s*|\s*\n)(\d{4}-\d{2}-\d{2})", re.MULTILINE
)


def _last_dream_date(memory_text: str) -> date | None:
    m = _LAST_DREAM_RE.search(memory_text)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d").date()
    except ValueError:
        return None


def _dream_nudge(memory_text: str, memory_line_count: int) -> str | None:
    """Return a one-line dream reminder, or None if not needed."""
    reasons: list[str] = []
    if memory_line_count >= DREAM_LINE_WARN:
        remaining = MAX_MEMORY_LINES - memory_line_count
        reasons.append(
            f"MEMORY.md is {memory_line_count} lines (cap {MAX_MEMORY_LINES}, {remaining} left)"
        )
    last = _last_dream_date(memory_text)
    if last is None and memory_line_count > DREAM_MIN_LINES:
        # Memory has content but no dream date recorded — hasn't been dreamt yet.
        reasons.append("no dream pass recorded yet")
    elif last is not None:
        today = date.today()
        gap = (today - last).days
        if gap > DREAM_NUDGE_DAYS:
            reasons.append(f"last dream was {gap} days ago ({last})")
    if not reasons:
        return None
    return "Run /brain-hud:mistake-brain dream — " + "; ".join(reasons) + "."


def _refresh_index(project_dir: Path) -> bool:
    """Rebuild MEMORY.md's counts and dates from the lesson files (derived data,
    so writing it here is safe: two sessions write the same thing). Never raises."""
    try:
        import rebuild_index

        return rebuild_index.rebuild(project_dir)
    except Exception:
        return False


def _lesson_files(project_dir: Path) -> bool:
    root = host_layout.lesson_root(project_dir)
    return any(
        (root / folder).is_dir() and any((root / folder).rglob("*.md"))
        for folder in host_layout.PARA_FOLDERS
    )


def build_briefing(project_dir: Path) -> str:
    # The index is rebuilt from disk first: a missing MEMORY.md, a lesson file
    # it doesn't list, or a count that drifted are fixed, not just reported.
    rebuilt = False
    if _lesson_files(project_dir) or _memory_path(project_dir).exists():
        rebuilt = _refresh_index(project_dir)
    memory = _read_memory(project_dir)
    if memory is None:
        return NOT_INITIALIZED
    memory_text, truncated = memory
    unrouted, handoffs = _inbox_stats(project_dir)

    parts = ["# mistake-brain session briefing", "", "## MEMORY.md", memory_text]
    if truncated:
        parts.append("[truncated]")
    if rebuilt:
        parts.append("(The index's lesson counts and dates were refreshed from the lesson files.)")
    parts.extend(["", "## Inbox", f"- unrouted entries: {unrouted}"])
    if handoffs:
        parts.append("- unrouted handoffs:")
        parts.extend(f"  - {title}" for title in handoffs)
    else:
        parts.append("- unrouted handoffs: none")

    defects = _status_defects(project_dir)
    if defects:
        shown = ", ".join(defects[:5])
        extra = len(defects) - 5
        more = f" and {extra} more" if extra > 0 else ""
        parts.append(
            f"- Inbox format: {len(defects)} entr{'y' if len(defects) == 1 else 'ies'} "
            f"with no usable Status ({shown}{more}). Not counted above and not routed. "
            "Add a Status field; do not infer one from the body."
        )
    if host_layout.index_gate_enabled():
        parts.append(
            "- Index gate is on (MISTAKE_BRAIN_INDEX_GATE=1). Route still writes "
            "the shared lesson file. Add the MEMORY.md line only after the user "
            "approves that lesson. Both harness indexes get that same line."
        )

    # Automatic pipeline nudges — make route/dream happen without manual commands.
    nudges: list[str] = []
    if unrouted > 0:
        nudges.append(
            f"ACTION REQUIRED: {unrouted} unrouted entr{'y' if unrouted == 1 else 'ies'} "
            "in the inbox. Run /brain-hud:mistake-brain route now to classify them into PARA memory."
        )
    memory_line_count = len(memory_text.splitlines())
    dream_msg = _dream_nudge(memory_text, memory_line_count)
    if dream_msg:
        nudges.append(dream_msg)

    if nudges:
        parts.extend(["", "## Pending actions"])
        parts.extend(f"- {n}" for n in nudges)

    parts.extend(
        [
            "",
            "Do not read PARA files or MISTAKES.md body for retrieval. "
            "Use /brain-hud:mistake-brain recall to load at most 2 matching PARA files.",
        ]
    )
    return "\n".join(parts)


def build_session_output(project_dir: Path) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": build_briefing(project_dir),
        }
    }


def main_for(project_dir: Path) -> int:
    # The plugin runs this in every project; one without mistake-brain gets no briefing.
    if not host_layout.is_brain_project(project_dir):
        return 0
    try:
        print(json.dumps(build_session_output(project_dir)))
    except Exception:
        fallback = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": NOT_INITIALIZED,
            }
        }
        try:
            print(json.dumps(fallback))
        except Exception:
            pass
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    project_dir = Path(
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    )
    return main_for(project_dir)


if __name__ == "__main__":
    sys.exit(main())
