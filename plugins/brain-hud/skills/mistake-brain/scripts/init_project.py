#!/usr/bin/env python3
"""Scaffold all per-project mistake-brain files in a fresh project.

Usage (invoked by Claude following init.md instructions):
    python <skill_root>/scripts/init_project.py [--project-dir DIR] [--skill-dir DIR]

Defaults:
    --project-dir  current working directory
    --skill-dir    two levels above this script (the skill's folder in the
                   brain-hud plugin)

The hooks are the brain-hud plugin's (its hooks/hooks.json): init registers
none. It removes the ones an older install of the skill registered in the
project's settings, so nothing fires twice.

Idempotent: re-running repairs what is missing and changes nothing else; an
existing MISTAKES.md is never rewritten.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import host_layout  # noqa: E402
import rebuild_index  # noqa: E402

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"

MISTAKES_HEADER = """\
# MISTAKES.md

Raw, append-only log for this agent — despite the name, not just failures.
Every entry has a `Type`: `mistake` (a failure, correction, or reverted change),
`success` (a pattern that worked and is worth repeating), `decision` (a real choice
made between alternatives, worth remembering why), or `handoff` (context a future
session needs to pick up cold). Newest entries go directly below this header —
never edit or delete a past entry's content, only update its `Status` and `PARA route`
fields as it gets processed.

This file is the *inbox*. Durable lessons live in `.agent-brain/shared/`
(see `.agent-brain/shared/MEMORY.md` for the index).

- Format: the mistake-brain skill's `references/format-spec.md` (in the brain-hud plugin)
- How entries get here: `/brain-hud:mistake-brain log`
- How entries get triaged into PARA: `/brain-hud:mistake-brain route`
- How repeats become rules: `/brain-hud:mistake-brain promote`

"""

MEMORY_HEADER = host_layout.memory_header()

PARA_FOLDERS = ("Projects", "Areas", "Resources", "Archives")

RULES_TRIGGER = (
    "Run /brain-hud:mistake-brain log immediately after any fix, revert, correction,"
    " decision, or session handoff.\n"
    "At session start, read `.agent-brain/shared/MEMORY.md` first "
    "(Claude Code injects it via SessionStart) — the same shared index "
    "Cursor reads. Lessons live in `.agent-brain/shared/`. "
    "Do not read PARA files or MISTAKES.md top-to-bottom. "
    "Use /brain-hud:mistake-brain recall to load at most 2 matching PARA files.\n"
)

REVERT_HOOK = "revert_stop_hook.py"  # Stop: revert/reset detection
CAPTURE_HOOK = "draft_mistake_on_revert.py"  # PostToolUse: checkout/restore/clean
BRIEF_HOOK = "brief_on_session_start.py"
VALIDATION_FAILURE_HOOK = "draft_mistake_on_validation_failure.py"  # PostToolUseFailure: validation exits
AUTO_PIPELINE_HOOK = "auto_pipeline_on_mistakes_edit.py"  # PostToolUse: route/promote nudges, index refresh
HOOK_FILES = (REVERT_HOOK, CAPTURE_HOOK, BRIEF_HOOK, VALIDATION_FAILURE_HOOK, AUTO_PIPELINE_HOOK)

# Files the hooks write in the project at run time: kept out of git.
RUNTIME_FILES = (".claude/mb-head-state.txt", ".claude/mb-pending-candidates.json", ".claude/hooks.log")

# CLAUDE.md section — adds standing instruction that raises trigger recall 27%→73%.
# Uses markers so re-running init never duplicates the section.
_CLAUDE_MD_MARKER_START = "<!-- mistake-brain: standing instructions -->"
_CLAUDE_MD_MARKER_END = "<!-- /brain-hud:mistake-brain: standing instructions -->"
_CLAUDE_MD_SECTION = f"""\
{_CLAUDE_MD_MARKER_START}
## Mistake Brain — Standing Instructions

**Standing instruction, not optional guidance:** the moment you fix a bug,
revert a change, hit the same bug again, or the user corrects your approach —
run `/brain-hud:mistake-brain log <description>` immediately, in that same turn, before
moving on. Don't wait to be asked, don't skip small ones.

