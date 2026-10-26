# onboarding.md — first-week walkthrough

Supplement to the "Getting Started / Cold Start" section in the repo's root `README.md`. That section tells you *what to expect*; this file walks through *what it actually looks like*, day by day, with the real thresholds from the code — not vague descriptions of "eventually" or "enough."

## Day 1

A fresh `MISTAKES.md` looks like this — the full header, no entries below the marker (quoted verbatim, not paraphrased, so you can diff your own fresh file against it):

```md
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

<!-- mistake-brain: new entries are inserted immediately below this line -->
```

To log the first entry, either let the skill trigger automatically (unreliable right now — see the FAQ below) or run it yourself:

```
/brain-hud:mistake-brain log <one-line description of what happened>
```

That dispatches to `SKILL.md`'s `log` procedure: it picks a `Type` (`mistake`/`success`/`decision`/`handoff`) and fills in that type's template from `references/format-spec.md` — every type shares `What happened` plus a `Type`-specific set of fields (e.g. `Root cause`/`Consequence`/`Prevention rule` for a mistake) — and inserts it right below the marker. `PARA route` and `Status` both start as `unrouted` — nothing else happens automatically. `route`, `promote`, and `dream` are separate, deliberately not fused into `log` (see `SKILL.md`'s `log` section for why: logging should be a fast, uninterrupting side effect of doing the actual work).

You can run `/brain-hud:mistake-brain route` any time after that first entry exists — even with just one entry, it'll correctly classify it into a PARA file. There's no minimum batch size for `route` to be useful; the "wait for volume" constraint is specific to `promote` and `dream`.

## Week 1 — expected state

By the end of a normal first week of real usage, expect:
- A handful of entries in `MISTAKES.md` — some `unrouted` (not yet routed), most probably `routed` (classified into a PARA file) if you've run `route` a few times.
- **Zero entries `promoted`.** This is normal, not a sign something's wrong — see the threshold below.
- One or two PARA files under `.agent-brain/shared/`, likely just one or two Projects/Areas, each with a small number of lessons.
- `dream` findings that are still mostly trivial ("no stale Projects, no oversized Areas") — there just isn't enough material yet for the interesting findings (cross-cutting patterns, staleness) to show up.

None of this means the mechanism isn't working. It means the mechanism is working exactly as designed for week 1 — the payoff (`promote`, and `dream`'s cross-file findings) is specifically about *patterns across time*, which requires time to pass.

## When `promote` starts being useful

`promote` calls `scripts/check_repetition.py`, which has two real, literal thresholds you can check yourself in the script:
- `--min-count`, default **3** — a root cause (mistakes) or a success pattern (successes) needs to appear 3 times (or 2 times plus one match in `MISTAKES-archive.md`, via `promote.md`'s archive-fallback step) before it's even reported as a candidate.
- `--threshold`, default **0.6** — a text-similarity score (0–1) between two entries' clustering field (`Root cause` for mistakes, `Success pattern` for successes, never compared across the two); below this, they're treated as different patterns, not the same one repeating.

`decision` and `handoff` entries are never clustered — a decision or a handoff isn't a repeating pattern by nature, see `format-spec.md`.

In practice this means: `promote` has nothing to offer until you've hit the *same* underlying mistake or success three separate times, worded similarly enough in the clustering field for the similarity check to recognize them as the same thing (see `references/format-spec.md`'s guidance on writing these fields consistently — this is what determines whether `promote` can ever find your repeats). For most projects, that's realistically **weeks**, not days — three-in-a-row-on-day-one would be an unusually eventful week, not the normal onboarding path.

## When `dream` starts being useful

`dream.md`'s procedure doesn't hard-code a numeric minimum the way `check_repetition.py` does — its cross-cutting-pattern and stale/oversized checks are judgment calls, not a script threshold. But the practical floor is structural: with 0 or 1 PARA files, there is nothing to compare *against*, so the interesting findings (two files independently converging on the same principle, one file ballooning while others stay small) are mechanically impossible to surface. Useful signal realistically starts once you have **2+ PARA files** — which typically means you've run `route` across a couple of different domains, not just repeatedly into the same one file.

