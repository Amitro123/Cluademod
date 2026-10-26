"""The fixes that came with moving the skill into the brain-hud plugin.

- The index's counts and dates come from the lesson files (rebuild_index.py),
  never from the model, and the hooks keep them right.
- init leaves a tracked CLAUDE.md alone, registers no hooks, removes the ones
  an older install registered, and keeps the hooks' runtime files out of git.
- The plugin's hooks run in every project: outside a mistake-brain one they
  say nothing and write nothing.
- The log's Checker catches a missing Status and a guessed (future) timestamp.

Run: pytest tests/skill/scripts/test_plugin_fixes.py -v
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SKILL = PLUGIN_ROOT / "skills" / "mistake-brain"
sys.path.insert(0, str(SKILL / "scripts"))

import host_layout  # noqa: E402
import init_project  # noqa: E402
import rebuild_index  # noqa: E402
import validate_mistakes  # noqa: E402


def _hook(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL / "hooks" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _lesson(date: str, title: str) -> str:
    return f"## [{date}] {title}\n- Added: {date} 10:00\nDo the thing.\nSource: mistake log entry [{date} 09:00] {title}\n\n"


def _store(project: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        p = project / ".agent-brain" / "shared" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


def _memory(project: Path) -> str:
    return (project / ".agent-brain" / "shared" / "MEMORY.md").read_text(encoding="utf-8")


def _git(project: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=project, check=True, capture_output=True)


def _git_repo(project: Path) -> None:
    project.mkdir(parents=True, exist_ok=True)
    _git(project, "init", "-q")
    _git(project, "config", "user.email", "t@example.com")
    _git(project, "config", "user.name", "t")


@pytest.fixture(autouse=True)
def _no_global_copy(tmp_path, monkeypatch):
    # init reports ~/.claude/skills/mistake-brain: point HOME at an empty folder.
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.delenv("MISTAKE_BRAIN_INDEX_GATE", raising=False)


# ---------- rebuild_index ----------

CI = "# CI\n\nHow the pipeline breaks and how to keep it green.\n\n" + _lesson("2026-10-20", "Pin the runner") + _lesson("2026-10-24", "Cache the deps")


def test_a_store_with_no_index_gets_a_full_one(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI, "Projects/limiter.md": _lesson("2026-10-25", "Bucket"), "Archives/2025/old.md": "x"})
    assert rebuild_index.rebuild(tmp_path) is True
    text = _memory(tmp_path)
    assert "- [Area] Areas/ci.md — How the pipeline breaks and how to keep it green. (2 lessons, last updated 2026-10-24)" in text
    assert "- [Project] Projects/limiter.md — limiter (1 lesson, last updated 2026-10-25)" in text
    assert "Archives: 1 file (not loaded at session start)" in text
    assert "## Rules promoted so far" in text


def test_lines_without_counts_get_them_and_keep_their_summaries(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI})
    memory = host_layout.memory_header().replace(
        "## Areas\n_(none yet)_", "## Areas\n- [Area] [ci.md](Areas/ci.md) — what we learned about CI"
    ) + "\n## Last dream\n2026-10-20 — tidy.\n"
    (tmp_path / ".agent-brain" / "shared" / "MEMORY.md").write_text(memory, encoding="utf-8")
    rebuild_index.rebuild(tmp_path)
    text = _memory(tmp_path)
    assert "- [Area] Areas/ci.md — what we learned about CI (2 lessons, last updated 2026-10-24)" in text
    assert "## Last dream\n2026-10-20 — tidy." in text


def test_a_drifted_count_is_corrected(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI})
    rebuild_index.rebuild(tmp_path)
    path = tmp_path / ".agent-brain" / "shared" / "MEMORY.md"
    path.write_text(path.read_text(encoding="utf-8").replace("2 lessons", "9 lessons"), encoding="utf-8")
    assert rebuild_index.rebuild(tmp_path) is True
    assert "(2 lessons, last updated 2026-10-24)" in _memory(tmp_path)


def test_rerunning_is_a_no_op(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI, "Resources/http.md": _lesson("2026-10-01", "Check the body")})
    rebuild_index.rebuild(tmp_path)
    before = _memory(tmp_path)
    assert rebuild_index.rebuild(tmp_path) is False
    assert _memory(tmp_path) == before


def test_it_never_deletes_a_line(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI})
    memory = host_layout.memory_header().replace(
        "## Areas\n_(none yet)_",
        "## Areas\n- [Area] Areas/gone.md — a file since merged (3 lessons, last updated 2026-09-01)\nNote: auth lessons moved to Resources.",
    )
    (tmp_path / ".agent-brain" / "shared" / "MEMORY.md").write_text(memory, encoding="utf-8")
    rebuild_index.rebuild(tmp_path)
    text = _memory(tmp_path)
    assert "- [Area] Areas/gone.md — a file since merged (3 lessons, last updated 2026-09-01)" in text
    assert "Note: auth lessons moved to Resources." in text
    assert "- [Area] Areas/ci.md —" in text


def test_with_the_gate_on_no_line_is_added(tmp_path):
    _store(tmp_path, {"Areas/ci.md": CI, "Areas/auth.md": _lesson("2026-10-02", "Tokens")})
    memory = host_layout.memory_header().replace("## Areas\n_(none yet)_", "## Areas\n- [Area] Areas/ci.md — CI")
    (tmp_path / ".agent-brain" / "shared" / "MEMORY.md").write_text(memory, encoding="utf-8")
    rebuild_index.rebuild(tmp_path, gate=True)
    text = _memory(tmp_path)
    assert "- [Area] Areas/ci.md — CI (2 lessons, last updated 2026-10-24)" in text
    assert "auth.md" not in text


# ---------- init ----------

def test_a_tracked_claude_md_is_left_byte_identical(tmp_path):
    project = tmp_path / "p"
    _git_repo(project)
    original = "# Team rules\n\nNothing about memory here.\n"
    (project / "CLAUDE.md").write_text(original, encoding="utf-8")
    _git(project, "add", "CLAUDE.md")
    _git(project, "commit", "-qm", "rules")
    result = init_project.main(project, SKILL)
    assert (project / "CLAUDE.md").read_text(encoding="utf-8") == original
    rules = (project / ".claude" / "rules" / "mistake-brain.md").read_text(encoding="utf-8")
    assert "Mistake Brain — Standing Instructions" in rules
    assert any("tracked in git" in s for s in result.skipped)
    # Re-running doesn't add it twice.
    init_project.main(project, SKILL)
    rules_again = (project / ".claude" / "rules" / "mistake-brain.md").read_text(encoding="utf-8")
    assert rules_again.count("Mistake Brain — Standing Instructions") == 1


def test_an_untracked_claude_md_still_gets_the_section(tmp_path):
    project = tmp_path / "p"
    _git_repo(project)
    (project / "CLAUDE.md").write_text("# Mine\n", encoding="utf-8")
    init_project.main(project, SKILL)
    assert "Mistake Brain — Standing Instructions" in (project / "CLAUDE.md").read_text(encoding="utf-8")


LEGACY = {
    "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": 'python3 "$HOME/.claude/skills/mistake-brain/hooks/revert_stop_hook.py"'}]}],
        "PostToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": 'python3 "$HOME/.claude/skills/mistake-brain/hooks/draft_mistake_on_revert.py"'}]},
            {"matcher": "Edit", "hooks": [{"type": "command", "command": "npx prettier --write"}]},
        ],
    },
    "permissions": {"allow": ["Bash(ls)"]},
}


def test_init_removes_hooks_an_older_install_registered(tmp_path):
    project = tmp_path / "p"
    _git_repo(project)
    (project / ".claude").mkdir()
    (project / ".claude" / "settings.local.json").write_text(json.dumps(LEGACY), encoding="utf-8")
    result = init_project.main(project, SKILL)
    data = json.loads((project / ".claude" / "settings.local.json").read_text(encoding="utf-8"))
    assert data == {
        "hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "npx prettier --write"}]}]},
        "permissions": {"allow": ["Bash(ls)"]},
    }
    assert any("2 legacy hook entries removed" in c for c in result.created)
    # It registers none of its own anywhere.
    assert not (project / ".claude" / "settings.json").exists()


def test_a_tracked_settings_json_is_reported_not_edited(tmp_path):
    project = tmp_path / "p"
    _git_repo(project)
    (project / ".claude").mkdir()
    text = json.dumps(LEGACY)
    (project / ".claude" / "settings.json").write_text(text, encoding="utf-8")
    _git(project, "add", ".claude/settings.json")
    _git(project, "commit", "-qm", "settings")
    result = init_project.main(project, SKILL)
    assert (project / ".claude" / "settings.json").read_text(encoding="utf-8") == text
    assert any(".claude/settings.json is tracked in git and registers 2" in a for a in result.actions)


def test_an_older_global_copy_is_reported(tmp_path):
    copy = Path(os.environ["HOME"]) / ".claude" / "skills" / "mistake-brain"
    copy.mkdir(parents=True)
    (copy / "SKILL.md").write_text("---\nname: mistake-brain\n---\n", encoding="utf-8")
    project = tmp_path / "p"
    project.mkdir()
    result = init_project.main(project, SKILL)
    assert any("older copy of the skill" in a and "delete that folder" in a for a in result.actions)


def test_runtime_files_are_kept_out_of_git(tmp_path):
    project = tmp_path / "p"
    _git_repo(project)
    init_project.main(project, SKILL)
    exclude = (project / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    for f in init_project.RUNTIME_FILES:
        assert f in exclude.splitlines()
    init_project.main(project, SKILL)
    again = (project / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert again == exclude


def test_empty_legacy_trees_are_removed_and_full_ones_kept(tmp_path):
    project = tmp_path / "p"
    (project / ".agent-brain" / "claude" / "Areas").mkdir(parents=True)
    (project / ".agent-brain" / "claude" / "Archives" / "2025").mkdir(parents=True)
    (project / ".agent-brain" / "cursor" / "Areas").mkdir(parents=True)
    (project / ".agent-brain" / "cursor" / "Areas" / "keep.txt").write_text("x", encoding="utf-8")
    init_project.main(project, SKILL)
    assert not (project / ".agent-brain" / "claude").exists()
    assert (project / ".agent-brain" / "cursor" / "Areas" / "keep.txt").exists()


def test_init_writes_the_counts_for_lessons_already_there(tmp_path):
    project = tmp_path / "p"
    _store(project, {"Areas/ci.md": CI})
    init_project.main(project, SKILL)
    assert "(2 lessons, last updated 2026-10-24)" in _memory(project)


# ---------- the plugin's hooks outside a mistake-brain project ----------

PAYLOADS = {
    "brief_on_session_start.py": {"hook_event_name": "SessionStart", "source": "startup"},
    "revert_stop_hook.py": {"hook_event_name": "Stop"},
    "draft_mistake_on_revert.py": {"tool_name": "Bash", "tool_input": {"command": "git restore src/a.py"}},
    "auto_pipeline_on_mistakes_edit.py": {"tool_name": "Edit", "tool_input": {"file_path": "MISTAKES.md"}},
    "draft_mistake_on_validation_failure.py": {"tool_name": "Bash", "tool_input": {"command": "pytest"}, "error": "Exit code 1"},
}


@pytest.mark.parametrize("hook", sorted(PAYLOADS))
def test_hooks_are_silent_and_write_nothing_in_another_project(tmp_path, hook):
    project = tmp_path / "elsewhere"
    _git_repo(project)
    (project / "README.md").write_text("hi", encoding="utf-8")
    _git(project, "add", ".")
    _git(project, "commit", "-qm", "init")
    before = sorted(p.relative_to(project).as_posix() for p in project.rglob("*") if ".git" not in p.parts)
    proc = subprocess.run(
        ["sh", str(SKILL / "hooks" / "run.sh"), hook],
        input=json.dumps({**PAYLOADS[hook], "cwd": str(project)}),
        capture_output=True, text=True, cwd=project,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project)},
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == ""
    after = sorted(p.relative_to(project).as_posix() for p in project.rglob("*") if ".git" not in p.parts)
    assert after == before


def test_the_launcher_runs_the_hook_in_a_mistake_brain_project(tmp_path):
    project = tmp_path / "p"
    project.mkdir()
    init_project.main(project, SKILL)
    proc = subprocess.run(
        ["sh", str(SKILL / "hooks" / "run.sh"), "brief_on_session_start.py"],
        input=json.dumps({"hook_event_name": "SessionStart", "source": "startup", "cwd": str(project)}),
        capture_output=True, text=True, env={**os.environ, "CLAUDE_PROJECT_DIR": str(project)},
    )
    out = json.loads(proc.stdout)
    assert "# mistake-brain session briefing" in out["hookSpecificOutput"]["additionalContext"]


# ---------- the hooks keep the index right ----------

def test_session_start_rebuilds_a_missing_index_from_the_lessons(tmp_path):
    brief = _hook("brief_on_session_start")
    (tmp_path / "MISTAKES.md").write_text(init_project.MISTAKES_HEADER + init_project.MARKER + "\n", encoding="utf-8")
    _store(tmp_path, {"Areas/ci.md": CI})
    text = brief.build_briefing(tmp_path)
    assert "Areas/ci.md" in text and "(2 lessons, last updated 2026-10-24)" in text
    assert "refreshed from the lesson files" in text
    # Up to date: nothing refreshed the second time.
    assert "refreshed from the lesson files" not in brief.build_briefing(tmp_path)


def test_writing_a_lesson_file_refreshes_the_index(tmp_path):
    pipeline = _hook("auto_pipeline_on_mistakes_edit")
    _store(tmp_path, {"Areas/ci.md": CI})
    rebuild_index.rebuild(tmp_path)
    _store(tmp_path, {"Areas/ci.md": CI + _lesson("2026-10-26", "Retry flaky steps once")})
    path = str(tmp_path / ".agent-brain" / "shared" / "Areas" / "ci.md")
    assert pipeline.process({"tool_name": "Edit", "tool_input": {"file_path": path}}, tmp_path) is None
    assert "(3 lessons, last updated 2026-10-26)" in _memory(tmp_path)


def test_the_pipeline_uses_its_own_scripts_never_a_copy(tmp_path):
    pipeline = _hook("auto_pipeline_on_mistakes_edit")
    stale = tmp_path / ".claude" / "skills" / "mistake-brain" / "scripts"
    stale.mkdir(parents=True)
    assert pipeline._skill_scripts_dir(tmp_path) == SKILL / "scripts"


# ---------- the Checker ----------

def _inbox(tmp_path: Path, entry: str) -> Path:
    p = tmp_path / "MISTAKES.md"
    p.write_text(init_project.MISTAKES_HEADER + init_project.MARKER + "\n\n" + entry, encoding="utf-8")
    return p


ENTRY = (
    "## [{at}] Forgot the await\n- **Type:** mistake\n- **What happened:** x\n- **Root cause:** y\n"
    "- **Consequence:** z\n- **Prevention rule:** w\n- **PARA route:** unrouted\n{status}"
)


def test_a_missing_status_is_named_as_such(tmp_path):
    p = _inbox(tmp_path, ENTRY.format(at="2026-10-25 10:12", status=""))
    messages = [v.message for v in validate_mistakes.validate(p, now=datetime(2026, 10, 25, 12, 0)).violations]
    assert any(m.startswith("Missing Status field") for m in messages)


def test_a_header_dated_in_the_future_is_flagged(tmp_path):
    p = _inbox(tmp_path, ENTRY.format(at="2026-10-25 14:00", status="- **Status:** unrouted\n"))
    now = datetime(2026, 10, 25, 12, 0)
    assert any("in the future" in v.message for v in validate_mistakes.validate(p, now=now).violations)
    ok = _inbox(tmp_path, ENTRY.format(at="2026-10-25 12:03", status="- **Status:** unrouted\n"))
    assert validate_mistakes.validate(ok, now=now).violations == []


# ---------- the command is the plugin's ----------

def test_no_bare_mistake_brain_command_is_left_in_the_skill():
    for p in list(SKILL.rglob("*.md")) + list(SKILL.rglob("*.py")):
        text = p.read_text(encoding="utf-8")
        bare = re.findall(r"(?<![\w./:-])/mistake-brain\b", text)
        assert not bare, f"{p.relative_to(SKILL)} still says /mistake-brain"


def test_scripts_are_run_from_the_skill_folder_not_a_global_copy():
    for p in SKILL.rglob("*.md"):
        text = p.read_text(encoding="utf-8")
        for m in re.finditer(r"python3? \S*\.claude/skills/mistake-brain\S*", text):
            pytest.fail(f"{p.relative_to(SKILL)} runs a script from a copy: {m.group(0)}")
