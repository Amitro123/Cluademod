"""Contract tests for the agent-executed routing procedure."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest


ROUTER_PATH = (
    Path(__file__).resolve().parents[3]
    / "skills" / "mistake-brain"
    / "router.md"
)
REQUIRED_ENTRY_FIELDS = {
    "source_entry",
    "destination_file",
    "para_bucket",
    "priority",
    "promotion",
    "conflict",
    "reasoning",
}
PARA_BUCKETS = {"Project", "Area", "Resource", "Archive"}


def _router_text() -> str:
    return ROUTER_PATH.read_text(encoding="utf-8")


def _json_example(name: str) -> dict:
    pattern = (
        rf"<!-- ROUTING_JSON_{name}_EXAMPLE -->\s*"
        rf"```json\s*(\{{.*?\}})\s*```"
    )
    match = re.search(pattern, _router_text(), re.DOTALL)
    assert match, f"router.md is missing the {name.lower()} JSON example"
    return json.loads(match.group(1))


def test_existing_route_procedure_contract_remains_documented() -> None:
    text = _router_text()
    required_contracts = (
        "python <skill_root>/scripts/compose_mistakes.py MISTAKES.md",
        r"^- \*\*Status:\*\*\s*unrouted\s*$",
        "oldest-to-newest order",
        "Group the classified entries by destination file",
        "- Added: YYYY-MM-DD HH:MM",
        "make these edits in a single `MultiEdit` call",
        ".agent-brain/shared/",
        ".agent-brain/shared/MEMORY.md",
        "Don't ask for confirmation for this pass",
        "MISTAKE_BRAIN_INDEX_GATE=1",
        "When that variable is unset or any value other than `1`, do step 6 exactly as written above",
        "Do not enable the gate from `init`",
        "scripts/index_admission.py",
        (
            "emit `ROUTING_JSON:` followed on the next line by "
            '`{"routed_count":0,"routed_entries":[]}`'
        ),
    )

    for contract in required_contracts:
        assert contract in text, f"router.md lost existing behavior: {contract}"


@pytest.mark.parametrize("name", ("NON_EMPTY", "EMPTY"))
def test_routing_json_example_is_well_formed(name: str) -> None:
    summary = _json_example(name)

    assert set(summary) == {"routed_count", "routed_entries"}
    assert summary["routed_count"] == len(summary["routed_entries"])
    for entry in summary["routed_entries"]:
        assert set(entry) == REQUIRED_ENTRY_FIELDS
        assert entry["para_bucket"] in PARA_BUCKETS
        assert entry["priority"] is None
        assert entry["promotion"] is False
        assert entry["conflict"] is None
        assert isinstance(entry["reasoning"], str) and entry["reasoning"].strip()


def test_empty_routing_json_example_has_no_entries() -> None:
    summary = _json_example("EMPTY")

    assert summary == {"routed_count": 0, "routed_entries": []}
