# MISTAKES.md entry format

Every entry, no exceptions, uses a fixed template so `check_repetition.py` and `router.md` can parse it reliably. The template has a common header shared by all entries, plus type-specific fields chosen by the `Type` field.

## Common template

```md
## [YYYY-MM-DD HH:MM] <short title>
- **Type:** mistake | success | decision | handoff
- **What happened:** <one or two sentences, factual>
<type-specific fields — see below>
- **PARA route:** unrouted
- **Status:** unrouted
```

- **Title**: short, specific, greppable. "Forgot to await async DB write in checkout" not "Bug in checkout."
- **Type**: which of the four kinds this is (see below). Determines which type-specific fields follow, and which field `check_repetition.py` clusters on.
- **What happened**: describe the observable event, not the write-up. "Tests passed locally but failed in CI with a timeout" not "I fixed the flaky test."
- **PARA route** / **Status**: managed by `/brain-hud:mistake-brain route` and `/brain-hud:mistake-brain promote` — don't hand-edit these except when writing a brand-new entry (both start as `unrouted`).

**Backward compatibility:** an entry with no `Type` field is treated as `Type: mistake` — every entry logged before this field existed is a mistake entry, and nothing needs retroactive editing.

## The four types

### `mistake` — something broke or was wrong

Fields after **What happened**:
- **Root cause**: the actual underlying reason, not the symptom. This is the field `check_repetition.py` clusters on for mistakes — vague text ("something was wrong with the config") will never match anything, defeating the whole point of `/brain-hud:mistake-brain promote`. Be specific and consistent: reuse the same phrasing you've used before for the same kind of failure when it's genuinely the same cause.
- **Consequence**: what it actually cost — time lost, what broke downstream, whether the user had to notice and correct it themselves.
- **Prevention rule**: write this as an instruction, not a description. "Always await DB writes before returning a response" not "async writes can be missed."

### `success` — something worked and is worth repeating

Fields after **What happened**:
- **Success pattern**: the specific approach or decision that worked, phrased so a future occurrence of the same pattern would read as a clear match. This is the clustering key for successes — parallels `Root cause` for mistakes — so the same specificity/consistency guidance applies.
- **Impact**: what it actually bought — time saved, a class of bug avoided, a smoother review.
- **Repeat guidance**: write this as an instruction for next time, same as a mistake's prevention rule. "Write the migration lock check before the migration logic, not after" not "the lock check helped."

### `decision` — a choice was made between real alternatives

Fields after **What happened**:
- **Rationale**: why this option over the others — the actual reasoning, not just the outcome.
- **Alternatives considered**: what else was on the table and, briefly, why it lost out.
- **Impact**: what this decision actually changed or constrained going forward.

`decision` entries are not clustered by `check_repetition.py` and are out of scope for `/brain-hud:mistake-brain promote` — a decision is a record of a single judgment call, not a repeating pattern to graduate into a rule. They still route into PARA like everything else, so future sessions can find the reasoning.

### `handoff` — context a future session needs

Fields after **What happened**:
- **Context needed**: what a fresh session must know to pick this up cold — state, assumptions, anything not obvious from the code alone.
- **Next steps**: the concrete next actions, in order if order matters.

`handoff` entries are not clustered by `check_repetition.py` and are out of scope for `/brain-hud:mistake-brain promote`, for the same reason as `decision`. They use the same `Status` lifecycle as every other type (no separate "consumed" state — see `SKILL.md`'s Concurrency section for why a write-on-read status was rejected); staleness is instead caught by `dream.md`'s heartbeat-style check, which flags a `handoff` entry that's sat unrouted or unactioned past a threshold.

## `Status` lifecycle

`unrouted` → `routed` (set by `router.md`) → `promoted` (set by `promote.md`, only for `mistake`/`success` entries that became a CLAUDE.md/.claude/rules rule — most routed entries, and all `decision`/`handoff` entries, stay at `routed` forever, and that's fine).

## Worked examples

```md
## [2026-08-14 21:40] CI migration step failed on concurrent lock
- **Type:** mistake
- **What happened:** The DB migration step in CI failed with a lock-timeout error after another job had started a migration on the same shared staging DB.
- **Root cause:** No lock file or mutex guarding concurrent migration runs against the shared staging database.
- **Consequence:** CI run had to be manually re-triggered; ~15 minutes lost, and it wasn't obvious from the error message what had actually gone wrong.
- **Prevention rule:** Before running a DB migration in CI, acquire a lock (or check for one) scoped to the target database.
- **PARA route:** unrouted
- **Status:** unrouted
```

```md
## [2026-08-15 09:12] Splitting the payments Area file by sub-domain sped up review
- **Type:** success
- **What happened:** Split `Areas/payments.md` into `payments-retries.md` and `payments-webhooks.md` once it passed ~300 lines; the next `route` pass and the next human review of that Area were both noticeably faster to skim.
- **Success pattern:** When an Area file crosses roughly 300 lines and covers more than one sub-domain, split it along the sub-domain boundary rather than letting it keep growing.
- **Impact:** Review and route passes over payments-related entries got faster; no lessons were lost or duplicated in the split.
- **Repeat guidance:** During `/brain-hud:mistake-brain dream`, treat "oversized Area with 2+ distinguishable sub-domains" as a split candidate proactively, not only after someone complains it's hard to read.
- **PARA route:** unrouted
- **Status:** unrouted
```

```md
## [2026-08-15 10:05] Chose polling over a webhook for the CI status check
- **Type:** decision
- **What happened:** Needed to know when a CI run finished; chose to poll the CI API every 30s instead of registering a webhook receiver.
- **Rationale:** No public endpoint was available in this environment to receive a webhook, and the wait was typically under 5 minutes, so polling overhead was acceptable.
- **Alternatives considered:** A webhook receiver (rejected — no reachable public endpoint in this environment); a longer fixed sleep (rejected — wastes time on fast runs).
- **Impact:** Adds a small, bounded delay before status is known; no external endpoint to maintain or secure.
- **PARA route:** unrouted
- **Status:** unrouted
```

```md
## [2026-08-15 10:40] Mid-refactor handoff: auth token refresh migration
- **Type:** handoff
- **What happened:** Stopping partway through migrating token refresh from a cron job to an on-demand check; the on-demand path is implemented but not yet wired into the request middleware.
- **Context needed:** The new `refresh_if_stale()` function in `auth/tokens.py` is written and unit-tested, but nothing calls it yet — the old cron job is still active and should not be removed until the new path is verified in staging.
- **Next steps:** Wire `refresh_if_stale()` into the auth middleware; verify in staging; only then remove the cron job.
- **PARA route:** unrouted
- **Status:** unrouted
```
