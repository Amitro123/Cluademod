"""Shared lesson store with one shared session index.

Claude Code and Cursor read and write the same lessons AND the same
session index — there is one physical MEMORY.md, not a per-harness copy.
Each harness still has its own hook/rules-file plumbing (SessionStart vs
Cursor's sessionStart adapter, CLAUDE.md/.claude/rules/ vs .cursor/rules/),
but the index content itself is harness-neutral: nothing in the Projects/
Areas/Resources/Archives/Rules-promoted body differs by host, so keeping
two copies in lockstep was pure duplicated-write cost with no payoff. See
MISTAKES.md [2026-10-05] for the migration this replaced.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

SHARED = "shared"
LESSON_HOSTS = ("claude", "cursor")
PARA_FOLDERS = ("Projects", "Areas", "Resources", "Archives")
MEMORY_FILENAME = "MEMORY.md"


def lesson_root(project_dir: Path) -> Path:
    return project_dir / ".agent-brain" / SHARED


def memory_path(project_dir: Path, host: str) -> Path:
    """The one shared session index, read and written by every harness.

    ``host`` is still validated (not silently accepted for an unknown value)
    so a typo'd caller fails loudly, but it no longer selects a different
    physical file — every valid host resolves to the same path.
    """
    if host not in LESSON_HOSTS:
        raise ValueError(f"unknown host {host!r}")
    return lesson_root(project_dir) / MEMORY_FILENAME


def legacy_memory_path(project_dir: Path, host: str) -> Path:
    """Where this host's index lived before the shared-index refactor.

    Only used by ``migrate_shared_memory_index`` to find pre-refactor files
    on an already-inited project. Never written to by current code.
    """
    if host == "cursor":
        return project_dir / ".cursor" / "agent-memory" / "cursor" / "MEMORY.md"
    if host == "claude":
        return project_dir / ".claude" / "agent-memory" / "claude" / "MEMORY.md"
    raise ValueError(f"unknown host {host!r}")


def detect_host() -> str:
    """Which harness is briefing. No longer selects a file (memory_path is
    the same for every host) — kept for any caller that still wants to know
    which harness is asking, and validated the same way it always was."""
    host = os.environ.get("MISTAKE_BRAIN_HOST", "claude").strip().lower()
    if host not in LESSON_HOSTS:
        return "claude"
    return host


MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"


def insert_entry(text: str, entry: str) -> str:
    """Put an entry right below MISTAKES.md's marker, one blank line either side.

    Only the seam is normalised: the rest of the file -- blank lines inside an
    older entry's code block or quoted log included -- stays byte for byte.
    """
    head, sep, tail = text.partition(MARKER)
    if not sep:
        raise ValueError("MISTAKES.md has no marker")
    tail = tail.lstrip("\n")
    block = entry.strip("\n") + "\n"
    return head + MARKER + "\n\n" + block + ("\n" + tail if tail else "")


def project_root(payload: dict | None = None) -> Path:
    """The project a hook acts on, the same for every hook.

    ``CLAUDE_PROJECT_DIR`` first (where init puts MISTAKES.md), then the
    payload's ``cwd``. Only when neither holds mistake-brain does git's top
    level for that folder count (a session started in a subfolder).
    """
    payload = payload if isinstance(payload, dict) else {}
    start = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or ".")
    if is_brain_project(start):
        return start
    try:
        import subprocess

        done = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=start, capture_output=True, text=True, timeout=5,
        )
        if done.returncode == 0 and done.stdout.strip():
            top = Path(done.stdout.strip())
            if is_brain_project(top):
                return top
    except Exception:
        pass
    return start


def is_brain_project(project_dir: Path) -> bool:
    """True when the project uses mistake-brain: it has the inbox or the lesson store.

    The plugin's hooks run in every project; in any other one they do nothing
    and write nothing.
    """
    return (project_dir / "MISTAKES.md").is_file() or (project_dir / ".agent-brain").is_dir()


def index_gate_enabled() -> bool:
    """When true, route still writes the lesson file but does not index it.

    Unset or any value other than ``1`` keeps today's behavior: route updates
    the shared MEMORY.md. New projects do not turn this on.
    """
    return os.environ.get("MISTAKE_BRAIN_INDEX_GATE", "").strip() == "1"


def memory_header() -> str:
    """Harness-neutral header + empty section skeleton for a fresh MEMORY.md.

    No host parameter: the body (Projects/Areas/Resources/Archives/Rules
    promoted) is identical regardless of which harness is reading it, and
    promoted rules only ever land in CLAUDE.md/.claude/rules/ regardless of
    which harness triggered the promotion — there's nothing host-specific
    left to vary here.
    """
    return """\
# MEMORY.md — shared session index

Lessons live in `.agent-brain/shared/`, shared by Claude Code and Cursor —
this is the one session index both harnesses read and write; there is no
separate per-harness copy. Read this first — it tells you which PARA file
is relevant before reading the raw folders.
Updated by `/brain-hud:mistake-brain route` (adds entries) and `/brain-hud:mistake-brain dream`
(reorganizes and rewrites summaries).

Format per line: `- [PARA-type] file — one-line summary (N lessons, last updated YYYY-MM-DD)`

## Projects
_(none yet)_

## Areas
_(none yet)_

## Resources
_(none yet)_

## Archives
Archives: 0 files (not loaded at session start)

## Rules promoted so far
_(none yet — promoted rules land in `CLAUDE.md` or `.claude/rules/`)_
"""


CURSOR_RULE = """\
---
description: mistake-brain retrieval and log trigger for Cursor
alwaysApply: true
---

