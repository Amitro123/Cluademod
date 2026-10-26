"""Guard against duplicated mistake-brain hook implementations."""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
CANONICAL_HOOKS_DIR = (
    REPO_ROOT / "skills" / "mistake-brain" / "hooks"
)
HOOK_NAMES = (
    "draft_mistake_on_revert.py",
    "brief_on_session_start.py",
)
SCANNED_ROOTS = (
    REPO_ROOT / ".claude",
    REPO_ROOT / ".agent-brain",
)


def _scanned_files() -> list[Path]:
    return [
        path
        for root in SCANNED_ROOTS
        if root.exists()
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    ]


@pytest.mark.parametrize("hook_name", HOOK_NAMES)
def test_hook_has_one_canonical_copy(hook_name: str) -> None:
    canonical = CANONICAL_HOOKS_DIR / hook_name
    assert canonical.is_file(), f"Canonical hook is missing: {canonical}"

    canonical_hash = hashlib.sha256(canonical.read_bytes()).digest()
    duplicates = []
    for candidate in _scanned_files():
        if candidate == canonical:
            continue
        if (
            candidate.name == hook_name
            or hashlib.sha256(candidate.read_bytes()).digest() == canonical_hash
        ):
            duplicates.append(candidate.relative_to(REPO_ROOT))

    assert not duplicates, (
        f"{hook_name} must exist only at "
        f"{canonical.relative_to(REPO_ROOT)}; duplicate path(s): "
        + ", ".join(str(path) for path in duplicates)
    )
