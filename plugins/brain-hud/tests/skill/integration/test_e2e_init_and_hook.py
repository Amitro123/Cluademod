"""Integration tests — full install + hook trigger path.

Unlike the unit tests in tests/scripts/, these tests run the actual scripts
as *subprocesses* on a real temp filesystem, catching packaging and path
problems that unit tests cannot see:

  - init_project.py is invoked via the real skill_dir (the hook must exist
    inside it — otherwise the guard raises and the test fails immediately)
  - Hooks stay in skill_dir; they are invoked as a subprocess with a mock
    payload on stdin, the same way Claude Code would invoke them at runtime
  - No imports of internal functions — only the public CLI contract is tested

Run:
    pytest tests/integration/ -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain"
)
INIT_SCRIPT = SKILL_DIR / "scripts" / "init_project.py"
MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _run_init(project_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(INIT_SCRIPT),
         "--project-dir", str(project_dir),
         "--skill-dir", str(SKILL_DIR)],
        capture_output=True, text=True,
    )


def _invoke_hook(project_dir: Path, command: str,
                 tool_name: str = "Bash",
                 tool_output: str | dict | None = None) -> subprocess.CompletedProcess:
    """Invoke the skill-install hook with a mock PostToolUse payload."""
    hook = SKILL_DIR / "hooks" / "draft_mistake_on_revert.py"
    payload_dict = {
        "tool_name": tool_name,
        "tool_input": {"command": command},
        "cwd": str(project_dir),
    }
    if tool_output is not None:
        payload_dict["tool_output"] = tool_output
    payload = json.dumps(payload_dict)
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)}
    return subprocess.run(
        [sys.executable, str(hook)],
        input=payload, capture_output=True, text=True, env=env,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────────

@pytest.fixture()
def initialized_project(tmp_path: Path) -> Path:
    """Return a project dir that has been fully initialized via init_project.py."""
    project = tmp_path / "project"
    project.mkdir()
    result = _run_init(project)
    assert result.returncode == 0, (
        f"init_project.py exited {result.returncode}:\n{result.stderr}"
    )
    return project


# ──────────────────────────────────────────────────────────────────────────────
# Full-init artifact checks
# ──────────────────────────────────────────────────────────────────────────────

class TestFullInit:
    """init_project.py creates every expected artifact on a real filesystem."""

    def test_creates_mistakes_md_with_marker(self, initialized_project: Path) -> None:
        mistakes = initialized_project / "MISTAKES.md"
        assert mistakes.exists(), "MISTAKES.md not created"
        assert MARKER in mistakes.read_text(encoding="utf-8"), "Marker missing"

    def test_creates_para_dirs_without_readmes(self, initialized_project: Path) -> None:
        base = initialized_project / ".agent-brain" / "shared"
        for folder in ("Projects", "Areas", "Resources", "Archives"):
            assert (base / folder).is_dir(), f"Missing {folder}/"
            assert not (base / folder / "README.md").exists(), \
                f"Unexpected README in {folder}/ — init should create dirs only"

    def test_creates_rules_file_with_trigger(self, initialized_project: Path) -> None:
        rules = initialized_project / ".claude" / "rules" / "mistake-brain.md"
        assert rules.exists(), ".claude/rules/mistake-brain.md not created"
        assert "/brain-hud:mistake-brain log" in rules.read_text(encoding="utf-8")
        assert "MEMORY.md" in rules.read_text(encoding="utf-8")

    def test_creates_memory_md(self, initialized_project: Path) -> None:
        memory = initialized_project / ".agent-brain" / "shared" / "MEMORY.md"
        assert memory.exists(), "MEMORY.md not created"

    def test_does_not_copy_python_hooks_into_the_project(
        self, initialized_project: Path
    ) -> None:
        assert not (
            initialized_project / ".claude" / "hooks" / "draft_mistake_on_revert.py"
        ).exists()
        assert not (
            initialized_project / ".claude" / "hooks" / "brief_on_session_start.py"
        ).exists()
        # The hooks are the plugin's: init registers none in the project's settings.
        assert not (initialized_project / ".claude" / "settings.json").exists()

    def test_idempotent_on_real_filesystem(self, initialized_project: Path) -> None:
        """Re-running init must not overwrite existing MISTAKES.md content."""
        mistakes = initialized_project / "MISTAKES.md"
        original = mistakes.read_text(encoding="utf-8")
        mistakes.write_text(original + "\n## sentinel-entry\n", encoding="utf-8")

        result = _run_init(initialized_project)
        assert result.returncode == 0
        assert "sentinel-entry" in mistakes.read_text(encoding="utf-8"), \
            "Second init overwrote MISTAKES.md — idempotency broken"

    def test_guard_raises_when_hook_missing_from_skill_dir(self, tmp_path: Path) -> None:
        """init must fail fast if skill_dir has no hooks/draft_mistake_on_revert.py."""
        fake_skill_dir = tmp_path / "empty-skill"
        fake_skill_dir.mkdir()
        project = tmp_path / "project"
        project.mkdir()
        result = subprocess.run(
            [sys.executable, str(INIT_SCRIPT),
             "--project-dir", str(project),
             "--skill-dir", str(fake_skill_dir)],
            capture_output=True, text=True,
        )
        assert result.returncode != 0, "Expected non-zero exit when hook missing"
        assert "brain-hud plugin" in result.stderr, \
            f"Expected guidance to run init from the plugin's skill, got: {result.stderr!r}"


# ──────────────────────────────────────────────────────────────────────────────
# Hook trigger tests (the critical end-to-end path)
# ──────────────────────────────────────────────────────────────────────────────

class TestHookTrigger:
    """The skill-install hook fires correctly when invoked as Claude Code would."""

    def test_post_tool_ignores_git_revert_owned_by_stop(self, initialized_project: Path) -> None:
        proc = _invoke_hook(initialized_project, "git revert HEAD --no-edit")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" not in text

    def test_post_tool_ignores_git_reset_owned_by_stop(self, initialized_project: Path) -> None:
        proc = _invoke_hook(initialized_project, "git reset --hard HEAD~1")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" not in text

    def test_fires_on_git_clean(self, initialized_project: Path) -> None:
        proc = _invoke_hook(initialized_project, "git clean -fd")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" in text

    def test_fires_on_git_restore(self, initialized_project: Path) -> None:
        proc = _invoke_hook(initialized_project, "git restore src/app.py")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" in text
        assert "git restore src/app.py" in text

    def test_ignores_quoted_revert_mention(self, initialized_project: Path) -> None:
        """echo 'git revert ...' must NOT draft — the revert is quoted text, not a command."""
        proc = _invoke_hook(initialized_project, "echo 'git revert HEAD'")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" not in text, \
            "Hook triggered on quoted mention — strip_quoted_spans regression"

    def test_ignores_non_bash_tool(self, initialized_project: Path) -> None:
        proc = _invoke_hook(initialized_project, "git revert HEAD", tool_name="Edit")
        assert proc.returncode == 0
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert "[auto-draft]" not in text

    def test_never_blocks_when_mistakes_md_missing(self, tmp_path: Path) -> None:
        """Hook must exit 0 even if MISTAKES.md doesn't exist — never blocks Claude."""
        hook_src = SKILL_DIR / "hooks" / "draft_mistake_on_revert.py"
        payload = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "git revert HEAD"},
            "cwd": str(tmp_path),
        })
        proc = subprocess.run(
            [sys.executable, str(hook_src)],
            input=payload, capture_output=True, text=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": str(tmp_path)},
        )
        assert proc.returncode == 0, "Hook blocked Claude — must always exit 0"

    def test_two_worktree_discards_produce_two_entries(self, initialized_project: Path) -> None:
        """Each PostToolUse-owned event appends an entry without corruption."""
        _invoke_hook(initialized_project, "git restore src/app.py")
        _invoke_hook(initialized_project, "git clean -fd")
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        assert text.count("[auto-draft]") == 2, \
            f"Expected 2 auto-draft entries, found {text.count('[auto-draft]')}"

    def test_entry_inserted_directly_after_marker(self, initialized_project: Path) -> None:
        """New entry heading must be the first ## heading after the marker."""
        _invoke_hook(initialized_project, "git clean -fd")
        text = (initialized_project / "MISTAKES.md").read_text(encoding="utf-8")
        marker_pos = text.find(MARKER)
        assert marker_pos != -1, "Marker not found in MISTAKES.md"
        after_marker = text[marker_pos + len(MARKER):]
        first_heading = next(
            (line for line in after_marker.splitlines() if line.strip().startswith("## ")),
            None,
        )
        assert first_heading is not None, "No ## heading found after marker"
        assert "[auto-draft]" in first_heading, \
            f"First heading after marker is not the auto-draft entry: {first_heading!r}"


