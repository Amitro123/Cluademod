# promote.md — repeated patterns → hard rules

Invoked by `/brain-hud:mistake-brain promote`. Goal: catch the mistakes or success patterns that keep repeating despite being logged and routed, and turn them into something that actually changes future behavior — a rule in `CLAUDE.md` (if it should apply everywhere) or `.claude/rules/<slug>.md` (if it's scoped to one area).

The reasoning: a lesson sitting in `.agent-brain/Areas/ci.md` only helps if something reads that file before touching CI. A rule in CLAUDE.md is read every session, unconditionally. That's a much stronger guarantee, which is exactly why it needs a much higher bar — three independent occurrences of the same pattern, not one bad (or one great) afternoon.

**Two evidence sources, same bar:** a candidate rule can come from either of two directions, and both are held to the same 3x threshold:
- **Repeated mistakes** — the same `Root cause` (Type: mistake entries) showing up 3+ times. This is the original, and still the more common, path.
- **Confirmed success patterns** — the same `Success pattern` (Type: success entries) showing up 3+ times without a subsequent correction. A pattern that's worked three separate times unprompted is just as strong a signal as a mistake that's happened three times — it's evidence for a rule to *keep doing X*, not just a rule to *stop doing Y*.

**Note on success-entry promotion quality:** promotion quality for `success` clusters is inherently limited by how consistently they get manually logged — unlike `mistake` entries, which have a deterministic capture path via the git-revert hook. A small `success` cluster doesn't mean the pattern is rare; it may mean logging was inconsistent. Weight success-cluster evidence with that gap in mind.

`Type: decision` and `Type: handoff` entries are never promotion candidates — a decision records one judgment call and a handoff records a point-in-time context snapshot, neither of which is a repeating pattern by nature. `check_repetition.py` already excludes them from clustering (empty `cluster_key`), so this isn't something this procedure has to check for separately.

**This is the route-vs-promote asymmetry, stated as a design principle (see SKILL.md's "Safety" section):** `route` writes to `.agent-brain/` freely because that's knowledge classification, not a behavior change. `promote` writes to `CLAUDE.md`/`.claude/rules/` — which change agent behavior for every future session — so it requires explicit approval (or `AGENT_AUTO_IMPROVE=1`) every single time. That's the entire reason this file has an approval gate and `router.md` doesn't.

**Scope tradeoff, by design (amended below):** `check_repetition.py` only scans the active `MISTAKES.md`, never `MISTAKES-archive.md` (see `router.md` step 1 / `scripts/compose_mistakes.py`). A pattern that repeats with a very long gap — long enough that its earlier instances got archived out before this run — won't be caught by the script alone. Scanning the full archive on every run would reintroduce the unbounded-cost problem `compose_mistakes.py` exists to solve, so that's still off the table. **Amendment:** step 2 below adds a cheap, targeted fallback for the specific case of a 2-instance active cluster, instead of leaving that case to manual judgment. This is a deliberate addition to the original tradeoff, not a silent expansion of scope — a cluster that's genuinely a lone repeat with no archive match still gets left alone, exactly as before.

## Procedure

1. Run the repetition scanner from the repo root, asking for pairs as well as full triples so step 2 has something to check against the archive:
   ```bash
   python <skill_root>/scripts/check_repetition.py MISTAKES.md --min-count 2 --json
   ```
   This groups MISTAKES.md entries (unrouted or routed — promotion looks at the whole unactioned log, not just fresh entries) by similarity of their clustering key — `Root cause` for `Type: mistake` entries, `Success pattern` for `Type: success` entries, computed separately so a mistake and a success never end up in the same group — excluding anything already `promoted` (it already has a rule; see the script's docstring) and skipping `Type: decision`/`Type: handoff` entirely (they have no clustering key). Each group in the output carries a `type` field telling you which evidence source it came from. Split the result into two buckets: groups with 3+ members (already qualify) and groups with exactly 2 (candidates for step 2's archive check). Discard groups of 1 — nothing to do with those.

2. **Archive fallback, for each 2-member group only:** pull 2-4 salient keywords out of the group's representative `cluster_key` text (skip stopwords/filler — keep the specific nouns/verbs that would identify this pattern, e.g. "idempotency key", "payment retry"). `Grep` `MISTAKES-archive.md` for those keywords (case-insensitive, content mode, a few lines of context) — this is a targeted lookup, not a full read, so it doesn't reintroduce the cost the archive split was meant to avoid. If a hit is the same `Type` as the group and its `Root cause`/`Success pattern` field is describing the same pattern (use judgment — same mechanism, not just an incidental word overlap), treat the pair as having reached 3: the 2 active entries plus this archived one. Carry it forward into step 3 like any other qualifying group, but mark the archived entry distinctly in the evidence (e.g. "(archived)") so the approval prompt in step 4 is honest about where it came from. If no archive hit qualifies, drop the 2-group — it stays below threshold, exactly as the original design intended.

3. If there are no groups that qualify (3+ active, or 2 active + 1 archived match), tell the user "no mistake root cause or success pattern has repeated 3+ times yet" and stop. Don't force a promotion out of 2 similar-but-not-quite entries with no archive corroboration — that's what makes this signal trustworthy.

4. For each qualifying group, draft a candidate rule:
   - Write it as a single imperative sentence, the way you'd want to read it in CLAUDE.md — not a description of the pattern, an instruction for next time. For a mistake-sourced group: "Before running a DB migration in CI, check for an existing lock file" — not "CI migrations sometimes fail due to lock contention." For a success-sourced group, the rule is "keep doing X," not "stop doing Y": "When an Area file crosses ~300 lines and covers more than one sub-domain, split it along the sub-domain boundary" — not a description of the time it happened to work.
   - Decide scope: if the repeated pattern is genuinely general (would apply regardless of which part of the codebase you're in), it's a CLAUDE.md candidate. If it's scoped to one area (only matters for auth code, only matters for the frontend build), it belongs in `.claude/rules/<area-slug>.md` instead — check whether a rules file for that area already exists before creating a new one.
   - Cite the evidence: list the specific MISTAKES.md entries (date + title) that justify this rule, and note the evidence source (mistake repetition or success-pattern repetition). This is what makes it a proposal grounded in repetition, not a guess.

5. Present each candidate to the user for approval — **do not write anything yet**. Show:
   - The exact rule text.
   - Exactly where it would go (which file, and whether it's a new file or an addition to an existing one).
   - The evidence list (including any archived entry pulled in by step 2, labeled as such).

   Check `AGENT_AUTO_IMPROVE` first (`echo $AGENT_AUTO_IMPROVE`): if it's not `1`, this presentation is mandatory and you must wait for an explicit yes/no per candidate before writing anything — see SKILL.md's Safety section for why this gate exists and isn't optional by default. If `AGENT_AUTO_IMPROVE=1`, you may write directly, but still show what you wrote afterward so it's visible, not silent.

6. On approval, write the rule:
   - **CLAUDE.md**: append under an existing `## Rules` heading if one exists, otherwise create one. Keep the file's existing structure and tone — don't reformat unrelated parts of the file.
   - **.claude/rules/<slug>.md**: create or append to the area-specific file, one rule per bullet.

7. After writing, close the loop on the source entries: for each MISTAKES.md entry that justified the rule, update its `Status` field to `promoted` (leave `PARA route` as-is — promotion doesn't undo routing). An archived entry pulled in by step 2 doesn't need a live-file edit — it already recorded its justification when it was originally routed; note it in MEMORY.md's evidence trail instead (next). Then add one line to the shared `.agent-brain/shared/MEMORY.md` under "Rules promoted so far" recording the rule, where it went, and which entries justified it (active and archived alike) — this is the audit trail back from "why does this rule exist" to the actual failures.

## What NOT to do

- Don't promote off a single dramatic failure or a single great outcome, no matter how costly or impressive — the threshold is repetition, not severity or impact. A one-off catastrophe belongs in Archives with a strong prevention note, not in CLAUDE.md; a one-off win belongs in its PARA file, not yet a rule.
- Don't silently rewrite or merge existing CLAUDE.md rules while you're in there for an unrelated promotion — scope your edit to the addition you proposed.
- Don't treat "the user said yes once before" as standing approval for future promotions — each candidate gets its own explicit confirmation, every run, unless `AGENT_AUTO_IMPROVE=1` is set.
- Don't invent a grouping the scanner didn't find in order to hit the threshold faster — if two entries feel related but the scanner split them into different groups, that's a signal the underlying patterns aren't actually the same; describing them more precisely (not lumping them together) is the fix.
- Don't let step 2's archive fallback turn into a full archive read "just to be thorough" — it's a targeted keyword grep against 2-member groups only. A 1-member active entry doesn't get an archive check at all; that's still outside this amendment's scope.
- Don't try to promote a `Type: decision` or `Type: handoff` entry — they're excluded by design (see the top of this file), not by an oversight in the scanner.
