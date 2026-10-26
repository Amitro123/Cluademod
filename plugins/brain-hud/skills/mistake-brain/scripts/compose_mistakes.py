#!/usr/bin/env python3
"""Keep MISTAKES.md from growing indefinitely.

Purely mechanical housekeeping, deliberately not an agent judgment call:
once the active log crosses a line-count threshold, move the oldest
already-processed entries (Status != unrouted — their knowledge already
lives in .agent-brain/ and possibly CLAUDE.md/.claude/rules, so the raw
copy here is just an audit trail) into a single archive file. Unrouted
entries are never moved, since the active file is their only copy.

There is deliberately only ONE archive file (default: MISTAKES-archive.md,
sibling to MISTAKES.md) rather than one per run/date — a single place to
look avoids the log's own lessons ending up scattered across many files.

Usage:
    python compose_mistakes.py [path/to/MISTAKES.md] [--max-lines 400]
                                [--archive path/to/MISTAKES-archive.md] [--dry-run]
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

ENTRY_HEADER_RE = re.compile(r"^## \[(?P<date>[^\]]+)\]\s*(?P<title>.+?)\s*$", re.MULTILINE)
STATUS_RE = re.compile(r"^- \*\*Status:\*\*\s*(?P<value>.+?)\s*$", re.MULTILINE)

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"
ARCHIVE_HEADER = (
    "# MISTAKES-archive.md\n\n"
    "Entries moved here by `scripts/compose_mistakes.py` once MISTAKES.md grew past its "
    "line threshold. Only already-routed or already-promoted entries land here — their "
    "distilled lessons live permanently in `.agent-brain/` (and, if promoted, in "
    "`CLAUDE.md`/`.claude/rules/`), so this file is historical record, not something that "
    "needs to be read for day-to-day work. `check_repetition.py` does not scan this file "
    "by design (see `promote.md`).\n\n"
)


@dataclass
class RawEntry:
    date: str
    title: str
    status: str
    text: str  # full entry text, header through the line before the next header


def parse_entries(text: str) -> list[RawEntry]:
    headers = list(ENTRY_HEADER_RE.finditer(text))
    entries = []
    for i, m in enumerate(headers):
        start = m.start()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        body = text[start:end]
        status_m = STATUS_RE.search(body)
        status = status_m.group("value") if status_m else ""
        entries.append(RawEntry(date=m.group("date"), title=m.group("title"), status=status, text=body.rstrip("\n") + "\n"))
    return entries


def parse_date(d: str) -> datetime:
    try:
        return datetime.strptime(d, "%Y-%m-%d %H:%M")
    except ValueError:
        return datetime.min


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="MISTAKES.md", help="Path to MISTAKES.md (default: ./MISTAKES.md)")
    parser.add_argument("--max-lines", type=int, default=400, help="Line threshold that triggers archiving (default: 400)")
    parser.add_argument("--archive", default=None, help="Archive file path (default: MISTAKES-archive.md next to the active file)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would move without writing anything")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"error: {path} not found", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    line_count = text.count("\n") + 1
    if line_count <= args.max_lines:
        print(f"{path}: {line_count} lines, under the {args.max_lines}-line threshold — nothing to do")
        return 0

    entries = parse_entries(text)
    movable = [e for e in entries if e.status.lower() != "unrouted"]
    movable.sort(key=lambda e: parse_date(e.date))  # oldest first

    if not movable:
        print(f"{path}: {line_count} lines, over threshold, but every entry is still unrouted — nothing safe to archive yet")
        return 0

    header_end = text.index(MARKER) + len(MARKER) if MARKER in text else 0
    preamble = text[:header_end] if header_end else ""

    to_move: list[RawEntry] = []
    remaining_text = text
    for entry in movable:
        remaining_text = remaining_text.replace(entry.text, "", 1)
        to_move.append(entry)
        new_line_count = remaining_text.count("\n") + 1
        if new_line_count <= args.max_lines:
            break

    if args.dry_run:
        print(f"{path}: would move {len(to_move)} entr{'y' if len(to_move) == 1 else 'ies'} to archive:")
        for e in to_move:
            print(f"  - {e.date}  {e.title}  (status: {e.status})")
        return 0

    archive_path = Path(args.archive) if args.archive else path.parent / "MISTAKES-archive.md"
    if archive_path.exists():
        archive_text = archive_path.read_text(encoding="utf-8")
    else:
        archive_text = ARCHIVE_HEADER

    # Archive stays newest-first too: prepend the newest of the moved batch first.
    to_move_newest_first = sorted(to_move, key=lambda e: parse_date(e.date), reverse=True)
    insertion = "".join(e.text + "\n" for e in to_move_newest_first)
    archive_text = archive_text.rstrip("\n") + "\n\n" + insertion

    # Removing entries can leave orphaned blank-line gaps behind; collapse them
    # back to a single blank line between entries instead of accumulating.
    remaining_text = re.sub(r"\n{3,}", "\n\n", remaining_text).rstrip("\n") + "\n"
    archive_text = re.sub(r"\n{3,}", "\n\n", archive_text).rstrip("\n") + "\n"

    path.write_text(remaining_text, encoding="utf-8")
    archive_path.write_text(archive_text, encoding="utf-8")

    print(f"Moved {len(to_move)} entr{'y' if len(to_move) == 1 else 'ies'} from {path} to {archive_path}")
    print(f"{path}: {line_count} -> {remaining_text.count(chr(10)) + 1} lines")
    for e in to_move:
        print(f"  - {e.date}  {e.title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
