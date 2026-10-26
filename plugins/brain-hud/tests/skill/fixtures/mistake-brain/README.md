# mistake-brain fixtures

Synthetic data used to validate the `mistake-brain` skill's `log → route → promote` pipeline end-to-end, including the `/mistake-brain promote` approval gate (both the interactive-confirm branch and the `AGENT_AUTO_IMPROVE=1` branch). Originally written directly into the real repo files (`MISTAKES.md`, `.agent-brain/`, `.claude/rules/`, `CLAUDE.md`) during initial development; relocated here on review since production-facing files shouldn't carry synthetic content, tagged or not.

## Layout

Mirrors the real repo structure so it's obvious what each file corresponds to:

```
MISTAKES-fixture-entries.md          — the 6 synthetic log entries (3 payments, 3 CI)
agent-brain/claude/Areas/payments.md — the routed PARA lesson file
agent-brain/claude/Areas/ci.md       — the routed PARA lesson file
rules/payments.md                    — the promoted rule (Area-scoped)
rules/ci.md                          — the promoted rule (Area-scoped, corrected — see below)
```

## What this demonstrated

- **Interactive gate:** the payments cluster (3 entries, same root cause) was presented to a user via a real approval prompt — exact rule text, destination, evidence — and only written after an explicit yes.
- **AGENT_AUTO_IMPROVE=1 gate:** the CI cluster was written with no prompt, then surfaced afterward per the spec ("show what you wrote, not silent").
- **A real classification error, caught on review:** the CI cluster was originally promoted to `CLAUDE.md`'s Rules section during the live exercise. That was wrong — `promote.md`'s own scope rubric says a rule naming a specific system ("the CI retry wrapper") is Area-scoped, exactly like payments, not global. The mistake was deliberate at the time (chosen to exercise both promotion destinations in one demo) rather than a genuine rubric ambiguity — logged as its own real entry in the live `MISTAKES.md` (2026-08-14 23:10), since overriding a classification decision to manufacture test coverage is itself a process mistake worth capturing. `rules/ci.md` here shows the corrected artifact: what the rubric actually produces when followed.

## Why fixtures instead of a live demo in production files

Keeping `.claude/rules/` and `CLAUDE.md` free of synthetic data means anyone reading the live repo's rules sees only real, enforced guidance — no `[test fixture]` caveats to mentally filter out. This directory is the trade: the mechanism's validation record lives here, reproducibly, without polluting what the mechanism actually governs.
