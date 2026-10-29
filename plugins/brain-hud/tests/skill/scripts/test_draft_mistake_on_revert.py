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


def test_unstaging_with_restore_is_not_a_revert():
    assert not hook.matches_revert("git restore --staged src/a.py")
    assert not hook.matches_revert("git restore -S src/a.py")
    assert not hook.matches_revert("git add a.py && git restore --staged b.py")


def test_restore_touching_the_worktree_is_a_revert():
    assert hook.matches_revert("git restore src/a.py")
    assert hook.matches_revert("git restore --source=HEAD~1 src/a.py")
    assert hook.matches_revert("git restore --staged --worktree src/a.py")
    assert hook.matches_revert("git restore --staged b.py; git restore a.py")


def test_checkout_and_clean_still_count():
    assert hook.matches_revert("git checkout -- app.py")
    assert hook.matches_revert("git clean -fd")
    assert not hook.matches_revert("echo 'git restore a.py'")


def test_a_drafted_command_has_its_secrets_redacted_and_no_backtick():
    from draft_mistake_on_revert import safe_for_markdown

    cmd = (
        "git checkout -- a.ts && curl -H 'Authorization: Bearer abcdefghijklmnop' "
        "https://user:hunter2@example.com/x?token=s3cr3t ghp_abcdefghijklmnopqrstuvwxyz0123 "
        "sk-ant-abcdefghijklmnopqrst AKIAABCDEFGHIJKLMNOP echo `date`"
    )
    out = safe_for_markdown(cmd)
    for secret in ("abcdefghijklmnop", "hunter2", "s3cr3t", "ghp_", "sk-ant-", "AKIAABCDEFGHIJKLMNOP"):
        assert secret not in out, secret
    assert "`" not in out
    assert out.startswith("git checkout -- a.ts")
    assert len(out) <= 200


def test_space_separated_secret_flags_are_redacted():
    from draft_mistake_on_revert import safe_for_markdown

    for cmd, secret in [
        ("git checkout -- a && mysql --password hunter2 db", "hunter2"),
        ("git restore . ; deploy --token abc123def", "abc123def"),
        ("git clean -f && cli --api-key k-999 run", "k-999"),
        ("git checkout . && mysql -u root -p s3cret db", "s3cret"),
        ("git checkout . && mysql -u root -ps3cret db", "s3cret"),
    ]:
        out = safe_for_markdown(cmd)
        assert secret not in out, (cmd, out)
        assert "[redacted]" in out
    # A flag followed by another flag isn't a value: left alone.
    assert safe_for_markdown("git checkout -- a && tool --token --verbose") == "git checkout -- a && tool --token --verbose"


def _run_payload(payload: dict) -> str:
    result = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    return result.stdout


def test_a_revert_inside_a_factory_worktree_drafts_nothing(tmp_path):
    mistakes = _inbox(tmp_path)
    worktree = tmp_path / ".factory" / "rate-limiter"
    worktree.mkdir(parents=True)
    payload = {"tool_name": "Bash", "tool_input": {"command": "git restore src/mw.ts"}, "cwd": str(worktree)}
    assert _run_payload(payload) == ""
    # From the project root, by cd into the worktree, or by a factory agent: still the run's.
    assert _run_payload({**payload, "cwd": str(tmp_path), "tool_input": {"command": "cd .factory/rate-limiter && git restore src/mw.ts"}}) == ""
    assert _run_payload({**payload, "cwd": str(tmp_path), "agent_id": "a1", "agent_type": "factory:builder"}) == ""
    assert "[auto-draft]" not in mistakes.read_text(encoding="utf-8")


def test_the_same_revert_from_the_project_root_still_drafts(tmp_path):
    mistakes = _inbox(tmp_path)
    payload = {"tool_name": "Bash", "tool_input": {"command": "git restore src/mw.ts"}, "cwd": str(tmp_path)}
    assert _run_payload(payload).strip()
    # Another sub-agent working in the project itself is not the factory's.
    assert _run_payload({**payload, "agent_id": "a2", "agent_type": "Explore"}).strip()
    assert mistakes.read_text(encoding="utf-8").count("[auto-draft]") == 2
