#!/usr/bin/env python3
"""Scan MISTAKES.md for repeated patterns — mistakes or successes — that
have happened 3+ times.

Used by /brain-hud:mistake-brain promote to decide which mistakes or success
patterns have repeated often enough to justify a hard rule in CLAUDE.md
or .claude/rules/. Clustering key depends on entry Type: `Root cause`
for Type: mistake (or entries with no Type field, treated as mistake
for backward compatibility), `Success pattern` for Type: success.
Type: decision and Type: handoff entries have no clustering key and are
never clustered — a decision or a handoff is a record of a single
judgment call or a context snapshot, not a repeating pattern.

Entries with Status: promoted are excluded from clustering — they
already have a rule, so re-flagging them would eventually cause a
duplicate rule to get written under AGENT_AUTO_IMPROVE=1. unrouted and
routed entries still count; only promoted ones are considered "done."

Usage:
    python check_repetition.py [path/to/MISTAKES.md] [--min-count 3] [--threshold 0.6] [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

ENTRY_HEADER_RE = re.compile(r"^## \[(?P<date>[^\]]+)\]\s*(?P<title>.+?)\s*$", re.MULTILINE)
FIELD_RE = re.compile(r"^- \*\*(?P<key>[^:*]+):\*\*\s*(?P<value>.+?)\s*$")


@dataclass
class Entry:
    date: str
    title: str
    fields: dict = field(default_factory=dict)

    @property
    def type(self) -> str:
        # No Type field = pre-schema entry = treated as mistake (backward compat).
        return self.fields.get("Type", "mistake").strip().lower() or "mistake"

    @property
    def cluster_key(self) -> str:
        """The text clustering groups on, chosen by entry Type. Empty string
        means "never cluster this entry" — decision/handoff entries return
        empty on purpose, same as a mistake entry with a blank Root cause
        was always silently skipped before Type existed."""
        if self.type == "mistake":
            return self.fields.get("Root cause", "")
        if self.type == "success":
            return self.fields.get("Success pattern", "")
        return ""

    @property
    def status(self) -> str:
        return self.fields.get("Status", "")


def parse_entries(text: str) -> list[Entry]:
    headers = list(ENTRY_HEADER_RE.finditer(text))
    entries = []
    for i, m in enumerate(headers):
        start = m.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        body = text[start:end]
        fields = {}
        for line in body.splitlines():
            fm = FIELD_RE.match(line.strip())
            if fm:
                fields[fm.group("key").strip()] = fm.group("value").strip()
        entries.append(Entry(date=m.group("date"), title=m.group("title"), fields=fields))
    return entries


def normalize(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def cluster_by_key(entries: list[Entry], threshold: float) -> list[list[Entry]]:
    """Greedy single-pass clustering: each entry joins the first cluster whose
    representative (first member) it's similar enough to, else starts a new one.
    Good enough for the small, mostly-manually-written logs this operates on —
    not meant to be a general-purpose text clustering algorithm.

    Clusters only ever contain entries of the same Type: mistake entries
    cluster on Root cause, success entries cluster on Success pattern, and
    the two are clustered separately (via separate calls) so a mistake never
    ends up in the same evidence group as a success just because the two
    texts happen to read similarly."""
    clusters: list[list[Entry]] = []
    reps: list[str] = []
    for entry in entries:
        norm = normalize(entry.cluster_key)
        if not norm:
            continue
        placed = False
        for idx, rep in enumerate(reps):
            if similarity(norm, rep) >= threshold:
                clusters[idx].append(entry)
                placed = True
                break
        if not placed:
            clusters.append([entry])
            reps.append(norm)
    return clusters


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="MISTAKES.md", help="Path to MISTAKES.md (default: ./MISTAKES.md)")
    parser.add_argument("--min-count", type=int, default=3, help="Minimum repeats to report a group (default: 3)")
    parser.add_argument("--threshold", type=float, default=0.6, help="Root-cause similarity threshold, 0-1 (default: 0.6)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable text")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"error: {path} not found", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    entries = parse_entries(text)
    if not entries:
        print(f"error: no entries found in {path} — check it follows the MISTAKES.md format", file=sys.stderr)
        return 1

    # A promoted entry already has a permanent rule; re-flagging it as a "new"
    # candidate on every future scan would eventually cause a duplicate/near-
    # duplicate rule to get written under AGENT_AUTO_IMPROVE=1. unrouted and
    # routed entries still need to count — they haven't been actioned yet.
    active_entries = [e for e in entries if e.status.lower() != "promoted"]
    excluded_count = len(entries) - len(active_entries)

    # Cluster mistake and success entries separately so evidence groups never
    # mix the two — see cluster_by_key's docstring. decision/handoff entries
    # have an empty cluster_key and are silently skipped by cluster_by_key,
    # same as an entry with a blank Root cause always was.
    mistake_entries = [e for e in active_entries if e.type == "mistake"]
    success_entries = [e for e in active_entries if e.type == "success"]
    clusters = cluster_by_key(mistake_entries, args.threshold) + cluster_by_key(success_entries, args.threshold)
    repeated = [c for c in clusters if len(c) >= args.min_count]
    repeated.sort(key=len, reverse=True)

    if args.json:
        out = [
            {
                "type": group[0].type,
                "count": len(group),
                "representative_cluster_key": group[0].cluster_key,
                "entries": [
                    {"date": e.date, "title": e.title, "cluster_key": e.cluster_key, "status": e.status}
                    for e in group
                ],
            }
            for group in repeated
        ]
        print(json.dumps({
            "total_entries": len(entries),
            "excluded_promoted": excluded_count,
            "repeated_groups": out,
        }, indent=2))
        return 0

    print(f"Scanned {len(entries)} entries in {path} ({excluded_count} already-promoted excluded)")
    if not repeated:
        print(f"No mistake root cause or success pattern repeats {args.min_count}+ times yet.")
        return 0

    print(f"\n{len(repeated)} pattern(s) repeating {args.min_count}+ times:\n")
    for group in repeated:
        print(f"  [{len(group)}x, {group[0].type}] {group[0].cluster_key}")
        for e in group:
            print(f"      - {e.date}  {e.title}  (status: {e.status or 'unknown'})")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
