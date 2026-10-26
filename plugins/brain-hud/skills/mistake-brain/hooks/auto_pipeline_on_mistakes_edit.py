#!/usr/bin/env python3
# version: 1.3.0
"""PostToolUse hook: drive the full log→route→promote pipeline automatically.

Fires on Edit, Write, and MultiEdit tool calls. When MISTAKES.md is modified:

- If 3 or more unrouted entries accumulate → runs validate_mistakes.py (the
  Checker) to surface format violations while context is still fresh, then
  instructs Claude to run /brain-hud:mistake-brain route. Routing is batched at ≥3 to
  avoid interrupting every single log write. For immediate routing after 1 or
  2 entries, use /brain-hud:mistake-brain route directly. Validation is non-blocking —
  auto-draft entries have placeholder text, not empty fields, so they pass the
  Checker; real format gaps (missing required fields, unknown Type) are flagged.
- If no unrouted entries remain (i.e., this was a routing pass) → runs
  check_repetition.py; if 3+ repeats are found, instructs Claude to surface
  them for promotion review via /brain-hud:mistake-brain promote.

Together with draft_mistake_on_revert.py (which auto-drafts entries) and
brief_on_session_start.py (which reminds about inbox at session open), this
closes the loop: log → validate → route → promote all fire automatically.
Routing is batched (≥3 threshold) to stay non-intrusive. The user still
approves before any rule reaches CLAUDE.md.

Always exits 0 — a hook failure must never interrupt the active task.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

def _is_brain_project(project_dir: Path) -> bool:
    return (project_dir / "MISTAKES.md").is_file() or (project_dir / ".agent-brain").is_dir()


STATUS_UNROUTED_RE = re.compile(r"^- \*\*Status:\*\*\s*unrouted\s*$", re.MULTILINE)
EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "StrReplace"})


def _file_path(payload: dict) -> str:
    tool_input = payload.get("tool_input") or {}
    if isinstance(tool_input, dict):
        return (
            payload.get("file_path")
            or tool_input.get("file_path")
            or tool_input.get("path")
            or ""
        )
    return payload.get("file_path") or ""


def _is_mistakes_edit(payload: dict) -> bool:
    """Return True iff the tool call modified a file named MISTAKES.md."""
    tool_name = payload.get("tool_name", "")
    if tool_name and tool_name not in EDIT_TOOLS:
        return False
    file_path = _file_path(payload)
    # Normalise separators so both / and \ work on Windows.
    return file_path.replace("\\", "/").endswith("MISTAKES.md")


def _count_unrouted(mistakes_path: Path) -> int:
    if not mistakes_path.exists():
        return 0
    text = mistakes_path.read_text(encoding="utf-8")
    return len(STATUS_UNROUTED_RE.findall(text))


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def _skill_scripts_dir(project_dir: Path) -> Path | None:
    """The scripts of this same skill version: never a copy elsewhere, which
    may be older (a stale global copy is how the index lost its counts)."""
    return SCRIPTS_DIR if SCRIPTS_DIR.is_dir() else None


def _is_lesson_edit(payload: dict) -> bool:
    """True when the tool call wrote a PARA lesson file in .agent-brain/shared/."""
    tool_name = payload.get("tool_name", "")
    if tool_name and tool_name not in EDIT_TOOLS:
        return False
    path = _file_path(payload).replace("\\", "/")
    return "/.agent-brain/shared/" in f"/{path}" and path.endswith(".md") and not path.endswith("/MEMORY.md")


def _rebuild_index(project_dir: Path) -> bool:
    """Refresh MEMORY.md's counts and dates from the lesson files. Never raises."""
    try:
        if str(SCRIPTS_DIR) not in sys.path:
            sys.path.insert(0, str(SCRIPTS_DIR))
        import rebuild_index

        return rebuild_index.rebuild(project_dir)
    except Exception:
        return False


