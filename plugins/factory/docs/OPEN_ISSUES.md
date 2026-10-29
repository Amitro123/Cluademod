# Factory plugin: open issues

Source: a post-hoc review of a pull request this factory built (a fix to a model-router mod in a
private repository). The review found defects D1-D6 that the run did not catch. This file tracks
what the factory now does about each, and what is still open.

## Status of D1-D6

| ID | Defect | Status | Where |
|---|---|---|---|
| D1 | A stale python test went unnoticed: the python suites never ran, because check detection only looked for config files at the repository root | FIXED | `hooks/checks.ts` detects checks generically (root, one level down, touched folders, `.factory/checks.json`, allowlisted commands in the spec's criteria). With none run, an APPROVE becomes an escalation (`onApprover`) |
| D2 | A `SKILL.md` grew past a size cap that a repository test enforces; same cause as D1 | FIXED | Same as D1 |
| D3 | The spec left an open question; the builder guessed | MITIGATED | The builder reports how it settled each open question (`buildPrompt`); the approver escalates one settled by guessing (`approvePrompt`, approver skill). Not enforced in code: a model reads it |
| D4 | An acceptance criterion rested on an input the API doesn't have; the builder wrote code and a synthetic test to match | MITIGATED | Reviewers check every field, input or type the change or a criterion relies on against its real definition; a false premise is a blocker (`reviewPrompt`, code-reviewer skill) |
| D5 | The spec scoped a fix to one copy of the code; sibling copies stayed on the old logic | MITIGATED | The spec's Code map lists every copy of the code the change touches, each in or out of scope (`specPrompt`, spec-writer skill) |
| D6 | Scope creep was invisible to an approver that never saw the diff | MITIGATED | The approver gets the files the change touched and escalates what the spec doesn't name (`approvePrompt`) |

"Mitigated" means the agents are told to catch it and the factory gives them what they need; a
model can still miss it. Only D1 and D2 are enforced in code.

How often it is still missed is measured by the evals in `evals/` (tag `factory-roles`, run with
`claude plugin eval . --tag factory-roles --scaffold --allow-tools Write`). With the role's skill,
all runs so far, against 3 runs without it:

| Case | With the skill | Without |
|---|---|---|
| D4: reviewer calls a criterion on a missing field a blocker (`reviewer-catches-false-premise`) | 22/23 | 0/3 |
| D5: spec's Code map names the second copy, in or out of scope (`spec-lists-every-copy`) | 13/14, then 12/12 once the spec-writer searches the whole repository by the expression (the miss searched only `src/`, and only `.ts` files) | 0/3 |
| D5, reviewer's side: the spec missed a copy and the builder fixed one; the review finds the other (`reviewer-catches-missed-copy`) | 8/8 since the code reviewer looks for copies left on the old logic; 0/8 before | 0/8 |

## Answered

- **Which model each role really ran on (g).** Each role's entry in the run record
  (`.factory/<slug>.record/`) starts with the model it asked for and the models its steps ran on.
- **Unattended runs at "Run them?" (h).** Fails closed: a question no one answers (or a `-p` run,
  where there is no one to ask) leaves the run waiting at needs-human, and Retry asks again. Set
  the `checks` and `setup` options for runs nobody watches: those commands aren't asked about.
- **A program that isn't installed.** A detected check whose program can't start here (maven,
  gradle, dotnet...) is recorded as not installed and skipped, not failed: the builder isn't sent
  back to fix it, and the approver is told it didn't run. Only a program that can't be started
  counts: an exit code 127 from one that started (a script whose inner command is missing) is a
  failure.

## Still open

- **Enforce, not ask, for D3-D6.** A checker in code, e.g. the spec's open questions parsed and
  each one required in the builder's summary, would close D3 for good.
- **Two tests fail on Windows only** ("the worktree folder is kept out of git through the exclude
  file", "every step's words go to the run's record"). They pass on Linux and macOS; likely path
  separators in the worktree, exclude and record paths.
