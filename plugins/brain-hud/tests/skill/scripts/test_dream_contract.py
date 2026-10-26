"""Contract tests for dream.md.

Regression guard: dream.md's step 4 originally said to regenerate MEMORY.md
"to match current reality" by scanning .agent-brain/shared/, with no mention
of the index gate -- so a dream pass could silently re-add an index line for
a lesson `route` had deliberately withheld pending approval
(MISTAKE_BRAIN_INDEX_GATE=1), bypassing scripts/index_admission.py entirely.
See MISTAKES.md [2026-10-05].

Run: pytest tests/scripts/test_dream_contract.py -v
"""
from __future__ import annotations

from pathlib import Path

DREAM_PATH = (
    Path(__file__).resolve().parents[3]
    / "skills" / "mistake-brain"
    / "references"
    / "dream.md"
)


def _dream_text() -> str:
    return DREAM_PATH.read_text(encoding="utf-8")


def test_dream_respects_the_index_gate() -> None:
    text = _dream_text()
    assert "MISTAKE_BRAIN_INDEX_GATE" in text
    assert "index_admission.py" in text
    assert "stays withheld here too" in text or "stays out until" in text


def test_existing_dream_contract_remains_documented() -> None:
    text = _dream_text()
    required_contracts = (
        ".agent-brain/shared/MEMORY.md",
        r"^- \*\*Status:\*\*\s*unrouted\s*$",
        "7+ days",
        "Archives: N files (not loaded at session start)",
        "scripts/check_repetition.py",
        "Do not expand MEMORY.md to \"be more helpful.\"",
    )
    for contract in required_contracts:
        assert contract in text, f"dream.md lost existing behavior: {contract}"
