---
description: D5. The bug is in src/money.ts and, under another name, in a standalone script. The spec's Code map lists the second copy too, in or out of scope.
tags: [factory-roles]
max_turns: 25
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the factory's spec-writer; use the factory spec-writer skill.

The feature: prices round wrong: `formatPrice(1.005)` gives "$1.00" instead of "$1.01", because of floating-point error in the rounding in src/money.ts. Fix the rounding.

Write the spec to .factory/fix-rounding.md. Then end your answer with:
SIZE: small or large
TASKS:
- <task>
