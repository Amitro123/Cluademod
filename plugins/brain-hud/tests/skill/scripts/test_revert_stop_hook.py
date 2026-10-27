"""Tests for hooks/revert_stop_hook.py using a real git repo fixture.

Previously covered only via registration checks (test_hook_scope.py,
test_init_project.py, test_update_hook.py) -- _detect()'s actual branch
logic (HEAD-moved-to-a-revert-commit, reflog-tip-is-a-reset) had no
direct test.

Run: pytest tests/scripts/test_revert_stop_hook.py -v
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HOOK_PATH = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "hooks" / "revert_stop_hook.py"
)
sys.path.insert(0, str(HOOK_PATH.parent))

import revert_stop_hook as hook  # noqa: E402

MARKER = hook.MARKER


def _git(args, cwd):
    subprocess.run(["git"] + args, cwd=cwd, check=True, capture_output=True, text=True)


def _init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _git(["init", "-q"], path)
    _git(["config", "user.email", "t@example.com"], path)
    _git(["config", "user.name", "Test"], path)
    return path


def _commit(path: Path, filename: str, content: str, message: str) -> None:
    (path / filename).write_text(content, encoding="utf-8")
    _git(["add", filename], path)
    _git(["commit", "-q", "-m", message], path)


def _inbox(path: Path) -> Path:
    mistakes = path / "MISTAKES.md"
    mistakes.write_text(f"# MISTAKES.md\n\n{MARKER}\n", encoding="utf-8")
    return mistakes


def test_first_run_establishes_baseline_without_drafting(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _inbox(repo)

    event_type, desc = hook._detect(repo, None, None)
    assert event_type is None
    assert (repo / hook._STATE_FILE).exists()


def test_no_change_between_turns_detects_nothing(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    old_head, old_reflog = hook._detect(repo, None, None)  # baseline
    state_head, state_reflog = hook._read_state(repo)

    event_type, desc = hook._detect(repo, state_head, state_reflog)
    assert event_type is None


def test_git_revert_is_detected(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    hook._detect(repo, None, None)  # baseline after 2 commits
    old_head, old_reflog = hook._read_state(repo)

    subprocess.run(
        ["git", "revert", "--no-edit", "HEAD"], cwd=repo, check=True, capture_output=True, text=True,
    )

    event_type, desc = hook._detect(repo, old_head, old_reflog)
    assert event_type == "revert"
    assert "Revert" in desc


def test_git_reset_hard_is_detected(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    hook._detect(repo, None, None)
    old_head, old_reflog = hook._read_state(repo)

    subprocess.run(
        ["git", "reset", "--hard", "HEAD~1"], cwd=repo, check=True, capture_output=True, text=True,
    )

    event_type, desc = hook._detect(repo, old_head, old_reflog)
    assert event_type == "reset"


def test_draft_entry_writes_mistakes_md(tmp_path):
    repo = _init_repo(tmp_path)
    mistakes = _inbox(repo)

    written = hook._draft_entry(repo, "revert", "Revert \"second change\"")
    assert written is True
    text = mistakes.read_text(encoding="utf-8")
    assert "[auto-draft]" in text
    assert "Revert commit detected" in text


def test_draft_entry_without_mistakes_md_is_a_noop(tmp_path):
    repo = _init_repo(tmp_path)
    written = hook._draft_entry(repo, "revert", "Revert x")
    assert written is False


def test_end_to_end_main_drafts_on_revert(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    _inbox(repo)

    import json
    # First turn: establish baseline (no prior state file).
    subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps({"cwd": str(repo)}),
        capture_output=True, text=True, cwd=repo,
    )
    subprocess.run(
        ["git", "revert", "--no-edit", "HEAD"], cwd=repo, check=True, capture_output=True, text=True,
    )
    # Second turn: should detect the revert against the stored baseline.
    result = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps({"cwd": str(repo)}),
        capture_output=True, text=True, cwd=repo,
    )
    assert result.returncode == 0
    assert "auto-drafted" in result.stdout
    assert "[auto-draft]" in (repo / "MISTAKES.md").read_text(encoding="utf-8")
    # Stop's additionalContext reaches the model at once, and the turn goes on for a reply to it.
    out = json.loads(result.stdout)["hookSpecificOutput"]
    assert out["hookEventName"] == "Stop"
    assert "Before you finish" in out["additionalContext"]
    # Once per revert: a third run with nothing new says nothing.
    again = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps({"cwd": str(repo)}),
        capture_output=True, text=True, cwd=repo,
    )
    assert again.stdout.strip() == ""


def _after(repo: Path, *commands: list[str]):
    """Detect across a turn in which the given git commands ran."""
    hook._detect(repo, None, None)
    old_head, old_reflog = hook._read_state(repo)
    for argv in commands:
        subprocess.run(["git", *argv], cwd=repo, check=True, capture_output=True, text=True)
    return hook._detect(repo, old_head, old_reflog)


def test_unstaging_with_git_reset_is_not_a_mistake(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    (repo / "b.txt").write_text("new", encoding="utf-8")
    _git(["add", "b.txt"], repo)
    assert _after(repo, ["reset"]) == (None, None)


def test_a_soft_reset_keeps_the_work_and_is_not_a_mistake(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    assert _after(repo, ["reset", "--soft", "HEAD~1"]) == (None, None)


def test_a_mixed_reset_keeps_the_work_and_is_not_a_mistake(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    assert _after(repo, ["reset", "HEAD~1"]) == (None, None)


def test_a_hard_reset_that_drops_a_commit_is_one_entry(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    event, desc = _after(repo, ["reset", "--hard", "HEAD~1"])
    assert event == "reset" and desc.startswith("reset: moving to")


def test_a_reset_forward_is_not_a_mistake(tmp_path):
    repo = _init_repo(tmp_path)
    _commit(repo, "a.txt", "1", "initial")
    _commit(repo, "a.txt", "2", "second change")
    second = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    _git(["reset", "--hard", "HEAD~1"], repo)
    assert _after(repo, ["reset", "--hard", second]) == (None, None)


def test_a_draft_leaves_older_entries_byte_for_byte(tmp_path):
    mistakes = _inbox(tmp_path)
    older = (
        "## [2026-10-01 09:00] Kept a log\n- **Type:** mistake\n- **What happened:** the log:\n"
        "  ```\n  line one\n\n\n  line four\n  ```\n- **Status:** routed\n"
    )
    mistakes.write_text(mistakes.read_text(encoding="utf-8") + "\n" + older, encoding="utf-8")
    assert hook._draft_entry(tmp_path, "reset", "reset: moving to HEAD~1")
    text = mistakes.read_text(encoding="utf-8")
    assert older in text
    assert f"{MARKER}\n\n## [" in text
    assert "\n\n\n## [2026-10-01" not in text
