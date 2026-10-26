# Index admission roadmap

What changes, and what stays as effective as today.

## Already in place

One lesson store, `.agent-brain/shared/`. Claude Code and Cursor each keep their own `MEMORY.md`. A session briefs only its own index. Retrieval stays one index line, then at most two PARA files. The inbox is not a briefing source.

## This change

1. **Format warning, briefing only.** An inbox entry with a missing or unusable `Status` is named in the session briefing. The unrouted count does not change. The entry is not rewritten and is not routed.
2. **Index gate, off by default.** `MISTAKE_BRAIN_INDEX_GATE` unset, or set to anything other than `1`, means route still writes the lesson and still updates both indexes in the same pass. To turn it on for a project, export `MISTAKE_BRAIN_INDEX_GATE=1` in the shell environment that launches Claude Code (e.g. the project's `.envrc`, a wrapper script, or your shell profile) — `.claude/settings.json` hook entries have no `env` key, so this cannot be set per-hook in settings.json; the hook only sees what the `claude` process itself inherited.
3. **Gate on.** Route still writes `.agent-brain/shared/` and still sets `Status: routed`. It does not add the `MEMORY.md` line. `scripts/index_admission.py` writes that same line into both indexes only when someone approves it. `init` does not turn the gate on.

## Left unchanged

No new `Status` value. Promote still needs its own approval. Recall still does not read `MISTAKES.md`. No capture pipeline, scoring, or dashboard.
