---
name: mistake-brain
description: 'Persistent cross-session memory. Invoke proactively to log events to MISTAKES.md (Type: mistake/success/decision/handoff), classify into PARA memory (.agent-brain/shared/Projects|Areas|Resources|Archives), and propose hard rules for CLAUDE.md or .claude/rules/ after 3+ repeats (never without approval unless AGENT_AUTO_IMPROVE=1). Also handles: /brain-hud:mistake-brain log, route, promote, dream, recall, init, update.'
when_to_use: 'A fix just landed (yours, or one the user tells you they made, with its cause), a bug got reverted, the same bug happened again, a regression needs root-cause tracing, the user corrects your approach. An approach worked well and is worth repeating. A real decision was made between alternatives. A task/session is ending with context a future session needs cold. Starting a task that might match a prior lesson, retrying a failed approach, or the user mentions a recurring bug — use /brain-hud:mistake-brain recall. Do NOT use for plain feature requests, general Q&A, or first-time issues with no pattern to log.'
---

<!-- Keep this file's body under 500 lines (the progressive-disclosure cap skills are meant to respect) —
     push detail into references/ instead of growing this file. Check with: wc -l SKILL.md -->

# mistake-brain

Persistent memory for this agent — not just of its mistakes, but of anything worth carrying into a future session: mistakes, confirmed successes, real decisions, and handoffs. It combines two ideas into one pipeline:

1. **MISTAKES.md** — a flat, append-only inbox, despite the name (kept for continuity — see `format-spec.md` for why). Every event gets logged in a fixed format the moment it happens, with zero judgment calls at write time. A `Type` field (`mistake` / `success` / `decision` / `handoff`) selects which fields follow. Fast to write, cheap to never lose anything.
2. **PARA memory** (`.agent-brain/shared/`) — where lessons actually *live*, organized as Projects / Areas / Resources / Archives. Claude Code and Cursor each keep their own index of that same store.

MISTAKES.md entries that repeat the same root cause (mistakes) or the same confirmed pattern (successes) 3+ times graduate into hard rules in CLAUDE.md or `.claude/rules/`. That promotion step is the payoff: without it you just have a diary; with it, patterns become enforced behavior instead of things you vaguely remember happened before. `decision` and `handoff` entries route into PARA like everything else but are never promotion candidates — see `promote.md` for why.

```
event happens → log (MISTAKES.md, fast, unstructured triage, Type: mistake|success|decision|handoff)
              → route (classify into PARA, .agent-brain/shared/…, same tree for Claude Code and Cursor)
              → promote (3+ repeats of the same root cause or success pattern → CLAUDE.md / .claude/rules/)
dream = periodic reflection across the whole memory (all Types), run occasionally, not per-event
recall = on-demand: from MEMORY.md index, load at most 2 matching PARA files
```

## Where this skill lives

This skill ships in the **brain-hud** plugin (claudemod), together with its hooks and the Brain pane that draws the memory. Its command is `/brain-hud:mistake-brain`. `<skill_root>` in these files is this skill's folder: the "Base directory for this skill" shown when it loads. Run its scripts from there (`python "<skill_root>/scripts/…"`, or `python3` where `python` isn't Python 3); never from a copy elsewhere, which may be an older version.

The plugin registers the hooks below itself (its `hooks/hooks.json`), in every project. In a project with no `MISTAKES.md` and no `.agent-brain/` they do nothing. `init` registers none and removes the ones an older install put in the project's settings.

## Automatic pipeline — no commands required

All steps fire automatically via the plugin's hooks. You should not need to type `/brain-hud:mistake-brain <subcommand>` in normal use:

