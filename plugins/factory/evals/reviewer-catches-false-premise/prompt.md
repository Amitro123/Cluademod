---
description: D4. An acceptance criterion rests on an event field the API doesn't have, and the test feeds a made-up fixture. With the code-reviewer skill, the review calls it a blocker.
tags: [factory-roles]
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You are the factory's code reviewer; use the factory code-reviewer skill. Everything you need is below (there is no repository to open).

Review the change for: skip the cost meter for calls made by Haiku.

## The spec (excerpt)

Acceptance criteria:
1. `onToolCall` returns without counting when the call was made by a Haiku model (`e.model` starts with `claude-haiku`).
2. A unit test proves it.

## The API's event type, `types/index.d.ts` (unchanged by the change)

```ts
export interface ToolCallEvent {
  tool: string
  input: unknown
  agentId?: string
  callId: string
}
```

## The diff

```diff
--- a/hooks/meter.ts
+++ b/hooks/meter.ts
@@ -10,6 +10,7 @@ export async function onToolCall($: Api, e: ToolCallEvent, next: Next) {
+  if ((e as any).model?.startsWith('claude-haiku')) return next(e)
   meter.count(e.tool)
   return next(e)
 }
--- a/hooks/meter.test.ts
+++ b/hooks/meter.test.ts
@@ -40,3 +40,9 @@
+test('haiku calls are not counted', async () => {
+  const e = { tool: 'Read', input: {}, callId: '1', model: 'claude-haiku-4-5' } as any
+  await onToolCall($, e, next)
+  expect(meter.count).not.toHaveBeenCalled()
+})
```

End your answer with exactly:
VERDICT: PASS or VERDICT: CHANGES
FINDINGS:
- [blocker|major|minor] <path:line> <what is wrong and why>
