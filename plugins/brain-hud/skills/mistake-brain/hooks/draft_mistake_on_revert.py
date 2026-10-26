#!/usr/bin/env python3
# version: 1.3.0
"""PostToolUse hook: deterministically draft a MISTAKES.md entry after a
revert-like Bash command, so logging doesn't depend entirely on Claude
noticing via the skill description (measured 27-73% trigger recall
depending on how much of CLAUDE.md/description was reinforced - never
100%, and never will be, since it's a model judgment call).

Scope, deliberately narrow: only fires on unambiguous worktree-only git
commands (`git checkout -- <path>`, `git restore`, `git clean -f`) that the
Stop hook cannot infer from HEAD/reflog state. `git revert` and
`git reset --hard` are owned exclusively by `revert_stop_hook.py`, avoiding
duplicate drafts from PostToolUse and Stop. Edit/Write-based revert detection was
considered and rejected - there's no reliable deterministic signal for
"this edit reverts a prior change" from tool_input alone (would need
diffing against git history / semantic understanding, which isn't a
hook's job). Bash git commands are the one place a mistake-shaped event
is mechanically detectable without judgment.

Always drafts `Type: mistake` (see entry_block below) and only ever
that - never success/decision/handoff. Those three types are inherently
judgment calls about what happened and why (was this worth repeating?
was this a real decision? is this a handoff?), which a regex over a
command string cannot make; a revert-like git command is the one signal
in this whole skill that's unambiguous enough to draft without judgment,
and it only ever indicates a mistake happened, never the other three
types. See references/format-spec.md's Type field for the full schema.

The resulting entry is deliberately low-detail - a draft, not a real
log entry - since a hook has no access to *why* the revert happened,
only that it did. `/brain-hud:mistake-brain route` (or a human) fills in the real
story later; `[auto-draft]` in the title makes these easy to grep for
and never mistake for something Claude wrote with real context.

Known interaction: this hook applies to ANY claude session running with
this project as cwd, including nested/test sessions (e.g. skill-creator
eval harnesses). If a nested session ever runs a matching git command
for real (not just quoted text), it will draft an entry into the real
MISTAKES.md. None of this skill's own eval queries currently do that,
but it's a real edge case worth knowing about, not a hidden one.

Known limitation, found by actually triggering it: matching is a regex
over the raw command string with quoted spans stripped (see
strip_quoted_spans) - a heuristic, not a real shell parser. Unusual
quote nesting/concatenation can still produce a false positive or
false negative. Prefer under-triggering caution over trying to make
this bulletproof; a missed auto-draft just falls back to the normal
trigger-or-manual-log path, which is the existing behavior everywhere
else in this skill.

Never blocks the tool call - always exits 0, hook failures are silent
by design (a missing MISTAKES.md, an unwritable file, anything) rather
than surfacing an error mid-task for a background convenience feature.
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

REVERT_PATTERNS = [
    r"\bgit\s+checkout\s+--\s+\S",
    r"\bgit\s+restore\b",
    r"\bgit\s+clean\s+-[a-zA-Z]*f",
]

MARKER = "<!-- mistake-brain: new entries are inserted immediately below this line -->"


def strip_quoted_spans(command: str) -> str:
    """Remove content inside single- or double-quoted spans before matching.

    Without this, a command that merely *mentions* a revert pattern as text
    - echoing a JSON payload for a test, printing a commit message, a heredoc
    - matches just as readily as actually running one. This bit the hook's
    own author: testing it by piping `echo '{"command":"git reset --hard
    HEAD~1"}'` into the script matched the regex on the quoted example text
    and drafted a bogus entry into the real MISTAKES.md. This is a heuristic,
    not a real shell parser - deeply nested or unusually concatenated quoting
    can still slip past it - but it closes the common case (echo/printf/
    heredoc containing example command text) without needing full shell
    grammar."""
    return re.sub(r"'[^']*'|\"[^\"]*\"", "", command)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command", "")
    if not command:
        return 0
    unquoted = strip_quoted_spans(command)
    if not any(re.search(p, unquoted) for p in REVERT_PATTERNS):
        return 0

    project_dir = Path(
        os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or "."
    )
    mistakes_path = project_dir / "MISTAKES.md"
    if not mistakes_path.exists():
        return 0

    text = mistakes_path.read_text(encoding="utf-8")
    if MARKER not in text:
        return 0

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    safe_command = command.strip().replace("\n", " ")[:200]

    entry_block = (
        f"## [{now}] [auto-draft] Revert-like command detected: `{safe_command}`\n"
        f"- **Type:** mistake\n"
        f"- **What happened:** [auto-draft, needs detail] Ran a revert/reset-like command "
        f"(`{safe_command}`) — this hook only detected *that* something was reverted, not "
        f"*why*. Fill in the real story.\n"
        f"- **Root cause:** [auto-draft, needs detail] — not yet known; describe what made "
        f"the revert necessary.\n"
        f"- **Consequence:** [auto-draft, needs detail]\n"
        f"- **Prevention rule:** [auto-draft, needs detail]\n"
        f"- **PARA route:** unrouted\n"
        f"- **Status:** unrouted\n"
    )

    text = text.replace(MARKER, MARKER + "\n\n" + entry_block, 1)
    text = re.sub(
        r"\n{3,}", "\n\n", text
    )  # same normalization compose_mistakes.py uses
    mistakes_path.write_text(text, encoding="utf-8")

    # Emit routing reminder via additionalContext — the auto_pipeline PostToolUse hook
    # won't fire because this hook writes directly (Python I/O, not via Edit/Write tools).
    # Emitting here closes that gap: the pipeline prompt reaches Claude regardless.
    context = (
        f"[mistake-brain] auto-drafted a MISTAKES.md entry for: `{safe_command}`\n"
        "1 unrouted entry now in the inbox. "
        "Fill in the [auto-draft] placeholders and run /brain-hud:mistake-brain route "
        "to classify it into PARA memory before completing the turn."
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": context,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
