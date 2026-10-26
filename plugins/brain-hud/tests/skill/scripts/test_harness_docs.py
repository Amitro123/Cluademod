"""Skill docs name the real per-harness paths, so Cursor is not sent to a Claude path."""
from __future__ import annotations

from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[3] / "skills" / "mistake-brain"
DOCS = sorted([*SKILL.glob("*.md"), *(SKILL / "references").glob("*.md")])
STALE = (
    ".claude/agent-memory/<agent>/",
    ".agent-brain/<agent>/",
    ".agent-brain/<agent-name>/",
    "Cursor does not run",
)


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: p.name)
def test_doc_has_no_stale_harness_path(doc: Path) -> None:
    text = doc.read_text(encoding="utf-8")
    found = [s for s in STALE if s in text]
    assert not found, f"{doc.name} still says {found}"


def test_recall_names_the_shared_index() -> None:
    text = (SKILL / "references" / "recall.md").read_text(encoding="utf-8")
    assert ".agent-brain/shared/MEMORY.md" in text


@pytest.mark.parametrize("doc", DOCS, ids=lambda p: p.name)
def test_doc_has_no_legacy_per_harness_memory_path(doc: Path) -> None:
    """Regression guard for the shared-index refactor: no doc should point
    an agent at the old per-harness MEMORY.md paths (see MISTAKES.md
    [2026-10-05], shared-memory-index refactor)."""
    text = doc.read_text(encoding="utf-8")
    legacy = (
        ".claude/agent-memory/claude/MEMORY.md",
        ".cursor/agent-memory/cursor/MEMORY.md",
    )
    found = [s for s in legacy if s in text]
    assert not found, f"{doc.name} still names legacy per-harness path(s) {found}"
