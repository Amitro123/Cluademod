"""Tests for check_repetition.py

No test file existed for this script before (found during a pre-share gap
review alongside the same gap in validate_mistakes.py and plugin.json).

Run: pytest tests/scripts/test_check_repetition.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent.parent
    / "skills" / "mistake-brain" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import check_repetition  # noqa: E402


# root_cause -> "Root cause", success_pattern -> "Success pattern" (matches
# format-spec.md's exact, capitalized field names -- Entry.cluster_key reads
# "Root cause"/"Success pattern" verbatim, not a case-folded lookup).
_LABELS = {"root_cause": "Root cause", "success_pattern": "Success pattern"}


def _entry(date, title, type_="mistake", status="unrouted", **fields):
    lines = [f"## [{date}] {title}", f"- **Type:** {type_}"]
    for key, value in fields.items():
        label = _LABELS.get(key, key.replace("_", " "))
        lines.append(f"- **{label}:** {value}")
    lines.append(f"- **Status:** {status}")
    return "\n".join(lines) + "\n\n"


def test_three_matching_root_causes_cluster_together():
    text = (
        _entry("2026-01-01 10:00", "a", root_cause="Forgot to await the DB write")
        + _entry("2026-01-02 10:00", "b", root_cause="Forgot to await the DB write")
        + _entry("2026-01-03 10:00", "c", root_cause="Forgot to await the DB write")
    )
    entries = check_repetition.parse_entries(text)
    clusters = check_repetition.cluster_by_key(entries, threshold=0.6)
    assert len(clusters) == 1
    assert len(clusters[0]) == 3


def test_dissimilar_root_causes_do_not_cluster():
    text = (
        _entry("2026-01-01 10:00", "a", root_cause="Forgot to await the DB write")
        + _entry("2026-01-02 10:00", "b", root_cause="Unrelated regex anchoring bug")
    )
    entries = check_repetition.parse_entries(text)
    clusters = check_repetition.cluster_by_key(entries, threshold=0.6)
    assert len(clusters) == 2


def test_mistake_and_success_never_share_a_cluster():
    """cluster_by_key only sees one Type at a time (caller splits them), but
    cluster_key itself must also return '' for the other Type's field name."""
    mistake = check_repetition.Entry(
        date="2026-01-01 10:00", title="a",
        fields={"Type": "mistake", "Root cause": "Forgot to await the DB write"},
    )
    success = check_repetition.Entry(
        date="2026-01-02 10:00", title="b",
        fields={"Type": "success", "Success pattern": "Forgot to await the DB write"},
    )
    assert mistake.cluster_key == "Forgot to await the DB write"
    assert success.cluster_key == "Forgot to await the DB write"
    # But a mistake's cluster_key never reads Success pattern, and vice versa.
    cross = check_repetition.Entry(
        date="2026-01-03 10:00", title="c",
        fields={"Type": "mistake", "Success pattern": "irrelevant to a mistake"},
    )
    assert cross.cluster_key == ""


def test_decision_and_handoff_have_no_cluster_key():
    decision = check_repetition.Entry(
        date="2026-01-01 10:00", title="a", fields={"Type": "decision"}
    )
    handoff = check_repetition.Entry(
        date="2026-01-01 10:00", title="b", fields={"Type": "handoff"}
    )
    assert decision.cluster_key == ""
    assert handoff.cluster_key == ""


def test_no_type_field_defaults_to_mistake():
    entry = check_repetition.Entry(
        date="2026-01-01 10:00", title="a", fields={"Root cause": "x"}
    )
    assert entry.type == "mistake"
    assert entry.cluster_key == "x"


def test_promoted_entries_are_excluded_from_active_clustering(tmp_path):
    text = (
        _entry("2026-01-01 10:00", "a", root_cause="Forgot to await the DB write", status="promoted")
        + _entry("2026-01-02 10:00", "b", root_cause="Forgot to await the DB write")
        + _entry("2026-01-03 10:00", "c", root_cause="Forgot to await the DB write")
    )
    path = tmp_path / "MISTAKES.md"
    path.write_text(text, encoding="utf-8")
    entries = check_repetition.parse_entries(text)
    active = [e for e in entries if e.status.lower() != "promoted"]
    assert len(active) == 2  # the promoted one is excluded


def test_main_reports_repeated_group_as_json(tmp_path, capsys):
    text = (
        _entry("2026-01-01 10:00", "a", root_cause="Forgot to await the DB write")
        + _entry("2026-01-02 10:00", "b", root_cause="Forgot to await the DB write")
        + _entry("2026-01-03 10:00", "c", root_cause="Forgot to await the DB write")
    )
    path = tmp_path / "MISTAKES.md"
    path.write_text(text, encoding="utf-8")

    # main() parses sys.argv directly; drive it the same way the CLI does.
    import subprocess, sys as _sys
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "check_repetition.py"), str(path), "--json"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    import json
    payload = json.loads(result.stdout)
    assert payload["total_entries"] == 3
    assert payload["excluded_promoted"] == 0
    assert len(payload["repeated_groups"]) == 1
    assert payload["repeated_groups"][0]["count"] == 3
    assert payload["repeated_groups"][0]["type"] == "mistake"


def test_main_missing_file_errors(tmp_path):
    import subprocess, sys as _sys
    missing = tmp_path / "nope.md"
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "check_repetition.py"), str(missing)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "not found" in result.stderr


def test_main_empty_file_errors(tmp_path):
    import subprocess, sys as _sys
    path = tmp_path / "MISTAKES.md"
    path.write_text("# MISTAKES.md\n\nno entries here\n", encoding="utf-8")
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "check_repetition.py"), str(path)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "no entries found" in result.stderr


def test_min_count_two_surfaces_a_pair(tmp_path):
    import subprocess, sys as _sys, json
    text = (
        _entry("2026-01-01 10:00", "a", root_cause="Forgot to await the DB write")
        + _entry("2026-01-02 10:00", "b", root_cause="Forgot to await the DB write")
    )
    path = tmp_path / "MISTAKES.md"
    path.write_text(text, encoding="utf-8")
    result = subprocess.run(
        [_sys.executable, str(SCRIPTS_DIR / "check_repetition.py"), str(path), "--min-count", "2", "--json"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert len(payload["repeated_groups"]) == 1
    assert payload["repeated_groups"][0]["count"] == 2
