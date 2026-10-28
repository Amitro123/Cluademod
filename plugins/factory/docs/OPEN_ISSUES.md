# Factory plugin: open issues

Source: post-hoc review of PR #105 (Amitro1234/keshet-claude-skills, "fix the 9 model-router issues"),
built by this factory. The review found defects D1-D6 that the factory run did not catch.
Root-cause analysis: `keshet-claude-skills/.factory/pr105-rootcause-analysis.md`.

## Status of D1-D6

| ID | Defect | Status | Why |
|---|---|---|---|
| D1 | Stale python test `test_contract.py` (PR rewrote `routed-worker.md`, test not updated); python suites never ran because `detectChecks` found no root config | MITIGATED | `detectChecks` (hooks/checks.ts) now detects checks generically and "none ran" is surfaced; the approver can still APPROVE with zero checks until (a) lands |
| D2 | `SKILL.md` grew past the 16000-byte cap enforced by `tools/test_build_plugin.py`; same cause as D1 | MITIGATED | Same as D1 |
| D3 | `explicitModel` in `register.tsx` disabled step routing for every Agent-tool subagent (`tool.call` rewrites model first); spec left it as an open question, builder guessed | OPEN | No open-question gate; approver does not re-read code. See (c) |
| D4 | False premise in an acceptance criterion: `run_in_background` is not an Agent tool input (Bash only); builder wrote code and a synthetic test matching it | OPEN | No rubric step validates AC fields against real types. See (e), (b) |
| D5 | Spec scoped issue 4 to the bundle only; sibling standalone mods left on old logic; spec-writer never flagged them | OPEN | See (d) |
| D6 | An AC allowed a docs-only resolution; scope creep (`namedReadBudget`) invisible to a diff-less approver | OPEN | See (f) |

Unverified: whether the model-router step-routing bug downranked the opus reviewers/approver during the run
(run records are absent). See (g).

## Known failing tests (fail on clean HEAD, not caused by this branch)

- Worktree folder excluded via exclude file.
- Every step's words go to the run's record.

## Prioritized OPEN list

### (a) Approver must refuse APPROVE when no checks ran (closes D1/D2 fully)
- Change: when checks status is `skip` / "NONE RAN", the approver verdict is ESCALATE unless the user explicitly overrides.
- Target: `hooks/flow.ts` (pass checks status into the approver prompt), `skills/approver/SKILL.md` (remove the "none were configured" approve path).
- Acceptance test: factory test with a repo where `detectChecks` returns [] -> approver prompt contains the checks status and the run ends `needs-human` unless the override option is set; with the override it can APPROVE.

### (b) Reviewers/approver get more than the diff
- Change: provide full contents of touched files plus the real type definitions (`types/*.d.ts`), not diff-only.
- Target: `reviewPrompt` in `hooks/flow.ts`; reviewer prompts under `skills/`.
- Acceptance test: prompt-builder test asserts the review prompt includes touched-file contents and the type file paths; a fixture with a stale assertion in a touched file is surfaced.

### (c) Open-question gate (D3)
- Change: spec-writer lists open questions in a fixed section; builder must resolve each or escalate; approver ESCALATEs while any is unresolved before DONE.
- Target: spec-writer prompt, `skills/approver/SKILL.md`, `hooks/flow.ts`.
- Acceptance test: spec fixture with an open question and a builder result that does not resolve it -> verdict ESCALATE.

### (d) Sibling copies (D5)
- Change: spec-writer must enumerate duplicate code paths (bundle vs standalone mods) for each change and mark each in or out of scope.
- Target: spec-writer prompt.
- Acceptance test: spec for a fixture repo with a duplicated function lists every copy; a missing list fails the spec-format check.

### (e) Rubric: validate ACs against real types (D4)
- Change: every AC naming an API field/input is checked against the real type definition; tests may not rely only on synthetic fixtures.
- Target: reviewer prompts (code-reviewer rubric), spec-writer prompt.
- Acceptance test: fixture AC referencing a nonexistent input field -> reviewer returns a blocker finding.

### (f) Scope-creep check (D6)
- Change: approver compares the diff's file/interface list to the spec/AC and flags additions not in it.
- Target: `hooks/flow.ts` (compute list), `skills/approver/SKILL.md`.
- Acceptance test: fixture diff touching a file absent from the spec -> approver output flags it and ESCALATEs.

### (g) Record/transcript retention
- Change: retain run records and per-role transcripts, including the model actually used per role.
- Target: `hooks/register.tsx` (record dir), `hooks/flow.ts`.
- Acceptance test: after a run, the record dir exists and lists role -> model for every step, so a post-mortem can verify routing.

### (h) Unattended runs and the "Run them?" prompt
- Decision needed: when `detectChecks` finds checks, the flow asks "Run them?". Unattended runs would stall. Options: auto-run detected checks when unattended, or fail closed to needs-human.
- Target: `hooks/register.tsx` (~374-395).
- Acceptance test: an unattended-mode test completes without a prompt under the chosen policy.
