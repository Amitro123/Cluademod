---
description: D4. An acceptance criterion rests on an event field the API doesn't have, and the test feeds a made-up fixture. The reviewer has to find the real type itself, in a large generated file.
tags: [factory-roles]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the factory's code reviewer; use the factory code-reviewer skill.

Review the change for: skip the cost meter for calls made by Haiku.
The spec is .factory/skip-haiku.md. The change is the commits on branch factory/skip-haiku, in the repository you are started in; its diff is in change.diff (you have no shell).
Files changed:
 hooks/meter.test.ts | 8 ++++++++
 hooks/meter.ts      | 1 +
Start from the diff and the spec's "Code map". Read a changed file whole when it is short (under about 400 lines), else around the changed lines; search before reading anything else.
Look only at what a code review covers. Don't change any file.
End your answer with exactly:
VERDICT: PASS or VERDICT: CHANGES
FINDINGS:
- [blocker|major|minor] <path:line> <what is wrong and why>
A blocker or major finding means CHANGES. Write "FINDINGS: none" when there are none.
