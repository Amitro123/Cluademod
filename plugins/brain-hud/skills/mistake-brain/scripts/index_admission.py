#!/usr/bin/env python3
"""Decide whether route may update the session indexes, and apply an approval.

Route still writes the shared lesson either way. The index line is the part
that enters every later briefing.

    MISTAKE_BRAIN_INDEX_GATE unset or not "1"  -> route_indexes_now() is True
    MISTAKE_BRAIN_INDEX_GATE=1                  -> route_indexes_now() is False

Approval always writes the same bullet into both harness indexes. It does
not turn the gate on, and init does not turn the gate on.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import host_layout  # noqa: E402

_SECTION = {"Project": "Projects", "Area": "Areas", "Resource": "Resources"}
_LINE_RE = re.compile(r"^- \[(\w+)\] (\S+) — .+$")


def route_indexes_now() -> bool:
    """True when route should refresh MEMORY.md in the same pass as the lesson."""
    return not host_layout.index_gate_enabled()


def approve_index_line(project_dir: Path, line: str) -> None:
    """Put one index bullet into the shared MEMORY.md, read by every harness."""
    bullet = line.strip()
    if not bullet.startswith("- "):
        bullet = "- " + bullet
    match = _LINE_RE.match(bullet)
    if not match:
        raise ValueError(
            "index line must look like '- [Area] Areas/file.md — summary (...)'"
        )
    section = _SECTION.get(match.group(1))
    if section is None:
        raise ValueError(
            f"{match.group(1)} is not an indexed bucket; Archives stay off the hot index"
        )
    slug = match.group(2)
    path = host_layout.memory_path(project_dir, "claude")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        text = path.read_text(encoding="utf-8")
    else:
        # memory_header() already has a "## {section}\n_(none yet)_" block
        # for every PARA section -- appending another one here duplicated
        # the header and left a dead "_(none yet)_" stub at EOF.
        text = host_layout.memory_header()
    path.write_text(_upsert(text, section, slug, bullet), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Write one approved index bullet into both harness indexes.")
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--line", required=True)
    args = parser.parse_args(argv)
    approve_index_line(Path(args.project_dir), args.line)
    return 0


def _upsert(text: str, section: str, slug: str, bullet: str) -> str:
    lines = text.splitlines()
    header = f"## {section}"
    if header not in lines:
        if lines and lines[-1] != "":
            lines.append("")
        lines.extend([header, bullet])
        return "\n".join(lines) + "\n"
    start = lines.index(header)
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    for i in range(start + 1, end):
        if slug in lines[i] and lines[i].lstrip().startswith("- ["):
            lines[i] = bullet
            return "\n".join(lines) + "\n"
    for i in range(start + 1, end):
        if lines[i].strip() == "_(none yet)_":
            lines[i] = bullet
            return "\n".join(lines) + "\n"
    lines.insert(end, bullet)
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