Run /brain-hud:mistake-brain log immediately after any fix, revert, correction, decision, or session handoff.
At session start, read `.agent-brain/shared/MEMORY.md` once — the same index Claude Code reads. Lessons are written only under `.agent-brain/shared/`. Do not write `.agent-brain/cursor/` or `.agent-brain/claude/`.
Do not read PARA files or MISTAKES.md top-to-bottom. Use /brain-hud:mistake-brain recall to load at most 2 matching PARA files.
"""


def migrate_legacy_lessons(project_dir: Path) -> list[str]:
    """Move lesson files from harness-named trees into the shared store.

    A file already present at the destination is left in place. Nothing is
    overwritten, so a re-run cannot drop a lesson.
    """
    moved: list[str] = []
    dest_root = lesson_root(project_dir)
    for host in LESSON_HOSTS:
        source_root = project_dir / ".agent-brain" / host
        if not source_root.is_dir():
            continue
        for path in source_root.rglob("*.md"):
            if not path.is_file():
                continue
            relative = path.relative_to(source_root)
            dest = dest_root / relative
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(dest))
            moved.append(relative.as_posix())
    return moved


_LEGACY_COPY_NOTICE = """\
# MEMORY.md — legacy copy (read-only)

> The live index is `.agent-brain/shared/MEMORY.md`, shared by every harness.
> This is a snapshot taken when it was created, kept only so skill installs
> from before the shared index still brief real lessons until they upgrade.
> Do not edit this file; it is not updated by `route` or `dream`.

"""


def legacy_copy_text(shared_text: str) -> str:
    """Compatibility copy written to each legacy path on migration."""
    return _LEGACY_COPY_NOTICE + shared_text


def shared_memory_needs_migration(project_dir: Path) -> bool:
    """Non-mutating check: would migrate_shared_memory_index do anything?

    For callers (update_hook.py's report-only path) that must not write
    anything just to answer "is this project stale".
    """
    if memory_path(project_dir, "claude").exists():
        return False
    return any(
        legacy_memory_path(project_dir, host).exists() for host in LESSON_HOSTS
    )


def migrate_shared_memory_index(project_dir: Path) -> dict:
    """Merge the two legacy per-harness MEMORY.md files into the shared one.

    Returns a dict with:
      - "status": "already_shared" | "migrated" | "nothing_to_migrate" | "drift"
      - "detail": a short human-readable description

    Safety rules:
      - Never runs if the shared file already exists (status: already_shared)
        — migration is a one-time, pre-shared-index step, not an ongoing sync.
      - If both legacy files exist and their bodies differ (ignoring the old
        per-host header lines), this is a real conflict: nothing is written,
        and status is "drift" so the caller can surface it instead of
        silently picking a winner.
      - Otherwise, whichever legacy file has content (preferring the claude
        one when both match) becomes the shared file's body, and each
        legacy file that existed is overwritten with a read-only copy of the
        shared index (``legacy_copy_text``) — never deleted, and never reduced
        to a bare pointer, because older global installs still brief from it.
    """
    shared_path = memory_path(project_dir, "claude")
    if shared_path.exists():
        return {"status": "already_shared", "detail": str(shared_path)}

    legacy = {
        host: legacy_memory_path(project_dir, host) for host in LESSON_HOSTS
    }
    present = {h: p for h, p in legacy.items() if p.exists()}
    if not present:
        return {"status": "nothing_to_migrate", "detail": "no legacy MEMORY.md found"}

    def _body(text: str) -> str:
        # Strip the old per-host header through the "Format per line" sentence —
        # everything after that line is the harness-neutral part we compare.
        marker = "Format per line:"
        idx = text.find(marker)
        return text[idx:] if idx != -1 else text

    def _normalized_for_comparison(body: str) -> str:
        # The pre-refactor memory_header() templated an empty "Rules promoted
        # so far" placeholder differently per host (one said "see CLAUDE.md
        # and .claude/rules/", the other "see .cursor/rules/") -- boilerplate
        # wording about *where* rules live, not a lesson, and not something a
        # real conflict should hinge on. Collapse any such placeholder line to
        # one canonical form before comparing, so two per-host files with
        # identical actual lessons don't get reported as drift over this.
        return re.sub(
            r"^_\(none yet.*?\)_\s*$",
            "_(none yet)_",
            body,
            flags=re.MULTILINE,
        )

    bodies = {h: _body(p.read_text(encoding="utf-8")) for h, p in present.items()}
    comparable = {h: _normalized_for_comparison(b) for h, b in bodies.items()}
    if len(comparable) == 2 and comparable["claude"] != comparable["cursor"]:
        return {
            "status": "drift",
            "detail": (
                f"{legacy['claude']} and {legacy['cursor']} have diverged — "
                "resolve manually before migrating (compare the two files; "
                "keep the one with the complete/correct lessons, then re-run)."
            ),
        }

    source_host = "claude" if "claude" in present else "cursor"
    source_text = present[source_host].read_text(encoding="utf-8")
    shared_path.parent.mkdir(parents=True, exist_ok=True)
    # Write the new neutral header, not the old per-host one baked into
    # source_text — only the body (Projects/Areas/.../Rules promoted) carries
    # forward from the legacy file.
    new_header = memory_header()
    header_marker = "Format per line:"
    new_prefix = new_header[: new_header.index(header_marker)]
    shared_text = new_prefix + bodies[source_host]
    shared_path.write_text(shared_text, encoding="utf-8")

    for path in present.values():
        path.write_text(legacy_copy_text(shared_text), encoding="utf-8")

    return {
        "status": "migrated",
        "detail": f"merged {', '.join(str(p) for p in present.values())} -> {shared_path}",
    }
