"""Index gate stays off unless a project opts in, and approval writes the shared index."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPTS = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain"
    / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

import host_layout  # noqa: E402
import index_admission  # noqa: E402

LINE = "- [Area] Areas/testing.md — example lesson (1 lesson, last updated 2026-09-24)"


def test_gate_off_by_default_still_indexes_on_route(monkeypatch):
    monkeypatch.delenv("MISTAKE_BRAIN_INDEX_GATE", raising=False)
    assert index_admission.route_indexes_now() is True
    monkeypatch.setenv("MISTAKE_BRAIN_INDEX_GATE", "yes")
    assert index_admission.route_indexes_now() is True


def test_gate_on_defers_the_index_until_approve(tmp_path, monkeypatch):
    monkeypatch.setenv("MISTAKE_BRAIN_INDEX_GATE", "1")
    assert index_admission.route_indexes_now() is False
    path = host_layout.memory_path(tmp_path, "claude")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(host_layout.memory_header(), encoding="utf-8")
    assert "Areas/testing.md" not in path.read_text(encoding="utf-8")

    index_admission.approve_index_line(tmp_path, LINE)
    text = path.read_text(encoding="utf-8")
    assert LINE in text
    assert text.count("Areas/testing.md") == 1


def test_init_does_not_enable_the_gate():
    source = (SCRIPTS / "init_project.py").read_text(encoding="utf-8")
    assert "MISTAKE_BRAIN_INDEX_GATE" not in source


def test_first_approval_on_a_missing_memory_file_does_not_duplicate_the_section(
    tmp_path,
):
    """Regression: approving into a not-yet-created MEMORY.md used to append a
    second, dead '## Areas\\n_(none yet)_' block after memory_header() already
    provided that section, so '## Areas' appeared twice in the same file."""
    assert not host_layout.memory_path(tmp_path, "claude").exists()

    index_admission.approve_index_line(tmp_path, LINE)

    text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert text.count("## Areas") == 1
    assert LINE in text
    # No orphaned placeholder left for the section actually populated.
    areas_section = text.split("## Areas", 1)[1].split("## Resources", 1)[0]
    assert "_(none yet)_" not in areas_section


def test_reapproving_the_same_slug_updates_in_place_not_duplicates(tmp_path):
    index_admission.approve_index_line(tmp_path, LINE)
    updated = (
        "- [Area] Areas/testing.md — example lesson, now with more detail "
        "(2 lessons, last updated 2026-09-25)"
    )
    index_admission.approve_index_line(tmp_path, updated)

    text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert text.count("Areas/testing.md") == 1
    assert updated in text
    assert LINE not in text


def test_archive_bucket_is_rejected():
    line = "- [Archive] Archives/2026/old-incident.md — closed incident (1 lesson, last updated 2026-09-24)"
    with pytest.raises(ValueError, match="Archives stay off the hot index"):
        index_admission.approve_index_line(Path("unused"), line)


def test_malformed_line_is_rejected():
    with pytest.raises(ValueError, match="index line must look like"):
        index_admission.approve_index_line(Path("unused"), "not a bullet at all")


def test_cli_main_writes_the_shared_index(tmp_path):
    exit_code = index_admission.main(["--project-dir", str(tmp_path), "--line", LINE])
    assert exit_code == 0
    text = host_layout.memory_path(tmp_path, "claude").read_text(encoding="utf-8")
    assert LINE in text
