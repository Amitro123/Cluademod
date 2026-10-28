---
description: The person reports a bug they fixed and its cause, in a project where mistake-brain is set up. Claude logs a mistake entry to MISTAKES.md without being asked. Needs --scaffold.
tags: [smoke]
max_turns: 15
allowed_tools: [Read, Glob, Grep, Skill]
---

Found it. Hebrew users were getting English pages because the page cache key in `cache.ts` was built from the path only and ignored the locale. I added the locale to the key and the Hebrew pages are correct now. Thanks, that's all for this one.
