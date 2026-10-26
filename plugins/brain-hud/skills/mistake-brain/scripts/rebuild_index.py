#!/usr/bin/env python3
"""Regenerate the facts in the shared MEMORY.md index from the PARA files.

    python <skill_root>/scripts/rebuild_index.py --project-dir <project>

The lesson count and the last-updated date of each lesson file are facts on
disk -- each lesson is a ``## [YYYY-MM-DD] title`` heading -- so a script
writes them, not the model. Run by ``route`` (router.md step 6), ``dream``
(references/dream.md step 4) and ``init``, as their last step.

What it writes, in ``.agent-brain/shared/MEMORY.md``:

- One line per Projects/Areas/Resources file, in its section:
  ``- [Area] Areas/ci.md — <summary> (N lessons, last updated YYYY-MM-DD)``.
  The summary is kept from the file's existing line (a markdown-link or
  backticked path is read too); a file with no line yet gets the first
  paragraph of the file after its title, else its name.
- ``Archives: N files (not loaded at session start)`` under ``## Archives``.

It never deletes: a line for a file that is no longer on disk, and any line it
doesn't recognise, stays as it is (dream decides what to do with those).
Everything outside those sections -- the header, ``## Rules promoted so far``,
``## Last dream`` -- stays as it is too. Running it twice is a no-op.

With the index gate on (``MISTAKE_BRAIN_INDEX_GATE=1``) it adds no line for a
file the index doesn't list yet: those wait for ``index_admission.py``. It
still refreshes the counts of the lines already there.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import host_layout  # noqa: E402

INDEXED = (("Projects", "Project"), ("Areas", "Area"), ("Resources", "Resource"))
NONE_YET = "_(none yet)_"

_HEADING = re.compile(r"^## \[(\d{4}-\d{2}-\d{2})[^\]]*\]", re.MULTILINE)
_ADDED = re.compile(r"^- Added:\s*(\d{4}-\d{2}-\d{2})", re.MULTILINE)
# An index line: "- [Area] <file> — summary (3 lessons, last updated 2026-10-24)".
# <file> may be a bare path, a backticked one, or a markdown link.
_LINE = re.compile(
    r"^- \[(Project|Area|Resource)\]\s+(?P<file>\[[^\]]*\]\([^)]*\)|`[^`]+`|\S+)"
    r"(?:\s+[—-]+\s+(?P<summary>.*?))?"
    r"(?:\s+\(\d+ lessons?(?:, last updated [\d-]+)?\))?\s*$"
)


def lesson_facts(path: Path) -> tuple[int, str | None]:
    """How many lessons a PARA file holds, and the newest date among them."""
    text = path.read_text(encoding="utf-8", errors="replace")
    dates = _HEADING.findall(text) + _ADDED.findall(text)
    return len(_HEADING.findall(text)), max(dates) if dates else None


def first_paragraph(path: Path) -> str:
    """The file's own description: its first paragraph of prose between the
    title and the first lesson (never a lesson's text). Empty when there is none."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    para: list[str] = []
    for line in lines:
        s = line.strip()
        if s.startswith("## "):
            break
        if s.startswith("#"):
            if para:
                break
            continue
        if not s:
            if para:
                break
            continue
        if s.startswith(("- ", "Source:")):
            if para:
                break
            continue
        para.append(s)
    text = " ".join(para)
    return text[:117] + "…" if len(text) > 120 else text


def _file_of(token: str, folder: str) -> str:
    link = re.match(r"^\[[^\]]*\]\(([^)]*)\)$", token)
    path = (link.group(1) if link else token).strip("`").strip()
    path = path.replace("\\", "/")
    for prefix in (".agent-brain/shared/", "shared/"):
        if path.startswith(prefix):
            path = path[len(prefix):]
    return path if "/" in path else f"{folder}/{path}"


def _sections(lines: list[str]) -> dict[str, tuple[int, int]]:
    """Each ``## Name`` section's line span: (heading index, end index)."""
    heads = [i for i, l in enumerate(lines) if l.startswith("## ")]
    out: dict[str, tuple[int, int]] = {}
    for n, i in enumerate(heads):
        end = heads[n + 1] if n + 1 < len(heads) else len(lines)
        out[lines[i][3:].strip()] = (i, end)
    return out


def existing_lines(text: str) -> dict[str, str]:
    """The summary each indexed file has now, by its ``Folder/file.md`` path."""
    lines = text.splitlines()
    out: dict[str, str] = {}
    for folder, _ in INDEXED:
        span = _sections(lines).get(folder)
        if not span:
            continue
        for line in lines[span[0] + 1 : span[1]]:
            m = _LINE.match(line.strip())
            if m:
                out[_file_of(m.group("file"), folder)] = (m.group("summary") or "").strip()
    return out


def _body(lines: list[str], span: tuple[int, int]) -> list[str]:
    body = lines[span[0] + 1 : span[1]]
    while body and not body[-1].strip():
        body.pop()
    return body


def rebuild(project_dir: Path, *, gate: bool | None = None) -> bool:
    """Refresh MEMORY.md's index facts from disk. True when the file changed.

    Never destructive: a line for a file on disk gets its count and date
    rewritten (its summary kept), a file the index lacks gets a line, and
    every other line -- a file no longer on disk, free text -- stays as it is.
    """
    if gate is None:
        gate = host_layout.index_gate_enabled()
    root = host_layout.lesson_root(project_dir)
    path = host_layout.memory_path(project_dir, "claude")
    before = path.read_text(encoding="utf-8") if path.exists() else None
    lines = (before if before is not None else host_layout.memory_header()).splitlines()

    def line_for(folder: str, kind: str, f: Path, summary: str) -> str:
        count, date = lesson_facts(f)
        facts = f"{count} lesson{'' if count == 1 else 's'}" + (f", last updated {date}" if date else "")
        summary = summary or first_paragraph(f) or f.stem.replace("-", " ")
        return f"- [{kind}] {folder}/{f.name} — {summary} ({facts})"

    bodies: dict[str, list[str]] = {}
    for folder, kind in INDEXED:
        span = _sections(lines).get(folder)
        body = _body(lines, span) if span else []
        on_disk = {f.name: f for f in sorted((root / folder).glob("*.md"))} if (root / folder).is_dir() else {}
        seen: set[str] = set()
        out: list[str] = []
        for line in body:
            m = _LINE.match(line.strip())
            rel = _file_of(m.group("file"), folder) if m else None
            name = rel.split("/", 1)[1] if rel and rel.startswith(f"{folder}/") else None
            if m and name in on_disk and name not in seen:
                seen.add(name)
                out.append(line_for(folder, kind, on_disk[name], (m.group("summary") or "").strip()))
            elif line.strip() != NONE_YET:
                out.append(line)
        if not gate:
            out.extend(line_for(folder, kind, f, "") for name, f in on_disk.items() if name not in seen)
        bodies[folder] = out or [NONE_YET]

    archives = root / "Archives"
    n_arch = sum(1 for _ in archives.rglob("*.md")) if archives.is_dir() else 0
    count_line = f"Archives: {n_arch} file{'' if n_arch == 1 else 's'} (not loaded at session start)"
    span = _sections(lines).get("Archives")
    arch = _body(lines, span) if span else []
    at = next((i for i, l in enumerate(arch) if re.match(r"^Archives: \d+ files?\b", l.strip())), None)
    if at is None:
        arch = [count_line, *[l for l in arch if l.strip() != NONE_YET]]
    else:
        arch[at] = count_line
    bodies["Archives"] = arch

    # Replace each owned section's body, from the bottom up so spans stay valid;
    # a section the file lacks is added before "## Rules promoted so far" (or at the end).
    for name in ("Archives", "Resources", "Areas", "Projects"):
        span = _sections(lines).get(name)
        if span:
            start, end = span
            tail = [""] if end < len(lines) else []
            lines[start + 1 : end] = bodies[name] + tail
        else:
            at = _sections(lines).get("Rules promoted so far", (len(lines), 0))[0]
            lines[at:at] = [f"## {name}", *bodies[name], ""]
    after = "\n".join(lines).rstrip("\n") + "\n"
    if after == before:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(after, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Regenerate MEMORY.md's lesson counts and dates from the PARA files.")
    parser.add_argument("--project-dir", default=".")
    args = parser.parse_args(argv)
    changed = rebuild(Path(args.project_dir))
    print("MEMORY.md updated" if changed else "MEMORY.md already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
