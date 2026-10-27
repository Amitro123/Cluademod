---
name: builder
description: "How the factory's builder implements a spec on its branch: read first, small steps, tests for each acceptance criterion, commit. Loaded by the factory's builder agent only; not for the main conversation."
---

# Building to the factory's spec

Your prompt gives the spec file, the branch and worktree, the tasks, and on a later round what to fix.
The prompt wins over anything here.

## First round

1. Read the spec whole, then the code it names. Follow the conventions you find there and the
   project's rules (CLAUDE.md, `.claude/rules/`).
2. Work task by task, in the order the dependencies allow. For each one:
   - change only what the task needs; no refactors, renames or formatting beyond it;
   - write or extend the tests that prove its acceptance criteria;
   - run those tests (and the project's checks you can find) before moving on.
3. When a spec detail is wrong or impossible, do the closest thing that meets its acceptance criteria
   and say so in your summary. Don't stop to ask: nobody answers mid-build.

## Later rounds

- You built this change already: fix exactly what the round lists (review findings, failing checks,
  the person's words). Blocker and major findings always; a minor one when it's cheap.
- A finding you judge wrong: leave the code, and say why in your summary, citing the code.
- Don't rewrite what already passed review.

## Before you finish

- No secrets, credentials or large generated files in the change.
- The project's tests pass in the worktree, or your summary says which fail and why.
- Commit to the current branch with a message that says what changed.
- End with the two-line summary your prompt asks for: what changed, and anything the reviewers
  should look at first.
