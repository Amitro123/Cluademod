#!/usr/bin/env python3
"""Tests for draft_mistake_on_validation_failure.py.

Covers:
  1.  Recognized validation command + non-zero exit -> pending candidate written
  2.  Unrelated Bash failure -> no candidate
  3.  Interrupt -> no candidate
  4.  Non-"Exit code" error format (timeout/permission) -> no candidate
  5.  Non-Bash/PowerShell tool -> no candidate
  6.  PowerShell tool name accepted
  7.  No git repo -> visible warning, no write (fail-closed)
  8.  Not initialized (no MISTAKES.md) -> visible warning, no write
  9.  Project A failure cannot write state into project B (isolation)
  10. Multiple candidates accumulate correctly in the JSON file
  11. tsc --version is NOT matched (version check excluded from allowlist)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "skills" / "mistake-brain" / "hooks"
    / "draft_mistake_on_validation_failure.py"
)
PENDING_FILE = ".claude/mb-pending-candidates.json"

# MISTAKES.md minimum content required by the hook
MISTAKES_HEADER = (
    "# MISTAKES.md" + chr(10)
    + "<!-- mistake-brain: new entries are inserted immediately below this line -->"
    + chr(10)
)


def _run_hook(payload: dict, project_dir: Path) -> tuple:
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)}
    r = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )
    return r.returncode, r.stdout


def _init_project(p: Path) -> None:
    (p / "MISTAKES.md").write_text(MISTAKES_HEADER, encoding="utf-8")


def _git_init(p: Path) -> None:
    subprocess.run(["git", "init", str(p)], check=True, capture_output=True)


def _payload(
    cmd: str,
    error: str = None,
    is_interrupt: bool = False,
    tool: str = "Bash",
) -> dict:
    if error is None:
        error = "Exit code 1" + chr(10) + "Details of the failure."
    return {
        "tool_name": tool,
        "tool_input": {"command": cmd},
        "error": error,
        "is_interrupt": is_interrupt,
        "duration_ms": 100,
    }


# ---------------------------------------------------------------------------
# 1. Recognized validation commands -> candidate written
# ---------------------------------------------------------------------------

RECOGNIZED = [
    "python tools/wiki/wiki_lint.py",
    "python wiki_lint.py",
    "pytest tests/",
    "pytest",
    "npm test",
    "npm run test",
    "tsc --noEmit",
    "mypy src/",
    "pylint app/",
    "flake8 .",
    "ruff check .",
    "eslint src/",
    "cargo test",
    "go test ./...",
    "make test",
    "jest --ci",
    "vitest run",
]


@pytest.mark.parametrize("cmd", RECOGNIZED)
def test_recognized_writes_candidate(cmd, tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload(cmd), tmp_path)
    assert rc == 0
    pending = tmp_path / PENDING_FILE
    assert pending.exists(), f"no pending file for {cmd!r}"
    data = json.loads(pending.read_text(encoding="utf-8"))
    assert len(data["candidates"]) == 1
    c = data["candidates"][0]
    assert "Exit code 1" in c["error_summary"]
    assert c["project_root"] == str(tmp_path)
    ctx = json.loads(out)["hookSpecificOutput"]
    assert "mb-pending-candidates.json" in ctx["additionalContext"]
    assert "CANDIDATE" in ctx["additionalContext"]


# ---------------------------------------------------------------------------
# 2. Unrelated Bash failures -> no candidate
# ---------------------------------------------------------------------------

UNRELATED = [
    "rm -rf /tmp/junk",
    "curl https://example.com/api",
    "pip install requests",
    "git push origin main",
    "docker build .",
    "cat missing_file.txt",
    "python script.py",
]


@pytest.mark.parametrize("cmd", UNRELATED)
def test_unrelated_no_candidate(cmd, tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload(cmd), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists(), f"candidate written for {cmd!r}"
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 3. Interrupt -> no candidate
# ---------------------------------------------------------------------------

def test_interrupt_no_candidate(tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload("pytest tests/", is_interrupt=True), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 4. Non-"Exit code" error format -> no candidate
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("err", [
    "Timeout after 30000ms",
    "Permission denied: /etc/shadow",
    "Process killed by signal 9",
    "",
])
def test_non_exit_code_error_no_candidate(err, tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload("pytest tests/", error=err), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 5. Non-Bash/PowerShell tool -> no candidate
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tool", ["Edit", "Write", "Read", "Grep", "Agent"])
def test_non_bash_no_candidate(tool, tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload("pytest tests/", tool=tool), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 6. PowerShell tool name accepted
# ---------------------------------------------------------------------------

def test_powershell_accepted(tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload("pytest tests/", tool="PowerShell"), tmp_path)
    assert rc == 0
    assert (tmp_path / PENDING_FILE).exists()


# ---------------------------------------------------------------------------
# 7. No git repo -> visible warning, no write (fail-closed)
# ---------------------------------------------------------------------------

def test_no_git_repo_is_silent(tmp_path):
    """The plugin runs this hook in every project: without a git root it says nothing."""
    (tmp_path / "MISTAKES.md").write_text("# MISTAKES.md" + chr(10))
    rc, out = _run_hook(_payload("pytest tests/"), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 8. Not a mistake-brain project (no MISTAKES.md) -> silent, no write
# ---------------------------------------------------------------------------

def test_not_initialized_is_silent(tmp_path):
    _git_init(tmp_path)
    # deliberately no MISTAKES.md
    rc, out = _run_hook(_payload("pytest tests/"), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""


# ---------------------------------------------------------------------------
# 9. Project isolation: A cannot write into B
# ---------------------------------------------------------------------------

def test_project_isolation(tmp_path):
    a = tmp_path / "project_a"
    b = tmp_path / "project_b"
    a.mkdir()
    b.mkdir()
    _git_init(a)
    _init_project(a)
    _git_init(b)
    _init_project(b)

    _run_hook(_payload("pytest tests/"), a)

    assert (a / PENDING_FILE).exists()
    assert not (b / PENDING_FILE).exists()
    data = json.loads((a / PENDING_FILE).read_text(encoding="utf-8"))
    assert data["candidates"][0]["project_root"] == str(a)


# ---------------------------------------------------------------------------
# 10. Multiple candidates accumulate
# ---------------------------------------------------------------------------

def test_multiple_candidates_accumulate(tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    for cmd in ["pytest tests/unit/", "mypy src/", "flake8 ."]:
        _run_hook(_payload(cmd), tmp_path)
    data = json.loads((tmp_path / PENDING_FILE).read_text(encoding="utf-8"))
    assert len(data["candidates"]) == 3
    cmds = {c["command"] for c in data["candidates"]}
    assert any("pytest" in c for c in cmds)
    assert any("mypy" in c for c in cmds)
    assert any("flake8" in c for c in cmds)


# ---------------------------------------------------------------------------
# 11. tsc --version excluded
# ---------------------------------------------------------------------------

def test_tsc_version_not_matched(tmp_path):
    _git_init(tmp_path)
    _init_project(tmp_path)
    rc, out = _run_hook(_payload("tsc --version"), tmp_path)
    assert rc == 0
    assert not (tmp_path / PENDING_FILE).exists()
    assert out.strip() == ""
