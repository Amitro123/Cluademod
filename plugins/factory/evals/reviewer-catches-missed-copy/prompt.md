---
description: D5 from the reviewer's side. The spec missed a copy of the rounding in a standalone script and the builder fixed only src/money.ts; the reviewer finds the copy the diff doesn't show.
tags: [factory-roles]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the factory's code reviewer; use the factory code-reviewer skill.

Review the change for: prices round wrong: formatPrice(1.005) gives "$1.00" instead of "$1.01". Fix the rounding.
The spec is .factory/fix-rounding.md. The change is the commits on branch factory/fix-rounding, in the repository you are started in; its diff is in change.diff (you have no shell).
Files changed:
 src/money.ts       | 2 +-
 test/money.test.ts | 4 ++++
Start from the diff and the spec's "Code map". Read a changed file whole when it is short (under about 400 lines), else around the changed lines; search before reading anything else.
Look only at what a code review covers. Don't change any file.
End your answer with exactly:
VERDICT: PASS or VERDICT: CHANGES
FINDINGS:
- [blocker|major|minor] <path:line> <what is wrong and why>
A blocker or major finding means CHANGES. Write "FINDINGS: none" when there are none.
