"""Tests for brief_on_session_start.py

Run: pytest tests/scripts/test_brief_on_session_start.py -v
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

HOOKS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "hooks"
)
sys.path.insert(0, str(HOOKS_DIR))

import brief_on_session_start  # noqa: E402

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"

MEMORY_HEADER = """\
# MEMORY.md — shared session index

## Projects
- [Project] Projects/auth.md — login flow lessons (2 lessons, last updated 2026-08-16)

## Areas
_(none yet)_

## Resources
_(none yet)_

## Archives
Archives: 0 files (not loaded at session start)

## Rules promoted so far
_(none yet)_
"""


def _write_memory(project: Path, text: str) -> Path:
    """Write the one shared MEMORY.md every harness reads."""
    path = project / ".agent-brain" / "shared" / "MEMORY.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _write_mistakes(project: Path, body: str) -> Path:
    path = project / "MISTAKES.md"
    path.write_text(
        f"# MISTAKES.md\n\n{MARKER}\n\n{body}",
        encoding="utf-8",
    )
    return path


def _context(payload: dict) -> str:
    return payload["hookSpecificOutput"]["additionalContext"]


def test_cursor_host_briefs_from_the_same_shared_index_as_claude(tmp_path, monkeypatch):
    """One shared MEMORY.md, read by every harness -- not a per-host copy."""
    _write_memory(tmp_path, MEMORY_HEADER)
    monkeypatch.setenv("MISTAKE_BRAIN_HOST", "cursor")
    cursor_ctx = _context(brief_on_session_start.build_session_output(tmp_path))
    monkeypatch.setenv("MISTAKE_BRAIN_HOST", "claude")
    claude_ctx = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "login flow lessons" in cursor_ctx
    assert "login flow lessons" in claude_ctx


def test_missing_memory_exits_zero_with_not_initialized_note(tmp_path):
    payload = brief_on_session_start.build_session_output(tmp_path)
    assert payload["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    ctx = _context(payload)
    assert "not set up" in ctx.lower()
    assert brief_on_session_start.main_for(tmp_path) == 0


def test_short_memory_is_injected_in_full(tmp_path):
    _write_memory(tmp_path, MEMORY_HEADER)
    payload = brief_on_session_start.build_session_output(tmp_path)
    ctx = _context(payload)
    assert "Projects/auth.md" in ctx
    assert "login flow lessons" in ctx
    assert "[truncated]" not in ctx


def test_memory_over_200_lines_is_truncated(tmp_path):
    lines = [f"line-{i}" for i in range(250)]
    _write_memory(tmp_path, "\n".join(lines) + "\n")
    payload = brief_on_session_start.build_session_output(tmp_path)
    ctx = _context(payload)
    assert "[truncated]" in ctx
    memory_block = ctx.split("## Inbox", 1)[0]
    # Cap applies to MEMORY.md content, not the wrapper headings.
    assert memory_block.count("line-") == 200
    assert "line-199" in ctx
    assert "line-200" not in ctx


def test_unrouted_count_uses_anchored_status_field(tmp_path):
    _write_memory(tmp_path, MEMORY_HEADER)
    _write_mistakes(
        tmp_path,
        "## [2026-08-16 11:00] Real unrouted\n"
        "- **Type:** mistake\n"
        "- **What happened:** something broke\n"
        "- **Status:** unrouted\n"
        "\n"
        "## [2026-08-16 10:00] Quoted illustration\n"
        "- **Type:** mistake\n"
        "- **What happened:** the field looks like `- **Status:** unrouted` as an example\n"
        "- **Status:** routed\n",
    )
    ctx = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "unrouted entries: 1" in ctx
    assert "something broke" not in ctx


def test_unrouted_handoff_titles_are_listed(tmp_path):
    _write_memory(tmp_path, MEMORY_HEADER)
    _write_mistakes(
        tmp_path,
        "## [2026-08-16 12:00] Mid-refactor: auth token refresh\n"
        "- **Type:** handoff\n"
        "- **What happened:** paused mid-migration\n"
        "- **Status:** unrouted\n"
        "\n"
        "## [2026-08-16 11:00] Already routed handoff\n"
        "- **Type:** handoff\n"
        "- **What happened:** old context\n"
        "- **Status:** routed\n"
        "\n"
        "## [2026-08-16 10:00] Unrelated mistake\n"
        "- **Type:** mistake\n"
        "- **What happened:** a bug\n"
        "- **Status:** unrouted\n",
    )
    ctx = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "Mid-refactor: auth token refresh" in ctx
    assert "Already routed handoff" not in ctx
    assert "unrouted entries: 2" in ctx
    assert "paused mid-migration" not in ctx
    assert "a bug" not in ctx


def test_missing_status_is_named_without_changing_the_unrouted_count(tmp_path):
    _write_memory(tmp_path, MEMORY_HEADER)
    _write_mistakes(
        tmp_path,
        "## [2026-09-23 16:00] Gate competing Skill calls\n"
        "- **Type:** decision\n"
        "- **What happened:** two skills raced\n"
        "- **PARA route:** unrouted\n"
        "\n"
        "## [2026-09-23 15:00] Real unrouted\n"
        "- **Type:** mistake\n"
        "- **What happened:** something broke\n"
        "- **Status:** unrouted\n",
    )
    ctx = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "unrouted entries: 1" in ctx
    assert "Gate competing Skill calls" in ctx
    assert "two skills raced" not in ctx
    assert "no usable Status" in ctx


def test_index_gate_line_appears_only_when_enabled(tmp_path, monkeypatch):
    _write_memory(tmp_path, MEMORY_HEADER)
    monkeypatch.delenv("MISTAKE_BRAIN_INDEX_GATE", raising=False)
    off = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "Index gate is on" not in off
    assert "login flow lessons" in off
    monkeypatch.setenv("MISTAKE_BRAIN_INDEX_GATE", "1")
    on = _context(brief_on_session_start.build_session_output(tmp_path))
    assert "Index gate is on" in on
    assert "login flow lessons" in on


def test_valid_sessionstart_json_shape(tmp_path):
    _write_memory(tmp_path, MEMORY_HEADER)
    payload = brief_on_session_start.build_session_output(tmp_path)
    inner = payload["hookSpecificOutput"]
    assert set(inner) == {"hookEventName", "additionalContext"}
    assert inner["hookEventName"] == "SessionStart"
    assert isinstance(inner["additionalContext"], str)
    # Round-trip through json to match Claude Code stdout contract.
    json.loads(json.dumps(payload))


def test_main_always_exits_zero_even_without_project(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setattr(sys, "stdin", type("S", (), {"read": lambda self: ""})())
    monkeypatch.chdir(tmp_path)
    assert brief_on_session_start.main() == 0
    # No mistake-brain in the folder: the plugin's hook says nothing.
    assert capsys.readouterr().out == ""
    (tmp_path / "MISTAKES.md").write_text("# MISTAKES.md\n", encoding="utf-8")
    assert brief_on_session_start.main() == 0
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["hookSpecificOutput"]["hookEventName"] == "SessionStart"