def _run_validate(project_dir: Path) -> list[str]:
    """Run validate_mistakes.py. Returns a list of violation lines, or [] if clean."""
    scripts_dir = _skill_scripts_dir(project_dir)
    if not scripts_dir:
        return []
    script = scripts_dir / "validate_mistakes.py"
    mistakes = project_dir / "MISTAKES.md"
    if not script.exists() or not mistakes.exists():
        return []
    try:
        result = subprocess.run(
            [sys.executable, str(script), str(mistakes)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0 and result.stdout.strip():
            # Return only the violation lines (skip the summary line)
            lines = result.stdout.strip().splitlines()
            return [ln for ln in lines if ln.strip().startswith("line ")]
    except Exception:
        pass
    return []


def _run_check_repetition(project_dir: Path) -> dict | None:
    """Run check_repetition.py --json. Returns parsed output, or None on error."""
    scripts_dir = _skill_scripts_dir(project_dir)
    if not scripts_dir:
        return None
    script = scripts_dir / "check_repetition.py"
    mistakes = project_dir / "MISTAKES.md"
    if not script.exists() or not mistakes.exists():
        return None
    try:
        result = subprocess.run(
            [sys.executable, str(script), str(mistakes), "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return None


def _append_log(project_dir: Path, action: str) -> None:
    """Append a one-line entry to .claude/hooks.log (never raises)."""
    try:
        log_path = project_dir / ".claude" / "hooks.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with log_path.open("a", encoding="utf-8") as f:
            f.write(f"{ts} [auto-pipeline] {action}\n")
    except Exception:
        pass


def _emit(context: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": context,
                }
            }
        )
    )


def process(payload: dict, project_dir: Path) -> str | None:
    """Return additional context for a MISTAKES.md edit, or None if nothing to say.

    A lesson file written (route's step 4) refreshes the index from disk, so its
    counts and dates are right even when step 6 is skipped.
    """
    if _is_lesson_edit(payload):
        if _rebuild_index(project_dir):
            _append_log(project_dir, "lesson file edited → MEMORY.md counts refreshed")
        return None
    if not _is_mistakes_edit(payload):
        return None

    mistakes_path = project_dir / "MISTAKES.md"
    unrouted = _count_unrouted(mistakes_path)

    if unrouted >= 3:
        violations = _run_validate(project_dir)
        violation_note = (
            f", {len(violations)} violation(s)" if violations else ", clean"
        )
        _append_log(
            project_dir,
            f"MISTAKES.md edited: {unrouted} unrouted (≥3 threshold) → routing prompt emitted{violation_note}",
        )
        parts = [
            f"[mistake-brain] {unrouted} unrouted entries in MISTAKES.md (batched at 3+)."
        ]
        if violations:
            parts.append(
                f"⚠️ Checker found {len(violations)} format violation(s) — fix these fields "
                "before or during routing (auto-draft placeholders are fine; real empty fields are not):"
            )
            parts.extend(f"  {v}" for v in violations)
        parts.append(
            "Run /brain-hud:mistake-brain route now to classify into PARA memory. "
            "Do this before completing the turn — routing is low-stakes and should happen "
            "immediately so lessons are captured while context is fresh."
        )
        return "\n".join(parts)

    if unrouted > 0:
        return None

    result = _run_check_repetition(project_dir)
    if not result:
        _append_log(
            project_dir,
            "MISTAKES.md edited: 0 unrouted, repetition check skipped (script error)",
        )
        return None

    groups = result.get("repeated_groups", [])
    _append_log(
        project_dir,
        f"MISTAKES.md edited: 0 unrouted → repetition check: {len(groups)} group(s) with 3+ repeats",
    )
    if not groups:
        return None

    lines = [
        f"[mistake-brain] {len(groups)} pattern(s) with 3+ repeats — ready for promotion. "
        "Run /brain-hud:mistake-brain promote to review them and propose a rule for CLAUDE.md "
        "(you will see the exact diff before anything is written):"
    ]
    for g in groups:
        key = g.get("representative_cluster_key", "")[:80]
        count = g.get("count", "?")
        kind = g.get("type", "?")
        lines.append(f"  - [{count}× {kind}] {key}")
    return "\n".join(lines)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    project_dir = Path(
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    )
    if not _is_brain_project(project_dir):
        return 0
    context = process(payload, project_dir)
    if context:
        _emit(context)
    return 0


if __name__ == "__main__":
    sys.exit(main())
