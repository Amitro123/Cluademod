"""Regression tests for batching and exclusive hook ownership."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent.parent.parent
HOOKS = ROOT / "skills" / "mistake-brain" / "hooks"
SCRIPTS = ROOT / "skills" / "mistake-brain" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import init_project  # noqa: E402


def _load_hook(name):
    spec = importlib.util.spec_from_file_location(name, HOOKS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


auto_pipeline = _load_hook("auto_pipeline_on_mistakes_edit")
post_tool = _load_hook("draft_mistake_on_revert")
stop_hook = _load_hook("revert_stop_hook")


def test_one_or_two_unrouted_entries_do_not_check_promotion(tmp_path, monkeypatch):
    payload = {
        "tool_name": "Edit",
        "tool_input": {"file_path": str(tmp_path / "MISTAKES.md")},
    }

    for count in (1, 2):
        monkeypatch.setattr(auto_pipeline, "_count_unrouted", lambda _path, n=count: n)

        def fail_if_called(_project_dir):
            raise AssertionError("promotion must only run when unrouted == 0")

        monkeypatch.setattr(auto_pipeline, "_run_check_repetition", fail_if_called)
        assert auto_pipeline.process(payload, tmp_path) is None


def test_post_tool_patterns_exclude_stop_owned_commands():
    patterns = post_tool.REVERT_PATTERNS
    assert not any(re.search(pattern, "git revert HEAD") for pattern in patterns)
    assert not any(
        re.search(pattern, "git reset --hard HEAD~1") for pattern in patterns
    )
    assert any(re.search(pattern, "git checkout -- app.py") for pattern in patterns)
    assert any(re.search(pattern, "git restore app.py") for pattern in patterns)
    assert any(re.search(pattern, "git clean -fd") for pattern in patterns)


def test_stop_hook_owns_revert_detection(tmp_path, monkeypatch):
    def fake_git(args, _cwd):
        if args[:2] == ["rev-parse", "HEAD"]:
            return "new-head"
        if args[:2] == ["reflog", "-1"]:
            return "commit: Revert change"
        if args[:3] == ["log", "-1", "--format=%s"]:
            return 'Revert "change"'
        if args[:3] == ["log", "-1", "--format=%b"]:
            return "This reverts commit abcdef1234567890."
        return None

    monkeypatch.setattr(stop_hook, "_git", fake_git)
    monkeypatch.setattr(stop_hook, "_write_state", lambda *_args: None)

    assert stop_hook._detect(tmp_path, "old-head", "old-reflog") == (
        "revert",
        'Revert "change" (reverted abcdef12)',
    )


def test_stop_hook_detects_consecutive_identical_resets(tmp_path, monkeypatch):
    reflog_count = 11
    written_states = []

    def fake_git(args, _cwd):
        if args[:2] == ["rev-parse", "HEAD"]:
            return "same-head"
        if args[:2] == ["reflog", "-1"]:
            return "reset: moving to HEAD"
        if args[:2] == ["reflog", "--format=%gD"]:
            return "\n".join(f"HEAD@{{{i}}}" for i in range(reflog_count))
        return None

    monkeypatch.setattr(stop_hook, "_git", fake_git)
    monkeypatch.setattr(
        stop_hook,
        "_write_state",
        lambda _project, head, marker: written_states.append((head, marker)),
    )

    assert stop_hook._detect(tmp_path, "same-head", "10") == (
        "reset",
        "reset: moving to HEAD",
    )
    assert written_states[-1] == ("same-head", "11")
    reflog_count = 12
    assert stop_hook._detect(tmp_path, "same-head", "11") == (
        "reset",
        "reset: moving to HEAD",
    )
    assert written_states[-1] == ("same-head", "12")