**Also applies to:** successes worth repeating (`Type: success`), real decisions
between alternatives (`Type: decision`), and context a future session needs cold
(`Type: handoff`) — see the mistake-brain skill in the brain-hud plugin.
{_CLAUDE_MD_MARKER_END}
"""


@dataclass
class InitResult:
    created: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    already_initialized: bool = False
    refused: str | None = None
    # Things init won't do by itself (a tracked file, a folder outside the project).
    actions: list[str] = field(default_factory=list)


def _command_registered(data: dict, event: str, needle: str) -> bool:
    """Return True if a hook command containing needle is registered for event."""
    for entry in data.get("hooks", {}).get(event, []):
        for h in entry.get("hooks", []):
            if needle in h.get("command", ""):
                return True
    return False


def _is_legacy_hook(command: str) -> bool:
    """A mistake-brain hook an older install registered in settings (the
    plugin's own run from ${CLAUDE_PLUGIN_ROOT} and are never in settings)."""
    return any(name in command for name in HOOK_FILES) and "CLAUDE_PLUGIN_ROOT" not in command


def strip_legacy_hooks(data: dict) -> int:
    """Remove the legacy mistake-brain hook commands from a settings dict.

    Entries left with no hooks, and events left with no entries, go too.
    Returns how many commands were removed.
    """
    removed = 0
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return 0
    for event in list(hooks):
        kept_entries = []
        for entry in hooks[event] or []:
            inner = entry.get("hooks", []) if isinstance(entry, dict) else []
            kept = [h for h in inner if not _is_legacy_hook(str(h.get("command", "")))]
            removed += len(inner) - len(kept)
            if kept:
                kept_entries.append({**entry, "hooks": kept})
            elif not inner:
                kept_entries.append(entry)
        if kept_entries:
            hooks[event] = kept_entries
        else:
            del hooks[event]
    if not hooks:
        del data["hooks"]
    return removed


def _git(project_dir: Path, *args: str) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(
            ["git", *args], cwd=project_dir, capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None


def git_tracked(project_dir: Path, relative: str) -> bool:
    """True when the file is tracked by git in project_dir."""
    done = _git(project_dir, "ls-files", "--error-unmatch", relative)
    return bool(done and done.returncode == 0)


def _exclude_runtime_files(project_dir: Path) -> list[str]:
    """List the hooks' runtime files in the repository's info/exclude."""
    done = _git(project_dir, "rev-parse", "--git-path", "info/exclude")
    if not done or done.returncode != 0 or not done.stdout.strip():
        return []
    path = Path(done.stdout.strip())
    if not path.is_absolute():
        path = project_dir / path
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    have = set(text.splitlines())
    missing = [f for f in RUNTIME_FILES if f not in have]
    if missing:
        path.parent.mkdir(parents=True, exist_ok=True)
        prefix = text if not text or text.endswith("\n") else text + "\n"
        path.write_text(prefix + "".join(f"{f}\n" for f in missing), encoding="utf-8")
    return missing


def _remove_empty_legacy_trees(project_dir: Path) -> list[str]:
    """Remove .agent-brain/claude and .agent-brain/cursor when nothing but empty folders is left."""
    removed = []
    for host in host_layout.LESSON_HOSTS:
        root = project_dir / ".agent-brain" / host
        if not root.is_dir() or any(p.is_file() for p in root.rglob("*")):
            continue
        for d in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            d.rmdir()
        root.rmdir()
        removed.append(f".agent-brain/{host}/")
    return removed


def _clean_settings(project_dir: Path, result: "InitResult") -> None:
    """Remove the hooks an older install registered: a tracked settings file is reported, not edited."""
    for name in ("settings.local.json", "settings.json"):
        path = project_dir / ".claude" / name
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        removed = strip_legacy_hooks(data)
        if not removed:
            continue
        label = f".claude/{name}"
        if git_tracked(project_dir, label):
            result.actions.append(
                f"{label} is tracked in git and registers {removed} mistake-brain hook(s) "
                "from an older install. The brain-hud plugin runs them now; remove those "
                "entries, or each hook fires twice."
            )
            continue
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        result.created.append(f"{label} ({removed} legacy hook entr{'y' if removed == 1 else 'ies'} removed)")


def _global_copy() -> Path | None:
    path = Path.home() / ".claude" / "skills" / "mistake-brain"
    return path if (path / "SKILL.md").exists() else None


def main(project_dir: Path, skill_dir: Path) -> InitResult:
    result = InitResult()

    # ── Guard: required hooks must exist in skill_dir before touching anything ─
    for filename in HOOK_FILES:
        hook_src = skill_dir / "hooks" / filename
        if not hook_src.exists():
            raise FileNotFoundError(
                f"[mistake-brain] Hook not found at {hook_src}\n"
                "  Run init from the skill in the brain-hud plugin: "
                "python <skill_root>/scripts/init_project.py"
            )

    # ── Idempotency check ──────────────────────────────────────────────────
    # This only guards step 1 (MISTAKES.md) -- writing it unconditionally would
    # wipe out real entries on a re-run. Steps 2-6 below are already individually
    # idempotent (mkdir(exist_ok=True), existence checks, or the hook-registration
    # merge's own "already registered?" check), so they must still run even when
    # MISTAKES.md already exists. A prior version returned immediately here,
    # which meant a project whose MISTAKES.md/PARA/CLAUDE.md were already in place
    # but whose hooks had been lost (e.g. an unrelated settings.json edit
    # overwrote the hooks block) looked "fully initialized" and got silently
    # skipped forever -- init never noticed or repaired the missing hooks, even
    # though _merge_settings below would have fixed it in one call.
    mistakes_path = project_dir / "MISTAKES.md"
    result.already_initialized = (
        mistakes_path.exists() and MARKER in mistakes_path.read_text(encoding="utf-8")
    )

    # 1. MISTAKES.md
    if not result.already_initialized:
        mistakes_path.parent.mkdir(parents=True, exist_ok=True)
        mistakes_path.write_text(MISTAKES_HEADER + MARKER + "\n", encoding="utf-8")
        result.created.append("MISTAKES.md")

    # 2. One lesson store. Harness-named trees are moved in, never used as a
    #    second copy. Same pattern as a cross-harness memory layer: adapters
    #    differ, the knowledge does not.
    for relative in host_layout.migrate_legacy_lessons(project_dir):
        result.created.append(f".agent-brain/shared/{relative} (moved from harness tree)")
    brain_base = host_layout.lesson_root(project_dir)
    for folder in PARA_FOLDERS:
        folder_path = brain_base / folder
        already_there = folder_path.exists()
        folder_path.mkdir(parents=True, exist_ok=True)
        label = f".agent-brain/shared/{folder}/"
        if already_there:
            result.skipped.append(label)
        else:
            result.created.append(label)

    # 3. One shared index, read and written by every harness. Merge any
    #    pre-refactor per-harness MEMORY.md files first (no-op if there are
    #    none, or if the shared file already exists).
    migration = host_layout.migrate_shared_memory_index(project_dir)
    memory_file = host_layout.memory_path(project_dir, "claude")
    memory_file.parent.mkdir(parents=True, exist_ok=True)
    label = memory_file.relative_to(project_dir).as_posix()
    if migration["status"] == "migrated":
        result.created.append(f"{label} (merged from legacy per-harness copies)")
    elif migration["status"] == "drift":
        result.refused = (
            f"legacy MEMORY.md files have diverged: {migration['detail']}"
        )
    elif not memory_file.exists():
        memory_file.write_text(host_layout.memory_header(), encoding="utf-8")
        result.created.append(label)
    else:
        result.skipped.append(label)

    # 4. Hooks: the plugin's. Remove what an older install registered in
    #    settings, and report a global copy of the skill that still loads.
    _clean_settings(project_dir, result)
    old_copy = _global_copy()
    if old_copy is not None:
        result.actions.append(
            f"An older copy of the skill is installed at {old_copy}. It loads as a second, "
            "older mistake-brain skill next to /brain-hud:mistake-brain; delete that folder."
        )

    # 5. Auto-create .claude/rules/mistake-brain.md (raises trigger recall ~27%→~73%)
    rules_path = project_dir / ".claude" / "rules" / "mistake-brain.md"
    rules_path.parent.mkdir(parents=True, exist_ok=True)
    if not rules_path.exists():
        rules_path.write_text(RULES_TRIGGER, encoding="utf-8")
        result.created.append(".claude/rules/mistake-brain.md")
    else:
        result.skipped.append(".claude/rules/mistake-brain.md")

    cursor_rule = project_dir / ".cursor" / "rules" / "mistake-brain.mdc"
    cursor_rule.parent.mkdir(parents=True, exist_ok=True)
    if not cursor_rule.exists():
        cursor_rule.write_text(host_layout.CURSOR_RULE, encoding="utf-8")
        result.created.append(".cursor/rules/mistake-brain.mdc")
    else:
        result.skipped.append(".cursor/rules/mistake-brain.mdc")

    # 6. The standing instruction that raises trigger recall from 27% to 73%.
    #    CLAUDE.md gets it only when git doesn't track it: a tracked CLAUDE.md is
    #    the team's, and the instruction goes into .claude/rules/mistake-brain.md.
    claude_md_path = project_dir / "CLAUDE.md"
    if claude_md_path.exists() and git_tracked(project_dir, "CLAUDE.md"):
        rules_text = rules_path.read_text(encoding="utf-8")
        if _CLAUDE_MD_MARKER_START not in rules_text:
            rules_path.write_text(rules_text.rstrip("\n") + "\n\n" + _CLAUDE_MD_SECTION, encoding="utf-8")
            result.created.append(".claude/rules/mistake-brain.md (standing instruction)")
        result.skipped.append(
            "CLAUDE.md (tracked in git; standing instruction kept in .claude/rules/mistake-brain.md)"
        )
    elif not claude_md_path.exists():
        claude_md_path.write_text(
            f"# CLAUDE.md\n\n{_CLAUDE_MD_SECTION}", encoding="utf-8"
        )
        result.created.append("CLAUDE.md")
    elif _CLAUDE_MD_MARKER_START not in claude_md_path.read_text(encoding="utf-8"):
        with claude_md_path.open("a", encoding="utf-8") as f:
            f.write(f"\n{_CLAUDE_MD_SECTION}")
        result.created.append("CLAUDE.md (mistake-brain section appended)")
    else:
        result.skipped.append("CLAUDE.md (mistake-brain section already present)")

    # 7. Housekeeping: runtime files out of git, empty legacy trees gone.
    excluded = _exclude_runtime_files(project_dir)
    if excluded:
        result.created.append(f".git/info/exclude (keeps out of git: {', '.join(excluded)})")
    for d in _remove_empty_legacy_trees(project_dir):
        result.created.append(f"{d} (empty legacy folder removed)")

    # 8. The index's counts and dates, from the lesson files on disk.
    if rebuild_index.rebuild(project_dir):
        result.created.append(".agent-brain/shared/MEMORY.md (lesson counts refreshed)")

    return result


def _print_result(result: InitResult, project_dir: Path) -> None:
    if result.already_initialized:
        if not result.created:
            print(f"[mistake-brain] Already initialized in {project_dir}. Nothing changed.")
            for item in result.actions:
                print(f"  ACTION REQUIRED: {item}")
            return
        # MISTAKES.md/PARA/CLAUDE.md were already in place, but re-checking hook
        # registration (always run, even on an already-initialized project) found
        # and repaired something that had gone missing.
        print(f"[mistake-brain] Already initialized in {project_dir} -- repaired missing pieces:")
        for item in result.created:
            print(f"  repaired  {item}")
        if result.refused:
            print(f"  ACTION REQUIRED: {result.refused}")
        for item in result.actions:
            print(f"  ACTION REQUIRED: {item}")
        return

    print(f"[mistake-brain] Initialized {project_dir}")
    for item in result.created:
        print(f"  created  {item}")
    for item in result.skipped:
        print(f"  skipped  {item}" + ("" if item.endswith(")") else " (already existed)"))
    for item in result.actions:
        print(f"  ACTION REQUIRED: {item}")
    if result.refused:
        print(f"  ACTION REQUIRED: {result.refused}")
        print("  Everything else above still completed; resolve this by hand, then re-run init.")
        return
    print()
    print("Next steps:")
    print("  1. After your first fix, run:  /brain-hud:mistake-brain log <description>")
    print("  2. At end of first task, run:  /brain-hud:mistake-brain route")
    print()
    print("  Trigger recall is auto-configured via .claude/rules/mistake-brain.md")
    print("  The hooks run from the brain-hud plugin; this repo only got memory files.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path.cwd(),
        help="Project root to initialize (default: cwd)",
    )
    parser.add_argument(
        "--skill-dir",
        type=Path,
        default=Path(__file__).parent.parent,
        help="The skill's folder (default: two levels above this script)",
    )
    args = parser.parse_args()
    try:
        result = main(args.project_dir, args.skill_dir)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    _print_result(result, args.project_dir)
    sys.exit(1 if result.refused else 0)
