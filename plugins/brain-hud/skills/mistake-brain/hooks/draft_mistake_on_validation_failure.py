#!/usr/bin/env python3
# version: 1.0.0
"""PostToolUseFailure hook: capture recognized validation-command failures as
pending candidates OUTSIDE the durable MISTAKES.md log.

## Why a separate hook (not an extension of draft_mistake_on_revert.py)

draft_mistake_on_revert.py owns worktree-discard signals (checkout --, restore,
clean -f). This hook owns tool-exit failures from validation commands (lint,
test runners, type-checkers). The two responsibilities are structurally different:

  - Revert hook: fires on PostToolUse, pattern-matches the command string,
    always indicates a mistake happened, writes directly to MISTAKES.md.
  - This hook: fires on PostToolUseFailure, checks exit-code type and command
    pattern, writes to a *pending* candidate file (not MISTAKES.md), because
    a validation failure alone is not yet a durable mistake.

## Candidate lifecycle

PostToolUseFailure fires
  -> recognized validation command + non-zero exit + not an interrupt
  -> write candidate to .claude/mb-pending-candidates.json (project-scoped)
  -> emit additionalContext: "failure captured; after fix, run /brain-hud:mistake-brain log
     to finalize or discard"

After Claude diagnoses and fixes:
  -> if durable lesson: /brain-hud:mistake-brain log (normal unrouted entry) +
     discard candidate from .json
  -> if transient, no lesson: discard candidate from .json, no MISTAKES.md write

## Project isolation -- fail-closed

Starting directory from CLAUDE_PROJECT_DIR env var, then payload.cwd.
Actual project root ALWAYS resolved via git rev-parse --show-toplevel.
If git resolution fails: exits 0, emits visible warning, no write.
All project-local paths derive from the resolved git root.
Project A failure cannot write state into project B.

## Validation allowlist -- deliberately narrow

Only unambiguous validation commands: lint, test runners, type-checkers,
build validators. General Bash failures are NOT captured.

## Exit-code semantics

PostToolUseFailure payload: error field starts with "Exit code N" for process
failures. is_interrupt == True means cancellation -- excluded. Timeouts and
permission errors have different error formats -- excluded by the startswith check.

Always exits 0. Hook failures must never interrupt the active task.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
import host_layout  # noqa: E402

PENDING_FILE = ".claude/mb-pending-candidates.json"
MAX_CANDIDATES = 20

VALIDATION_PATTERNS = [
    re.compile(r"\bwiki_lint(?:\.py)?\b"),
    re.compile(r"\bpytest\b"),
    re.compile(r"\bnpm\s+(?:test|run\s+test)\b"),
    re.compile(r"\btsc(?:\b|\.cmd)(?!\s*--version)"),
    re.compile(r"\bpylint\b"),
    re.compile(r"\bmypy\b"),
    re.compile(r"\bflake8\b"),
    re.compile(r"\bruff\s+check\b"),
    re.compile(r"\beslint\b"),
    re.compile(r"\bcargo\s+test\b"),
    re.compile(r"\bgo\s+test\b"),
    re.compile(r"\bmake\s+test\b"),
    re.compile(r"\bvitest\b"),
    re.compile(r"\bjest\b"),
]


def _resolve_git_root(start: Path) -> "Path | None":
    """Return absolute git root via git rev-parse --show-toplevel.

    Fails closed: returns None if not inside a git repo, git unavailable,
    or any subprocess error. Never falls back to start itself.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=start,
        )
        if result.returncode != 0:
            return None
        resolved = result.stdout.strip()
        return Path(resolved) if resolved else None
    except Exception:
        return None


def _matched_pattern(command: str) -> "str | None":
    for pat in VALIDATION_PATTERNS:
        if pat.search(command):
            return pat.pattern
    return None


def _load_candidates(pending_path: Path) -> list:
    if not pending_path.exists():
        return []
    try:
        data = json.loads(pending_path.read_text(encoding="utf-8"))
        return data.get("candidates", []) if isinstance(data, dict) else []
    except Exception:
        return []


def _save_candidates(pending_path: Path, candidates: list) -> None:
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.write_text(
        json.dumps({"candidates": candidates}, indent=2), encoding="utf-8"
    )


def _emit(context: str) -> None:
    print(
        json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUseFailure",
                "additionalContext": context,
            }
        })
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    tool_name = payload.get("tool_name", "")
    if tool_name not in ("Bash", "PowerShell"):
        return 0

    # Exclude interrupts/cancellations -- not durable lessons
    if payload.get("is_interrupt"):
        return 0

    error = payload.get("error", "")
    if not isinstance(error, str) or not error.startswith("Exit code"):
        return 0

    command = (payload.get("tool_input") or {}).get("command", "")
    if not command:
        return 0

    pattern = _matched_pattern(command)
    if pattern is None:
        return 0

    # -- The project: the same resolution as every other hook -------------------
    # The plugin runs this in every project: outside a mistake-brain one it is
    # silent and writes nothing.
    project_root = host_layout.project_root(payload)
    if not (project_root / "MISTAKES.md").is_file():
        return 0

    # -- One candidate per command ---------------------------------------------
    # Red runs are normal while working: the same command failing again updates
    # its candidate (count, latest error) instead of adding one, the file keeps
    # the newest MAX_CANDIDATES, and only the first capture gets the full note.
    pending_path = project_root / PENDING_FILE
    candidates = _load_candidates(pending_path)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    safe_command = command.strip().replace("\n", " ")[:300]
    error_summary = error.split("\n")[0][:120]

    same = next((c for c in candidates if c.get("command") == safe_command), None)
    if same is not None:
        candidates.remove(same)
        same.update(
            error_summary=error_summary,
            last_at=now_str,
            count=int(same.get("count", 1)) + 1,
        )
        candidates.append(same)
        _save_candidates(pending_path, candidates[-MAX_CANDIDATES:])
        _emit(f"[mistake-brain] still failing: {safe_command[:80]} (×{same['count']}); candidate updated in {PENDING_FILE}.")
        return 0

    candidates.append({
        "id": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "captured_at": now_str,
        "last_at": now_str,
        "count": 1,
        "command": safe_command,
        "error_summary": error_summary,
        "pattern_matched": pattern,
        "project_root": str(project_root),
    })
    _save_candidates(pending_path, candidates[-MAX_CANDIDATES:])

    _emit(
        f"[mistake-brain] Validation failure captured as a CANDIDATE "
        f"(not yet a durable mistake).\n"
        f"  Command: {safe_command[:80]}\n"
        f"  Error:   {error_summary}\n"
        f"  Stored in: {PENDING_FILE}\n\n"
        "After diagnosing and confirming the fix with a successful rerun:\n"
        "  - If a reusable prevention lesson exists: run /brain-hud:mistake-brain log "
        "to finalize as a normal MISTAKES.md entry, then delete the candidate "
        f"from {PENDING_FILE}.\n"
        "  - If transient (typo, env issue, no lasting lesson): delete the "
        f"candidate from {PENDING_FILE} without writing to MISTAKES.md."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
