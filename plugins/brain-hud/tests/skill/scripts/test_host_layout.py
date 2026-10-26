"""Tests for host_layout.py, focused on the shared-memory-index refactor.

No test file existed for this module before. It now owns the highest-risk
new logic in the shared-index migration (migrate_shared_memory_index), so
it gets direct coverage rather than only the indirect exercise it got via
init_project.py / index_admission.py tests.

Run: pytest tests/scripts/test_host_layout.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import host_layout  # noqa: E402


def test_memory_path_is_identical_for_every_host(tmp_path):
    assert host_layout.memory_path(tmp_path, "claude") == host_layout.memory_path(tmp_path, "cursor")
    assert host_layout.memory_path(tmp_path, "claude") == tmp_path / ".agent-brain" / "shared" / "MEMORY.md"


def test_memory_path_rejects_unknown_host(tmp_path):
    import pytest
    with pytest.raises(ValueError, match="unknown host"):
        host_layout.memory_path(tmp_path, "vscode")


def test_memory_header_has_no_host_parameter_and_is_neutral():
    text = host_layout.memory_header()
    assert "shared session index" in text
    assert "only the `claude`" not in text
    assert "only the `cursor`" not in text
    for section in ("## Projects", "## Areas", "## Resources", "## Archives", "## Rules promoted so far"):
        assert section in text


# --- migrate_shared_memory_index ------------------------------------------

def _legacy_body(marker: str) -> str:
    return (
        "Format per line: `- [PARA-type] file — one-line summary (N lessons, last updated YYYY-MM-DD)`\n\n"
        "## Projects\n"
        f"- [Project] Projects/{marker}.md — {marker} lesson (1 lesson, last updated 2026-09-01)\n\n"
        "## Areas\n_(none yet)_\n\n"
        "## Resources\n_(none yet)_\n\n"
        "## Archives\nArchives: 0 files (not loaded at session start)\n\n"
        "## Rules promoted so far\n_(none yet)_\n"
    )


def _write_legacy(project_dir: Path, host: str, body: str) -> Path:
    path = host_layout.legacy_memory_path(project_dir, host)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# MEMORY.md — index for agent `{host}`\n\n{body}", encoding="utf-8")
    return path


def test_nothing_to_migrate_when_no_legacy_files_exist(tmp_path):
    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "nothing_to_migrate"
    assert not host_layout.memory_path(tmp_path, "claude").exists()


def test_already_shared_is_a_noop_even_with_legacy_files_present(tmp_path):
    shared = host_layout.memory_path(tmp_path, "claude")
    shared.parent.mkdir(parents=True, exist_ok=True)
    shared.write_text("# MEMORY.md — shared session index\n\nreal content\n", encoding="utf-8")
    _write_legacy(tmp_path, "claude", _legacy_body("old"))

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "already_shared"
    assert shared.read_text(encoding="utf-8") == "# MEMORY.md — shared session index\n\nreal content\n"


def test_migrates_single_legacy_claude_file(tmp_path):
    _write_legacy(tmp_path, "claude", _legacy_body("auth"))

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "migrated"

    shared_text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert "shared session index" in shared_text
    assert "auth lesson" in shared_text

    # Older installs still read the legacy path; it must keep the lessons
    # (not a bare pointer stub) and point at the shared file.
    legacy_text = host_layout.legacy_memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert ".agent-brain/shared/MEMORY.md" in legacy_text
    assert "auth lesson" in legacy_text


def test_migrates_single_legacy_cursor_file(tmp_path):
    _write_legacy(tmp_path, "cursor", _legacy_body("ci"))

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "migrated"
    shared_text = host_layout.memory_path(tmp_path, "cursor").read_text(encoding="utf-8")
    assert "ci lesson" in shared_text


def test_old_per_host_rules_placeholder_wording_is_not_treated_as_drift(tmp_path):
    """Regression: the pre-refactor memory_header() templated the empty
    'Rules promoted so far' placeholder differently per host ('see CLAUDE.md
    and .claude/rules/' vs 'see .cursor/rules/') -- boilerplate about *where*
    rules live, not a lesson. Two files that agree on every real lesson but
    differ only in that placeholder's wording must still migrate cleanly."""
    claude_body = _legacy_body("auth").replace(
        "## Rules promoted so far\n_(none yet)_\n",
        "## Rules promoted so far\n_(none yet — see CLAUDE.md and .claude/rules/ for the live rules)_\n",
    )
    cursor_body = _legacy_body("auth").replace(
        "## Rules promoted so far\n_(none yet)_\n",
        "## Rules promoted so far\n_(none yet — see `.cursor/rules/` for the live rules)_\n",
    )
    _write_legacy(tmp_path, "claude", claude_body)
    _write_legacy(tmp_path, "cursor", cursor_body)

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "migrated"
    shared_text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert "auth lesson" in shared_text


def test_a_real_rules_difference_still_counts_as_drift(tmp_path):
    """The placeholder-wording normalization must not swallow an ACTUAL
    difference in which rules were promoted."""
    claude_body = _legacy_body("auth").replace(
        "## Rules promoted so far\n_(none yet)_\n",
        "## Rules promoted so far\n- Always await DB writes (from 3 entries)\n",
    )
    cursor_body = _legacy_body("auth")  # still "_(none yet)_"
    _write_legacy(tmp_path, "claude", claude_body)
    _write_legacy(tmp_path, "cursor", cursor_body)

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "drift"


def test_migrates_two_identical_legacy_files_without_drift(tmp_path):
    body = _legacy_body("payments")
    _write_legacy(tmp_path, "claude", body)
    _write_legacy(tmp_path, "cursor", body)

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "migrated"
    shared_text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert "payments lesson" in shared_text
    assert shared_text.count("payments lesson") == 1

    # Both legacy files become compatibility copies, not deleted or emptied.
    for host in host_layout.LESSON_HOSTS:
        legacy_text = host_layout.legacy_memory_path(tmp_path, host).read_text(encoding="utf-8")
        assert ".agent-brain/shared/MEMORY.md" in legacy_text
        assert legacy_text.count("payments lesson") == 1


def test_pre_shared_index_reader_still_briefs_lessons_after_migration(tmp_path):
    """Regression: a globally installed skill from before the shared index
    reads the legacy per-host path. Migration must not leave that reader with
    a pointer stub and zero lessons while installs are being upgraded."""
    _write_legacy(tmp_path, "cursor", _legacy_body("deploy"))
    host_layout.migrate_shared_memory_index(tmp_path)

    old_reader_text = (
        tmp_path / ".cursor" / "agent-memory" / "cursor" / "MEMORY.md"
    ).read_text(encoding="utf-8")
    assert "deploy lesson" in old_reader_text
    assert "## Projects" in old_reader_text


def test_drift_between_legacy_files_is_reported_not_resolved_silently(tmp_path):
    _write_legacy(tmp_path, "claude", _legacy_body("auth"))
    _write_legacy(tmp_path, "cursor", _legacy_body("different-topic"))

    result = host_layout.migrate_shared_memory_index(tmp_path)
    assert result["status"] == "drift"
    # Nothing written on drift -- no shared file, legacy files untouched.
    assert not host_layout.memory_path(tmp_path, "claude").exists()
    claude_legacy = host_layout.legacy_memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert "auth lesson" in claude_legacy
    cursor_legacy = host_layout.legacy_memory_path(tmp_path, "cursor").read_text(encoding="utf-8")
    assert "different-topic lesson" in cursor_legacy


def test_migration_is_idempotent_after_success(tmp_path):
    _write_legacy(tmp_path, "claude", _legacy_body("auth"))
    first = host_layout.migrate_shared_memory_index(tmp_path)
    assert first["status"] == "migrated"
    second = host_layout.migrate_shared_memory_index(tmp_path)
    assert second["status"] == "already_shared"