## FAQ

**Q: Why didn't the skill trigger automatically after I fixed a bug?**

Because it's currently unreliable at this specific job — two real measurements, not one, and both are recorded here so the numbers don't just float around as unsupported claims. **Caveat on both:** they were measured against the description as it stood for mistake-triggering only, before the `Type` schema (mistake/success/decision/handoff) was added — the description was later broadened to also cover success/decision/handoff triggers (see `SKILL.md`) without touching the original mistake-triggering wording these numbers are based on, so the *mistake* recall figures below should still be directionally accurate, but they've never been re-measured against the current text, and there's no equivalent measurement yet for success/decision/handoff triggering at all.

1. **Skill description alone, no other reinforcement.** 20-query eval set (60/40 train/validation split), 3 isolated runs per query via `claude -p --session-id <fresh> --no-session-persistence` (genuine isolation — no shared context with any other session). Should-trigger recall: **1/11 (9%)** before rewriting the description, **3/11 (27%)** after. Should-not-trigger: a clean 9/9 in both runs — the gap is specifically under-triggering, not false positives.

2. **Same description, plus reinforcing the identical instruction in `CLAUDE.md`** (which loads unconditionally into every session's context, unlike a skill description competing for the model's attention). Re-measured the same 11 should-trigger queries, 3 isolated runs each, majority-of-3 (≥2/3) counted as a trigger:
   ```
   [3/3] ok I just fixed the auth bug where the token wasn't being refreshed...
   [3/3] wait this is the third time we've hit this same flaky CI test issue...
   [3/3] I had to revert that migration change from yesterday, it broke prod again
   [2/3] can you run /brain-hud:mistake-brain promote and see if anything qualifies
   [0/3] no wait, don't do it that way, that's what caused the outage last time
   [3/3] log this: I forgot to handle the null case again in the parser...
   [3/3] we keep debugging the same regression in the payment service...
   [1/3] run dream on the mistake memory, been a while since we reflected on it
   [2/3] just reverted my last commit, the new caching logic broke the tests
   [0/3] why does this keep happening, every time we deploy on Friday...
   [2/3] the checkout retry bug from last month is back, same root cause...
   ```
   Recall (majority-of-3 ≥ 0.5 threshold): **8/11 = 73%**. Raw hit rate across all 33 individual runs: 22/33 ≈ 67%.

Both are small-sample, directional measurements (11 queries), not statistically tight numbers — treat the shape of the result (CLAUDE.md reinforcement measurably helps) as more trustworthy than the exact percentage. Two queries still failed outright even with CLAUDE.md reinforced ("no wait, don't do it that way..." and "why does this keep happening..." — both indirect/conversational phrasings rather than a direct statement that something was just fixed).

**Workaround, until this improves further:** don't wait for automatic triggering. Explicitly run `/brain-hud:mistake-brain log <description>` yourself right after any real fix, revert, correction, notable success, decision, or handoff. This matters more, not less, during the first weeks — a missed entry early on isn't just one lost data point, it's one less instance toward the 3x threshold that makes `promote` useful at all (for `mistake`/`success` entries — `decision`/`handoff` entries aren't threshold-gated, but a missed one is still lost context for a future session).

## Subagent sessions

Built-in agents (Explorer, Plan, Verify) cannot access skills — mistake-brain does
not run in their sessions. Custom subagents need `skills: mistake-brain` in their
frontmatter. Without it, mistakes in delegated work are silently lost.

See the repo README § Subagent visibility for the full YAML example.

## Session-end checklist

`Type: success`, `decision`, and `handoff` entries have **no automatic capture** — only `Type: mistake` has the git-revert hook. Before closing any session, spend 30 seconds asking:

- Did I make a real choice between alternatives? → `/brain-hud:mistake-brain log` with `Type: decision`
- Does a future session need state to pick up cold? → `/brain-hud:mistake-brain log` with `Type: handoff`
- Did an approach work cleanly and is worth repeating? → `/brain-hud:mistake-brain log` with `Type: success`

If you skip this, those events are permanently lost — no fallback will catch them.