| Step | Trigger | Hook |
|---|---|---|
| **log** (mistake, git discard/undo) | Stop owns `git revert`/`reset --hard`; Bash owns `checkout --`/`restore`/`clean -f` | `revert_stop_hook.py` (Stop) + `draft_mistake_on_revert.py` (PostToolUse: Bash) |
| **candidate capture** (validation failure) | Bash\|PowerShell exits non-zero on a recognized validation command (lint/test/type-checker); not an interrupt | `draft_mistake_on_validation_failure.py` (PostToolUseFailure: Bash\|PowerShell) — writes to `.claude/mb-pending-candidates.json`, NOT MISTAKES.md; finalize or discard after diagnosis + confirmed fix |
| **route** | MISTAKES.md written and **≥ 3 unrouted entries** accumulated | `auto_pipeline_on_mistakes_edit.py` (PostToolUse: Edit\|Write\|MultiEdit) — batched at 3+ to stay non-intrusive; injects "route now" into context. Use `/brain-hud:mistake-brain route` for immediate routing after 1–2 entries. |
| **promote** (surface candidates) | MISTAKES.md written after routing (unrouted = 0) | same hook — runs `check_repetition.py`, injects "N patterns ready" if 3+ repeats |
| **route** (leftover from prior session) | Every session start | `brief_on_session_start.py` (SessionStart) — "ACTION REQUIRED: N unrouted entries" |
| **dream** (reminder) | Every session start, when MEMORY.md ≥ 170 lines or last dream > 7 days | `brief_on_session_start.py` (SessionStart) |
| **index counts and dates** | Every session start, and after any lesson file in `.agent-brain/shared/` is written | `brief_on_session_start.py` and `auto_pipeline_on_mistakes_edit.py` run `scripts/rebuild_index.py` — the counts and dates are facts on disk, never typed |

**What still requires a command:**
- `log` for `success`, `decision`, `handoff` types — no mechanical trigger exists for these; use `/brain-hud:mistake-brain log` (or Claude notices the trigger via the skill description)
- `log` finalization for validation failures — after a validation failure is captured and the fix is confirmed, run `/brain-hud:mistake-brain log` to finalize as a durable MISTAKES.md entry (then delete from `.claude/mb-pending-candidates.json`). If transient with no lasting lesson, delete the candidate without logging.
- `promote` write step — always requires explicit user approval, even when candidates are surfaced automatically
- `dream` execution — surfaced as a reminder, but the actual reflection run requires `/brain-hud:mistake-brain dream`

## Files this skill owns

| Path | Role |
|---|---|
| `MISTAKES.md` (repo root) | Active, chronological log of all four entry types (mistake/success/decision/handoff). Newest first. Append-only — never rewrite past entries, only update their `Status`/`PARA route` fields. |
| `MISTAKES-archive.md` (repo root) | Overflow for already-routed/promoted entries, moved out automatically by `scripts/compose_mistakes.py` once `MISTAKES.md` crosses a line threshold, so the active log stays a manageable size. One file, not one per period — see `router.md` step 1. |
| `.agent-brain/shared/Projects/*.md` | Lessons tied to a specific, currently active project or feature. Shared by every harness. |
| `.agent-brain/shared/Areas/*.md` | Lessons tied to an ongoing responsibility (auth, CI, DB migrations...) that never really finishes. |
| `.agent-brain/shared/Resources/*.md` | General, reusable principles that would hold true in a different codebase too. |
| `.agent-brain/shared/Archives/*.md` | Closed, one-off lessons unlikely to recur. |
| `.agent-brain/shared/MEMORY.md` | Always-on shared index (~200 lines) — one file, read and written by every harness, not a per-harness copy. SessionStart injects it; never grep raw PARA or `MISTAKES.md` as a first step. Archives are a count only, not per-file one-liners. |
| `.claude/mb-pending-candidates.json` | Transient runtime state only — pending validation-failure candidates not yet finalized as MISTAKES.md entries. Gitignored. Discarded after finalize/discard decision. Not part of PARA knowledge. |
| `CLAUDE.md` / `.claude/rules/*.md` | Hard rules. Only ever written after a 3+ repeat *and* explicit user approval (see Safety below). |

Lessons are one store, `.agent-brain/shared/`, and the session index is one file, `.agent-brain/shared/MEMORY.md` — Claude Code and Cursor do not get separate lesson trees or separate indexes. Each harness still has its own rules file (`.claude/rules/` vs `.cursor/rules/`) and its own SessionStart plumbing, but both read and write the same `MEMORY.md`. It does not write `.agent-brain/claude/` or `.agent-brain/cursor/`.

