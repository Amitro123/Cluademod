"""Contract tests for promote.md.

Regression guard: promote.md's check_repetition.py invocation once used a
project-relative path (``.claude/skills/mistake-brain/scripts/...``), which
only happens to exist in this source repo's own dogfood checkout. Every
consumer project -- the actual target of this skill -- has the Python only
at the global install (``~/.claude/skills/mistake-brain/...``, same as
router.md's compose_mistakes.py invocation), so the documented command would
fail with "file not found" anywhere else. See MISTAKES.md [2026-10-05].

Run: pytest tests/scripts/test_promote_contract.py -v
"""
from __future__ import annotations

from pathlib import Path

PROMOTE_PATH = (
    Path(__file__).resolve().parents[3]
    / "skills" / "mistake-brain"
    / "promote.md"
)


def _promote_text() -> str:
    return PROMOTE_PATH.read_text(encoding="utf-8")


def test_check_repetition_is_invoked_from_the_skill_folder() -> None:
    text = _promote_text()
    assert "<skill_root>/scripts/check_repetition.py" in text
    # Never a copy in the project or in ~/.claude, which may be an older version.
    assert ".claude/skills/mistake-brain/scripts/check_repetition.py" not in text


def test_existing_promote_contract_remains_documented() -> None:
    text = _promote_text()
    required_contracts = (
        "--min-count 2 --json",
        "Type: decision` and `Type: handoff` entries are never promotion candidates",
        "do not write anything yet",
        "AGENT_AUTO_IMPROVE",
        "update its `Status` field to `promoted`",
        ".agent-brain/shared/MEMORY.md",
    )
    for contract in required_contracts:
        assert contract in text, f"promote.md lost existing behavior: {contract}"
