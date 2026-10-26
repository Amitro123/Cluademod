"""Tests for hooks/draft_mistake_on_revert.py

Previously covered only indirectly (pattern-level in test_hook_scope.py,
registration-level in test_init_project.py/test_update_hook.py) -- nothing
exercised strip_quoted_spans or the actual MISTAKES.md draft-write path.

Run: pytest tests/scripts/test_draft_mistake_on_revert.py -v
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HOOK = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "hooks" / "draft_mistake_on_revert.py"
)
HOOKS_DIR = HOOK.parent
sys.path.insert(0, str(HOOKS_DIR))

import draft_mistake_on_revert as hook  # noqa: E402

MARKER = hook.MARKER


def _inbox(project: Path) -> Path:
    path = project / "MISTAKES.md"
    path.write_text(f"# MISTAKES.md\n\n{MARKER}\n", encoding="utf-8")
    return path


def _run(project: Path, command: str) -> str:
    payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(project)}
    result = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    return result.stdout


def test_strip_quoted_spans_removes_single_and_double_quoted_text():
    assert hook.strip_quoted_spans("echo 'git reset --hard HEAD~1'") == "echo "
    assert hook.strip_quoted_spans('echo "git restore foo"') == "echo "


def test_strip_quoted_spans_leaves_unquoted_command_intact():
    assert hook.strip_quoted_spans("git checkout -- foo.py") == "git checkout -- foo.py"


def test_real_checkout_command_drafts_an_entry(tmp_path):
    mistakes = _inbox(tmp_path)
    out = _run(tmp_path, "git checkout -- foo.py")
    assert mistakes.read_text(encoding="utf-8").count("[auto-draft]") == 1
    assert "foo.py" in mistakes.read_text(encoding="utf-8")
    assert out.strip()  # additionalContext was emitted
    payload = json.loads(out)
    assert "auto-drafted" in payload["hookSpecificOutput"]["additionalContext"]


def test_quoted_example_text_does_not_draft_an_entry(tmp_path):
    """Regression: echoing JSON containing example command text as a quoted
    string must not match -- this bit the hook's own author once."""
    mistakes = _inbox(tmp_path)
    _run(tmp_path, 'echo \'{"command":"git reset --hard HEAD~1"}\'')
    assert "[auto-draft]" not in mistakes.read_text(encoding="utf-8")


def test_git_revert_and_reset_hard_are_not_this_hooks_job(tmp_path):
    """revert_stop_hook.py owns these; this hook must not double-draft."""
    mistakes = _inbox(tmp_path)
    _run(tmp_path, "git revert HEAD")
    _run(tmp_path, "git reset --hard HEAD~1")
    assert "[auto-draft]" not in mistakes.read_text(encoding="utf-8")


def test_unrelated_command_does_not_draft(tmp_path):
    mistakes = _inbox(tmp_path)
    _run(tmp_path, "npm test")
    assert "[auto-draft]" not in mistakes.read_text(encoding="utf-8")


def test_non_bash_tool_is_ignored(tmp_path):
    mistakes = _inbox(tmp_path)
    payload = {"tool_name": "Edit", "tool_input": {"command": "git checkout -- foo.py"}, "cwd": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "[auto-draft]" not in mistakes.read_text(encoding="utf-8")


def test_missing_mistakes_md_does_not_crash(tmp_path):
    result = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": "git restore foo.py"}, "cwd": str(tmp_path)}),
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert not (tmp_path / "MISTAKES.md").exists()


def test_git_clean_fd_variant_is_detected(tmp_path):
    mistakes = _inbox(tmp_path)
    _run(tmp_path, "git clean -fd")
    assert "[auto-draft]" in mistakes.read_text(encoding="utf-8")