def _invoke_brief(project_dir: Path) -> subprocess.CompletedProcess:
    hook = SKILL_DIR / "hooks" / "brief_on_session_start.py"
    payload = json.dumps({
        "hook_event_name": "SessionStart",
        "source": "startup",
        "cwd": str(project_dir),
    })
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)}
    return subprocess.run(
        [sys.executable, str(hook)],
        input=payload, capture_output=True, text=True, env=env,
    )


class TestSessionStartBrief:
    """The skill-install briefing hook emits bounded SessionStart JSON."""

    def test_emits_sessionstart_json_with_memory(self, initialized_project: Path) -> None:
        proc = _invoke_brief(initialized_project)
        assert proc.returncode == 0, proc.stderr
        payload = json.loads(proc.stdout)
        inner = payload["hookSpecificOutput"]
        assert inner["hookEventName"] == "SessionStart"
        assert "MEMORY.md" in inner["additionalContext"]
        assert "unrouted entries:" in inner["additionalContext"]

    def test_never_blocks_when_memory_missing(self, tmp_path: Path) -> None:
        hook_src = SKILL_DIR / "hooks" / "brief_on_session_start.py"
        payload = json.dumps({
            "hook_event_name": "SessionStart",
            "source": "compact",
            "cwd": str(tmp_path),
        })
        proc = subprocess.run(
            [sys.executable, str(hook_src)],
            input=payload, capture_output=True, text=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": str(tmp_path)},
        )
        assert proc.returncode == 0, "Briefing hook blocked Claude — must always exit 0"
        # The plugin runs this hook in every project: one without mistake-brain gets nothing.
        assert proc.stdout.strip() == ""