## Concurrency: single-writer assumption

Every file this skill writes to — `MISTAKES.md`, everything under `.agent-brain/shared/` (including the shared `MEMORY.md`), `CLAUDE.md`, and `.claude/rules/` — is designed for **single-writer-per-file access**. There is no locking mechanism here; `log`/`route`/`promote`/`dream` all read-then-write with no protection against a concurrent writer changing the file in between.

This is fine under the assumption this skill was built for: one agent identity (`claude`), operating serially, one command at a time. It stops being fine the moment two agent *sessions* run `mistake-brain` concurrently against the same file — e.g. an `arch-lead` sub-agent and a `ui-designer` sub-agent both logging failures and routing at the same time. Two concurrent `route` passes reading `MISTAKES.md`, computing a diff, and writing it back can race and silently drop one of them; two concurrent `promote` passes under `AGENT_AUTO_IMPROVE=1` could both decide to write the same rule.

If you're extending this to multiple concurrent named agents, here are three real options, not a default to fall back on:
1. **Give each agent its own files** — lessons are one shared store on purpose, so this means a separate project, or a separate lesson file per agent inside `.agent-brain/shared/`. Claude Code and Cursor now share both the lesson files and the single `MEMORY.md` index, which sharpens this risk, not just carries it over — do not run both harnesses' `route` at the same moment.
2. **Add explicit serialization** before allowing concurrent `route`/`promote` passes on files that *are* shared across agents by design — the top-level `MISTAKES.md` and repo-wide `CLAUDE.md`/`.claude/rules/` are the ones that don't naturally partition per-agent.
3. **Route all writes through a single orchestrating session** — instead of serializing at the file level, let sub-agents report findings back to one coordinator that's the only thing that ever actually writes to the shared files. Simpler to reason about than per-file locking, at the cost of that orchestrator becoming a bottleneck.

Don't assume this is handled — it isn't, on purpose, because the single-agent-serial case is what this skill was actually built and tested against.

This is also why `Type: handoff` entries deliberately do **not** get a `consumed`-on-read status: marking an entry "consumed" the moment a session reads it would mean the read path writes, which reintroduces exactly the write-race this section describes, just triggered by reading instead of logging. `handoff` uses the same `unrouted`→`routed`→`promoted` lifecycle as every other type; staleness is instead caught by `dream.md`'s heartbeat-style per-entry date check (see `references/dream.md`), which only ever reads.

## Command dispatch

`/brain-hud:mistake-brain <subcommand> [args]`. If no subcommand is given, or the trigger was an actual failure rather than a typed command, default to `log`.

| Subcommand | What it does | Detail |
|---|---|---|
| `log <description>` | Append a new entry to MISTAKES.md (any Type) | inline below |
| `route` | Classify unrouted MISTAKES.md entries into PARA | `router.md` |
| `promote` | Find 3+ repeated root causes or success patterns, propose a rule | `promote.md` |
| `dream` | Reflect across the whole memory, tidy it up | `references/dream.md` |
| `recall [query]` | Load at most 2 PARA files matching the current task | `references/recall.md` |
| `init` | Scaffold all per-project files for a fresh project | `init.md` |
| `update` | Sync per-project hooks, SessionStart, and retrieval rules | `update.md` |

## Retrieval — always-on vs on-demand vs never

Token savings come from **not loading the brain**. Three buckets:

- **Always-on (bounded):** `MEMORY.md`, hard-capped at 200 lines. Claude Code injects it via the `SessionStart` hook (`brief_on_session_start.py`, matcher `startup|resume|clear|compact` — compact re-injects after history is dropped). Cursor gets the same briefing from `hooks/cursor_brief.py` (registered in `~/.cursor/hooks.json`), reading the same shared index. If no briefing is in context, `.cursor/rules/mistake-brain.mdc` is the fallback: read `.agent-brain/shared/MEMORY.md` once, then stop.
- **On-demand:** `/brain-hud:mistake-brain recall` — from the index already in context, read **at most 2** matching Projects/Areas/Resources files. See `references/recall.md`.
- **Never for retrieval:** `MISTAKES.md` body, Archives files (unless the query is explicitly historical), and the rest of `.agent-brain/`. The inbox is for `log`/`route` only.

