"""Tests for init_project.py

Run: pytest tests/scripts/test_init_project.py -v
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import init_project  # noqa: E402  (import after sys.path manipulation)

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"


@pytest.fixture()
def project_dir(tmp_path):
    return tmp_path / "project"


@pytest.fixture()
def skill_dir(tmp_path):
    sd = tmp_path / "skill"
    hook_dir = sd / "hooks"
    hook_dir.mkdir(parents=True)
    (hook_dir / "draft_mistake_on_revert.py").write_text(
        "# version: 1.1.0\n# stub hook\n", encoding="utf-8"
    )
    (hook_dir / "brief_on_session_start.py").write_text(
        "# version: 1.0.0\n# stub brief hook\n", encoding="utf-8"
    )
    (hook_dir / "revert_stop_hook.py").write_text(
        "# version: 1.0.0\n# stub stop hook\n", encoding="utf-8"
    )
    (hook_dir / "auto_pipeline_on_mistakes_edit.py").write_text(
        "# version: 1.3.0\n# stub pipeline hook\n", encoding="utf-8"
    )
    (hook_dir / "draft_mistake_on_validation_failure.py").write_text(
        "# version: 1.0.0\n# stub validation-failure hook\n", encoding="utf-8"
    )
    return sd


def test_creates_mistakes_md(project_dir, skill_dir):
    project_dir.mkdir()
    result = init_project.main(project_dir, skill_dir)
    mistakes = project_dir / "MISTAKES.md"
    assert mistakes.exists()
    assert MARKER in mistakes.read_text(encoding="utf-8")
    assert "MISTAKES.md" in result.created


def test_moves_legacy_claude_lessons_into_the_shared_store(project_dir, skill_dir):
    project_dir.mkdir()
    legacy = project_dir / ".agent-brain" / "claude" / "Areas"
    legacy.mkdir(parents=True)
    (legacy / "ci.md").write_text("# ci\n", encoding="utf-8")
    init_project.main(project_dir, skill_dir)
    shared = project_dir / ".agent-brain" / "shared" / "Areas" / "ci.md"
    assert shared.read_text(encoding="utf-8") == "# ci\n"
    assert not (legacy / "ci.md").exists()
    memory_index = project_dir / ".agent-brain" / "shared" / "MEMORY.md"
    assert memory_index.exists()
    assert ".agent-brain/shared/" in memory_index.read_text(encoding="utf-8")


def test_creates_all_para_dirs(project_dir, skill_dir):
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    base = project_dir / ".agent-brain" / "shared"
    for folder in ("Projects", "Areas", "Resources", "Archives"):
        assert (base / folder).is_dir(), f"Missing {folder}/ directory"
        # No README.md — directories only, no scaffolding clutter
        assert not (base / folder / "README.md").exists(), f"Unexpected README in {folder}/"


def test_creates_rules_file(project_dir, skill_dir):
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    rules = project_dir / ".claude" / "rules" / "mistake-brain.md"
    assert rules.exists()
    assert "/brain-hud:mistake-brain log" in rules.read_text(encoding="utf-8")


def test_creates_memory_md(project_dir, skill_dir):
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    memory = project_dir / ".agent-brain" / "shared" / "MEMORY.md"
    assert memory.exists()
    text = memory.read_text(encoding="utf-8")
    for section in ("## Projects", "## Areas", "## Resources", "## Archives"):
        assert section in text
    assert "not loaded at session start" in text


def test_does_not_create_legacy_per_harness_memory_files(project_dir, skill_dir):
    """One shared index now -- init must not also scaffold the old
    per-harness paths alongside it."""
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    assert not (project_dir / ".claude" / "agent-memory" / "claude" / "MEMORY.md").exists()
    assert not (project_dir / ".cursor" / "agent-memory" / "cursor" / "MEMORY.md").exists()


def test_does_not_copy_python_hooks_into_the_project(project_dir, skill_dir):
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    assert not (project_dir / ".claude" / "hooks" / "draft_mistake_on_revert.py").exists()
    assert not (project_dir / ".claude" / "hooks" / "brief_on_session_start.py").exists()
    # The hooks are the plugin's: init registers none in the project's settings.
    assert not (project_dir / ".claude" / "settings.json").exists()
    assert not (project_dir / ".claude" / "settings.local.json").exists()


def test_idempotent_when_already_initialized(project_dir, skill_dir):
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)
    # Append a custom entry to MISTAKES.md
    mistakes = project_dir / "MISTAKES.md"
    mistakes.write_text(
        mistakes.read_text(encoding="utf-8") + "\n## custom entry\n",
        encoding="utf-8",
    )
    result = init_project.main(project_dir, skill_dir)
    assert result.already_initialized is True
    assert "custom entry" in mistakes.read_text(encoding="utf-8")  # not overwritten


def test_guard_raises_when_brief_hook_missing(project_dir, tmp_path):
    sd = tmp_path / "skill-no-brief"
    hook_dir = sd / "hooks"
    hook_dir.mkdir(parents=True)
    (hook_dir / "draft_mistake_on_revert.py").write_text(
        "# version: 1.1.0\n", encoding="utf-8"
    )
    (hook_dir / "revert_stop_hook.py").write_text(
        "# version: 1.0.0\n", encoding="utf-8"
    )
    (hook_dir / "auto_pipeline_on_mistakes_edit.py").write_text(
        "# version: 1.3.0\n", encoding="utf-8"
    )
    project_dir.mkdir()
    with pytest.raises(FileNotFoundError, match="brief_on_session_start"):
        init_project.main(project_dir, sd)


def test_inits_any_project_including_skill_source_repo_names(tmp_path, skill_dir):
    project = tmp_path / "my-skill-repo"
    project.mkdir()
    result = init_project.main(project, skill_dir)
    assert result.refused is None
    assert (project / "MISTAKES.md").exists()


def test_para_dirs_not_reported_as_created_on_second_run(project_dir, skill_dir):
    """Regression: the PARA-dir loop unconditionally appended to
    result.created regardless of whether mkdir actually created anything,
    which was invisible while init short-circuited on an already-initialized
    project, but became a false "repaired" report once steps 2-6 always run."""
    project_dir.mkdir()
    init_project.main(project_dir, skill_dir)

    # Nothing else changed -- a second run should report a clean no-op, not
    # "repaired" PARA directories that were never actually missing.
    result = init_project.main(project_dir, skill_dir)

    assert result.already_initialized is True
    assert result.created == []
    assert any(".agent-brain/shared/Projects/" in item for item in result.skipped)