class TestSharedIndexReachesBothHarnesses:
    """End-to-end proof that a lesson routed on the Claude Code side is
    actually visible through Cursor's real sessionStart adapter -- not just
    that cursor_brief.py can parse a hand-built fixture file. Goes through
    the real init_project.py subprocess, a real MISTAKES.md entry, the same
    PARA-write + index-update steps router.md instructs a session to perform,
    and then both harnesses' real hook subprocesses on the resulting files.

    What this does NOT prove: that Cursor itself actually invokes
    cursor_brief.py with this payload shape at sessionStart, or that
    ~/.cursor/hooks.json registration works as documented -- that depends on
    Cursor's own hook dispatcher, which nothing in this test suite can run.
    This only proves the *data path* post-dispatch is correct: given the
    payload Cursor's docs say it sends, the right lesson comes back.
    """

    def _route_one_lesson(self, project: Path) -> None:
        """Perform exactly what router.md instructs for one Area-bound entry:
        write the lesson into .agent-brain/shared/Areas/<slug>.md, add its
        index line to the shared MEMORY.md, then flip MISTAKES.md's Status."""
        mistakes = project / "MISTAKES.md"
        text = mistakes.read_text(encoding="utf-8")
        entry = (
            "\n## [2026-10-05 16:00] CI retries without a backoff\n"
            "- **Type:** mistake\n"
            "- **What happened:** CI retried a flaky step with no delay.\n"
            "- **Root cause:** No backoff between retries.\n"
            "- **Consequence:** Hammered a rate-limited API.\n"
            "- **Prevention rule:** Add exponential backoff to CI retries.\n"
            "- **PARA route:** unrouted\n"
            "- **Status:** unrouted\n"
        )
        mistakes.write_text(text.replace(MARKER, MARKER + "\n" + entry, 1), encoding="utf-8")

        area = project / ".agent-brain" / "shared" / "Areas" / "ci.md"
        area.parent.mkdir(parents=True, exist_ok=True)
        area.write_text(
            "# ci\n\n"
            "## [2026-10-05] Add backoff to CI retries\n"
            "- Added: 2026-10-05 16:00\n"
            "CROSS_HARNESS_LESSON_MARKER: add exponential backoff to CI retries.\n"
            "Source: mistake log entry [2026-10-05 16:00] CI retries without a backoff\n",
            encoding="utf-8",
        )

        memory = project / ".agent-brain" / "shared" / "MEMORY.md"
        memory_text = memory.read_text(encoding="utf-8")
        memory_text = memory_text.replace(
            "## Areas\n_(none yet)_",
            "## Areas\n- [Area] Areas/ci.md — CROSS_HARNESS_LESSON_MARKER (1 lesson, last updated 2026-10-05)",
        )
        memory.write_text(memory_text, encoding="utf-8")

        mistakes.write_text(
            mistakes.read_text(encoding="utf-8")
            .replace("- **PARA route:** unrouted\n- **Status:** unrouted\n", "- **PARA route:** Area: .agent-brain/shared/Areas/ci.md\n- **Status:** routed\n", 1),
            encoding="utf-8",
        )

    def test_lesson_routed_on_claude_side_is_visible_through_cursor_brief(
        self, initialized_project: Path
    ) -> None:
        project = initialized_project
        self._route_one_lesson(project)

        cursor_hook = SKILL_DIR / "hooks" / "cursor_brief.py"
        proc = subprocess.run(
            [sys.executable, str(cursor_hook)],
            input=json.dumps({"hook_event_name": "sessionStart", "workspace_roots": [str(project)]}),
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        out = json.loads(proc.stdout)
        assert "CROSS_HARNESS_LESSON_MARKER" in out["additional_context"]

    def test_same_lesson_also_visible_through_claude_codes_own_hook(
        self, initialized_project: Path
    ) -> None:
        """Both harnesses read identically from the one file post-route."""
        project = initialized_project
        self._route_one_lesson(project)

        claude_hook = SKILL_DIR / "hooks" / "brief_on_session_start.py"
        proc = subprocess.run(
            [sys.executable, str(claude_hook)],
            input=json.dumps({"hook_event_name": "SessionStart", "source": "startup", "cwd": str(project)}),
            capture_output=True, text=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": str(project)},
        )
        assert proc.returncode == 0, proc.stderr
        payload = json.loads(proc.stdout)
        ctx = payload["hookSpecificOutput"]["additionalContext"]
        assert "CROSS_HARNESS_LESSON_MARKER" in ctx
