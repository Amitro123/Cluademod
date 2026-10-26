"""Tests for validate_mistakes.py

No test file existed for this script before. Covers the regression found
during a pre-share gap review: a header missing its HH:MM time component
(``## [2026-09-22] <title>`` instead of ``## [2026-09-22 11:49] <title>``)
made the entry invisible to ``_parse_entries`` entirely, so the whole entry
-- Type, required fields, Status, everything -- was silently excluded from
validation instead of being flagged. See MISTAKES.md [2026-10-05].

Run: pytest tests/scripts/test_validate_mistakes.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import validate_mistakes  # noqa: E402

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"

VALID_MISTAKE = """\
## [2026-08-14 21:40] CI migration step failed on concurrent lock
- **Type:** mistake
- **What happened:** The DB migration step in CI failed with a lock-timeout error.
- **Root cause:** No lock file guarding concurrent migration runs.
- **Consequence:** CI run had to be manually re-triggered.
- **Prevention rule:** Acquire a lock before running a DB migration in CI.
- **PARA route:** unrouted
- **Status:** unrouted
"""


def _write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "MISTAKES.md"
    path.write_text(f"# MISTAKES.md\n\n{MARKER}\n\n{body}", encoding="utf-8")
    return path


def test_valid_entry_has_no_violations(tmp_path):
    path = _write(tmp_path, VALID_MISTAKE)
    result = validate_mistakes.validate(path)
    assert result.ok, result.violations


def test_empty_inbox_is_valid(tmp_path):
    path = _write(tmp_path, "")
    result = validate_mistakes.validate(path)
    assert result.ok


def test_header_missing_time_component_is_flagged_not_silently_dropped(tmp_path):
    """Regression: a date-only header must not vanish from validation."""
    bad = VALID_MISTAKE.replace(
        "## [2026-08-14 21:40] CI migration step failed on concurrent lock",
        "## [2026-08-14] CI migration step failed on concurrent lock",
    )
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("timestamp" in v.message.lower() for v in result.violations)
    # The entry must still be seen (and its other fields checked), not dropped.
    assert any("CI migration step" in v.entry_title for v in result.violations)


def test_header_with_garbage_timestamp_is_flagged(tmp_path):
    bad = VALID_MISTAKE.replace(
        "## [2026-08-14 21:40] CI migration step failed on concurrent lock",
        "## [not-a-date] CI migration step failed on concurrent lock",
    )
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("timestamp" in v.message.lower() for v in result.violations)


def test_missing_required_field_is_flagged(tmp_path):
    bad = VALID_MISTAKE.replace(
        "- **Root cause:** No lock file guarding concurrent migration runs.\n", ""
    )
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("Root cause" in v.message for v in result.violations)


def test_invalid_status_is_flagged(tmp_path):
    bad = VALID_MISTAKE.replace("- **Status:** unrouted", "- **Status:** done")
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("Status" in v.message for v in result.violations)


def test_missing_type_defaults_to_mistake(tmp_path):
    bad = VALID_MISTAKE.replace("- **Type:** mistake\n", "")
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    # No Type field is documented backward-compat (pre-schema entry) -- must
    # not itself be a violation, and mistake's required fields still apply.
    assert not any("Type" in v.message for v in result.violations)


def test_unknown_type_is_flagged(tmp_path):
    bad = VALID_MISTAKE.replace("- **Type:** mistake", "- **Type:** wishlist")
    path = _write(tmp_path, bad)
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("Unknown Type" in v.message for v in result.violations)


def test_missing_marker_is_flagged(tmp_path):
    path = tmp_path / "MISTAKES.md"
    path.write_text("# MISTAKES.md\n\nno marker here\n", encoding="utf-8")
    result = validate_mistakes.validate(path)
    assert not result.ok
    assert any("Marker" in v.message for v in result.violations)


def test_main_exit_codes(tmp_path, capsys):
    ok_path = _write(tmp_path, VALID_MISTAKE)
    assert validate_mistakes.main(ok_path) == 0

    bad_path = _write(tmp_path.parent, VALID_MISTAKE.replace("unrouted", "bogus"))
    assert validate_mistakes.main(bad_path) == 1

    assert validate_mistakes.main(tmp_path / "does-not-exist.md") == 1