Do not grep `MISTAKES.md` or dump PARA "just in case." If the index has no match, say so in one line and continue.

## `log` — record a new entry

This is the one you'll run constantly, so it's fully inline here (the others are less frequent and get their own files).

Run this immediately after any of:
- a fix you just applied for something that broke, the user correcting your approach ("no, don't do X", "that's wrong", "revert that"), a change that got reverted or undone, a test failure you had to chase down, or realizing mid-task that an earlier assumption was wrong → **`Type: mistake`**
- an approach, fix, or pattern that worked cleanly and would be worth reaching for again → **`Type: success`**
- a real choice made between two or more genuine alternatives, where the reasoning is worth preserving → **`Type: decision`**
- a task or session ending with state a fresh session would need to pick up cold → **`Type: handoff`**

Don't wait to be asked, and don't skip small ones — the whole point of `promote` is catching patterns across *small*, easy-to-dismiss events that no one would remember to escalate on their own.

Steps:
1. Read the current top of `MISTAKES.md` (just enough to know where to insert — you don't need the whole file).
2. Pick the `Type` and fill in the matching template from `references/format-spec.md`. Common shape:
   ```md
   ## [YYYY-MM-DD HH:MM] <short title>
   - **Type:** mistake | success | decision | handoff
   - **What happened:** <concrete, factual>
   <type-specific fields — Root cause/Consequence/Prevention rule (mistake), Success pattern/Impact/Repeat guidance (success), Rationale/Alternatives considered/Impact (decision), or Context needed/Next steps (handoff)>
   - **PARA route:** unrouted
   - **Status:** unrouted
   ```
   Take the date and time from the shell, never guess them: `date '+%Y-%m-%d %H:%M'` (PowerShell: `Get-Date -Format 'yyyy-MM-dd HH:mm'`). `validate_mistakes.py` flags a header dated in the future. Keep every field to 1-2 sentences — this is a log entry, not a postmortem doc. If you don't know a field yet (e.g. root cause), write your best hypothesis rather than leaving it blank; `router.md` and `promote.md` both depend on the clustering field being filled in, even approximately.
3. Insert the new entry immediately below the `<!-- mistake-brain: new entries are inserted immediately below this line -->` marker, so the file stays newest-first.
4. Don't route or promote in the same step — that's a separate, batched pass (see below). Logging should be a fast, un-interrupting side effect of doing the actual work.

You can log more than one entry per session, of mixed Types. Each is independent.

## `route` — classify into PARA

See `router.md`. In short: for every MISTAKES.md entry with `Status: unrouted`, decide Project / Area / Resource / Archive, append a short lesson to the matching `.agent-brain/shared/` file, update the shared MEMORY.md index, then flip the MISTAKES.md entry's `Status` to `routed` and fill in `PARA route`. When `MISTAKE_BRAIN_INDEX_GATE=1`, still write the lesson and still set `Status: routed`, and do not update the index until the user approves that lesson (`scripts/index_admission.py` writes that line into the shared index). The gate is off when unset, and `init` does not turn it on. This can run standalone (`/brain-hud:mistake-brain route`) or you can run it automatically at natural checkpoints (end of a task, before compacting context) — but always as a distinct pass over possibly-several entries, not fused into `log`.

## `promote` — repeated pattern → hard rule

See `promote.md`. In short: run `scripts/check_repetition.py` over MISTAKES.md, look for root causes (mistakes) or success patterns (successes) appearing 3+ times, draft a one-sentence rule, show the user exactly what would be added and where, and only write it after they say yes. `decision`/`handoff` entries are never candidates.

## `dream` — reflect on the whole memory

See `references/dream.md`. A periodic, not per-event, pass: read MEMORY.md and all PARA files, look for stale Projects that should archive, Areas that have grown unwieldy, stale unactioned handoffs, MEMORY.md over the 200-line cap, and anything promote.md would flag — then update MEMORY.md's summaries and report findings to the user. Never rewrites PARA content without confirmation; MEMORY.md's own index/summary section is the one thing it's allowed to regenerate freely, since it's derived data. Archives stay off the hot index (a count line only).

## `recall` — load matching lessons

See `references/recall.md`. From MEMORY.md already in context, pick at most 2 PARA files that match the current task. Do not read `MISTAKES.md`. Do not open Archives unless the query is explicitly historical.

## Safety: confirm before writing durable rules

**Design principle, stated explicitly rather than left implicit:** `route` writes to `.agent-brain/` without requiring user approval, because those writes are *knowledge classification*, not a behavior change — reversible, low-stakes, easily corrected on the next `dream` pass. `promote` requires explicit approval (or `AGENT_AUTO_IMPROVE=1`) before writing to `CLAUDE.md` or `.claude/rules/`, because those writes *change agent behavior going forward*, for every future session, not just this one. The asymmetry is deliberate — it's not that `promote` is "more important," it's that its writes are a different kind of thing.

`log` and `route` only ever touch `MISTAKES.md` and `.agent-brain/`, which are low-stakes, easily-corrected working memory — write to them freely.

`promote` is different: it writes to `CLAUDE.md` or `.claude/rules/`, which change how every future session behaves. Before writing either of those:

1. Check whether `AGENT_AUTO_IMPROVE=1` is set in the environment (`echo $AGENT_AUTO_IMPROVE`).
2. If it is **not** set (the default), show the user the exact diff you want to make and wait for explicit approval before writing. Do not proceed on an ambiguous or implied yes.
3. If it **is** set, you may write directly, but still log what you did (which entries justified it, what you wrote) in MEMORY.md's "Rules promoted so far" section so it's auditable after the fact.

This default-to-asking behavior applies only to `CLAUDE.md` and `.claude/rules/`. It does not apply to `MISTAKES.md` or `.agent-brain/`.

## Reliability guarantee by entry Type

**`Type: mistake`** — deterministic capture is split to prevent duplicate drafts:
`revert_stop_hook.py` owns `git revert` and `git reset --hard` at Stop;
`draft_mistake_on_revert.py` handles worktree-only commands via PostToolUse:
- `git checkout -- <path>`
- `git restore …`
- `git clean -f` (and variants: `-fd`, `-fxd`, `-df`, etc.)

`draft_mistake_on_validation_failure.py` handles recognized validation-command exits
(lint, test runners, type-checkers) via PostToolUseFailure: Bash|PowerShell. This writes
a **pending candidate** to `.claude/mb-pending-candidates.json`, not a direct MISTAKES.md
entry — finalization requires confirmed fix + durable lesson.

These are the only automatic capture triggers. Retrieval has a separate deterministic path: the `SessionStart` hook injects a bounded MEMORY.md briefing (see Retrieval above).

**General skill-description trigger recall** is approximately 73% when a standing instruction
in CLAUDE.md reinforces the skill description, and approximately 27% on the skill description
alone. Both numbers are small-sample, directional signals — not guarantees. Explicit
`/brain-hud:mistake-brain log` after any fix or revert remains the reliable fallback regardless of
trigger recall.

**`Type: success`, `decision`, `handoff`** — no deterministic trigger. These types depend
entirely on `/brain-hud:mistake-brain log` being invoked manually or on Claude noticing a session-end
prompt. They are not held to the same reliability bar as `mistake` entries.

Practical mitigation: before ending any session, ask — any decisions made, handoffs needed,
or patterns that worked worth logging?

## PARA classification cheat sheet

Full decision tree lives in `router.md`; quick version:

- **Project** — tied to work that's still open right now (a branch, a ticket, a feature in progress).
- **Area** — tied to a domain you'll keep coming back to regardless of which project (auth, CI, deploys, a specific service).
- **Resource** — a principle that would still apply in a different codebase entirely.
- **Archive** — closed, unlikely to recur (an incident, an outage, a project that's finished or dead).

`references/para-guide.md` has worked examples for the ambiguous cases (e.g. "is this a Project lesson or an Area lesson?").
