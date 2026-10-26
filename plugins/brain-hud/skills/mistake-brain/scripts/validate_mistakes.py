#!/usr/bin/env python3
"""Validate MISTAKES.md format compliance.

Checks that every entry has all required fields for its Type and that
Status/PARA route values are well-formed. Does NOT modify any file.

Usage:
    python <skill_root>/scripts/validate_mistakes.py [MISTAKES_MD_PATH]

Defaults to MISTAKES.md in the current working directory.

Exit codes:
    0 — all entries valid
    1 — one or more violations found (details printed to stdout)
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

# Required fields per Type (in addition to Type, PARA route, Status)
REQUIRED_FIELDS: dict[str, list[str]] = {
    "mistake": ["What happened", "Root cause", "Consequence", "Prevention rule"],
    "success": ["What happened", "Success pattern", "Impact", "Repeat guidance"],
    "decision": ["What happened", "Rationale", "Alternatives considered", "Impact"],
    "handoff": ["What happened", "Context needed", "Next steps"],
}

VALID_STATUSES = {"unrouted", "routed", "promoted"}

# Boundary detector: any "## [...] title" line, regardless of what's inside the
# brackets. Deliberately lenient — a header whose timestamp doesn't match
# TIMESTAMP_RE below must still be *seen* as an entry and flagged, not silently
# excluded from `entries` the way a stricter anchored regex would do (this
# already happened once: a header missing its HH:MM time component made the
# entire entry invisible to this validator, reporting a false "OK").
_ENTRY_RE = re.compile(r"^## \[([^\]]*)\] .+$", re.MULTILINE)
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
_FIELD_RE = re.compile(r"^\s*- \*\*(.+?):\*\*\s*(.*)$")


@dataclass
class Violation:
    entry_title: str
    line: int
    message: str


@dataclass
class ValidationResult:
    violations: list[Violation] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return len(self.violations) == 0


def _parse_entries(text: str) -> list[tuple[int, str, str]]:
    """Return list of (line_number, title, entry_body) for each entry."""
    entries = []
    lines = text.splitlines()
    positions = [
        (i + 1, lines[i]) for i in range(len(lines)) if _ENTRY_RE.match(lines[i])
    ]
    for idx, (lineno, header) in enumerate(positions):
        title = header[3:].strip()  # strip "## "
        start = lineno  # 1-indexed
        end = positions[idx + 1][0] - 1 if idx + 1 < len(positions) else len(lines)
        body = "\n".join(lines[start:end])
        entries.append((lineno, title, body))
    return entries


def _header_timestamp(title: str) -> str | None:
    """Pull the bracketed timestamp back out of a parsed entry's title.

    ``_parse_entries`` strips the leading ``## `` but keeps ``[...] rest``.
    Returns the raw bracket content so ``validate`` can check its format.
    """
    m = re.match(r"^\[([^\]]*)\]", title)
    return m.group(1) if m else None


def _extract_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in body.splitlines():
        m = _FIELD_RE.match(line)
        if m:
            fields[m.group(1).strip()] = m.group(2).strip()
    return fields


def _is_future(timestamp: str, now: datetime) -> bool:
    """A header more than a few minutes ahead of the clock was guessed, not read."""
    try:
        at = datetime.strptime(timestamp, "%Y-%m-%d %H:%M")
    except ValueError:
        return False
    return at > now + timedelta(minutes=5)


def validate(mistakes_path: Path, now: datetime | None = None) -> ValidationResult:
    now = now or datetime.now()
    result = ValidationResult()
    text = mistakes_path.read_text(encoding="utf-8")

    # Strip everything before the marker
    marker = (
        "<!-- mistake-brain: new entries are inserted immediately below this line -->"
    )
    marker_pos = text.find(marker)
    if marker_pos == -1:
        result.violations.append(
            Violation(
                entry_title="<file>",
                line=1,
                message="Marker comment not found — file may not be initialized",
            )
        )
        return result
    text = text[marker_pos + len(marker) :]

    entries = _parse_entries(text)
    if not entries:
        return result  # empty inbox is fine

    for lineno, title, body in entries:
        fields = _extract_fields(body)

        # Header timestamp — format-spec.md requires "[YYYY-MM-DD HH:MM]", no
        # exceptions. A malformed or missing time component must surface here,
        # not vanish silently the way a stricter entry-boundary regex would.
        timestamp = _header_timestamp(title)
        if timestamp is not None and _TIMESTAMP_RE.match(timestamp) and _is_future(timestamp, now):
            result.violations.append(
                Violation(
                    entry_title=title,
                    line=lineno,
                    message=(
                        f"Header timestamp '{timestamp}' is in the future: take the time "
                        "from the shell (date '+%Y-%m-%d %H:%M'), don't guess it"
                    ),
                )
            )
        if timestamp is None or not _TIMESTAMP_RE.match(timestamp):
            result.violations.append(
                Violation(
                    entry_title=title,
                    line=lineno,
                    message=(
                        f"Header timestamp '{timestamp}' must match "
                        "'YYYY-MM-DD HH:MM' (e.g. '2026-09-22 11:49')"
                    ),
                )
            )

        # Type field — missing Type is a pre-schema entry; treat as "mistake"
        # (backward compat: format-spec documents this default, validator must implement it)
        entry_type = fields.get("Type", "").lower()
        if not entry_type:
            entry_type = "mistake"
        elif entry_type not in REQUIRED_FIELDS:
            result.violations.append(
                Violation(
                    entry_title=title,
                    line=lineno,
                    message=f"Unknown Type '{entry_type}' (expected: {', '.join(REQUIRED_FIELDS)})",
                )
            )
            continue

        # Required fields for this Type
        for required in REQUIRED_FIELDS[entry_type]:
            if required not in fields or not fields[required]:
                result.violations.append(
                    Violation(
                        entry_title=title,
                        line=lineno,
                        message=f"Missing or empty required field '{required}' for Type: {entry_type}",
                    )
                )

        # Status: a missing one is its own message, so it's fixed at log time
        # instead of an entry the router can't match.
        status = fields.get("Status", "").lower()
        if "Status" not in fields:
            result.violations.append(
                Violation(
                    entry_title=title,
                    line=lineno,
                    message="Missing Status field (a new entry is '- **Status:** unrouted')",
                )
            )
        elif status not in VALID_STATUSES:
            result.violations.append(
                Violation(
                    entry_title=title,
                    line=lineno,
                    message=f"Invalid Status '{status}' (expected: {', '.join(sorted(VALID_STATUSES))})",
                )
            )

        # PARA route — must be "unrouted" or start with a PARA category
        para = fields.get("PARA route", "")
        if para and para.lower() != "unrouted":
            if not any(
                para.startswith(cat)
                for cat in ("Project", "Area", "Resource", "Archive")
            ):
                result.violations.append(
                    Violation(
                        entry_title=title,
                        line=lineno,
                        message=f"PARA route '{para}' doesn't start with a valid category",
                    )
                )

    return result


def main(path: Path) -> int:
    if not path.exists():
        print(f"[validate-mistakes] File not found: {path}", file=sys.stderr)
        return 1

    result = validate(path)
    if result.ok:
        print(f"[validate-mistakes] {path}: OK — no violations found")
        return 0

    print(f"[validate-mistakes] {path}: {len(result.violations)} violation(s)")
    for v in result.violations:
        print(f"  line {v.line}: [{v.entry_title}] — {v.message}")
    return 1


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "MISTAKES.md"
    sys.exit(main(target))
