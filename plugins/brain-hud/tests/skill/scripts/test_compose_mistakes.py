"""Behavioral tests for compose_mistakes.py.

Previously only referenced by doc-contract tests (confirming router.md/
promote.md *mention* it); its own archiving/parsing logic had no direct
test coverage.

Run: pytest tests/scripts/test_compose_mistakes.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import compose_mistakes  # noqa: E402

MARKER = compose_mistakes.MARKER


def _entry(date, title, status) -> str:
    return (
        f"## [{date}] {title}\n"
        f"- **Type:** mistake\n"
        f"- **What happened:** x\n"
        f"- **Root cause:** x\n"
        f"- **Consequence:** x\n"
        f"- **Prevention rule:** x\n"
        f"- **PARA route:** {'unrouted' if status == 'unrouted' else 'Area: Areas/x.md'}\n"
        f"- **Status:** {status}\n\n"
    )


def _write(tmp_path: Path, entries: str) -> Path:
    path = tmp_path / "MISTAKES.md"
    path.write_text(f"# MISTAKES.md\n\n{MARKER}\n\n{entries}", encoding="utf-8")
    return path


def test_under_threshold_is_a_noop(tmp_path, capsys):
    path = _write(tmp_path, _entry("2026-01-01 10:00", "a", "routed"))
    import subprocess, sys as _sys
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(path), "--max-lines", "400"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "under the 400-line threshold" in result.stdout
    assert not (tmp_path / "MISTAKES-archive.md").exists()


def test_over_threshold_with_only_unrouted_entries_is_a_noop(tmp_path):
    import subprocess, sys as _sys
    entries = "".join(_entry(f"2026-01-{i:02d} 10:00", f"entry {i}", "unrouted") for i in range(1, 60))
    path = _write(tmp_path, entries)
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(path), "--max-lines", "10"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "nothing safe to archive yet" in result.stdout
    assert not (tmp_path / "MISTAKES-archive.md").exists()


def test_over_threshold_archives_oldest_routed_entries_first(tmp_path):
    import subprocess, sys as _sys
    entries = (
        _entry("2026-01-01 10:00", "oldest", "routed")
        + _entry("2026-01-02 10:00", "middle", "routed")
        + _entry("2026-01-03 10:00", "newest", "unrouted")
    )
    path = _write(tmp_path, entries)
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(path), "--max-lines", "5"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    remaining = path.read_text(encoding="utf-8")
    assert "newest" in remaining
    # unrouted entries are never archived, even when over threshold.
    archive = (tmp_path / "MISTAKES-archive.md").read_text(encoding="utf-8")
    assert "oldest" in archive
    # Archive is newest-of-the-moved-batch first.
    assert archive.index("middle") < archive.index("oldest")


def test_archiving_collapses_orphaned_blank_lines(tmp_path):
    import subprocess, sys as _sys
    entries = (
        _entry("2026-01-01 10:00", "a", "routed")
        + _entry("2026-01-02 10:00", "b", "routed")
        + _entry("2026-01-03 10:00", "c", "unrouted")
    )
    path = _write(tmp_path, entries)
    subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(path), "--max-lines", "3"],
        capture_output=True, text=True,
    )
    remaining = path.read_text(encoding="utf-8")
    archive = (tmp_path / "MISTAKES-archive.md").read_text(encoding="utf-8")
    assert "\n\n\n" not in remaining
    assert "\n\n\n" not in archive


def test_dry_run_moves_nothing(tmp_path):
    import subprocess, sys as _sys
    entries = _entry("2026-01-01 10:00", "a", "routed") + _entry("2026-01-02 10:00", "b", "unrouted")
    path = _write(tmp_path, entries)
    before = path.read_text(encoding="utf-8")
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(path), "--max-lines", "1", "--dry-run"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "would move" in result.stdout
    assert path.read_text(encoding="utf-8") == before
    assert not (tmp_path / "MISTAKES-archive.md").exists()


def test_missing_file_errors(tmp_path):
    import subprocess, sys as _sys
    missing = tmp_path / "nope.md"
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "compose_mistakes.py"), str(missing)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "not found" in result.stderr
