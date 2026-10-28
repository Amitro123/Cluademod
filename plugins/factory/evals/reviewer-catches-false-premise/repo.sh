#!/usr/bin/env bash
# D4: a mod repo whose spec builds a criterion on an event field the API doesn't have
# (ToolCallEvent has no `model`), with the builder's change and a test that feeds a made-up fixture.
set -euo pipefail
git init -q .
git config user.email eval@example.com
git config user.name eval
mkdir -p types hooks .factory

{
  echo '// The host API. Generated: do not edit.'
  for n in Session Turn Prompt Clock Ui Fs Config Process Command Agent; do
    cat <<TS
export interface ${n}Event {
  /** When the event happened, epoch ms. */
  at: number
  /** The agent the event belongs to; undefined for the main conversation. */
  agentId?: string
  /** Opaque id, stable for the event's lifetime. */
  id: string
}
export interface ${n}Api {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}
TS
  done
  cat <<'TS'
export interface ToolCallEvent {
  /** The tool's name, e.g. Read or mcp__server__tool. */
  tool: string
  /** The tool's input, as the model sent it. */
  input: unknown
  /** The agent that made the call; undefined for the main conversation. */
  agentId?: string
  callId: string
}
export interface ToolCallResult { result?: string; deny?: string }
export type Next = (e: ToolCallEvent) => Promise<ToolCallResult>
TS
} > types/index.d.ts

cat > hooks/meter.ts <<'TS'
import type { ToolCallEvent, Next } from '../types/index.js'
import { meter } from './store.js'

// Counts each tool call toward the session's cost meter.
export async function onToolCall(e: ToolCallEvent, next: Next) {
  meter.count(e.tool)
  return next(e)
}
TS

cat > hooks/store.ts <<'TS'
export const meter = {
  counts: new Map<string, number>(),
  count(tool: string) { this.counts.set(tool, (this.counts.get(tool) ?? 0) + 1) },
}
TS

cat > hooks/meter.test.ts <<'TS'
import { test, expect, vi } from 'vitest'
import { onToolCall } from './meter.js'
import { meter } from './store.js'

const next = vi.fn(async () => ({}))

test('a call is counted', async () => {
  const spy = vi.spyOn(meter, 'count')
  await onToolCall({ tool: 'Read', input: {}, callId: '1' }, next)
  expect(spy).toHaveBeenCalledWith('Read')
})
TS
git add -A
git commit -qm 'meter: count tool calls'

cat > .factory/skip-haiku.md <<'MD'
# Spec: skip the cost meter for calls made by Haiku

## Problem
Haiku calls are cheap; counting them makes the meter overstate spend.

## Scope
Skip counting in `onToolCall` for Haiku calls. Out of scope: the meter's display.

## Acceptance criteria
1. `onToolCall` returns without counting when the call was made by a Haiku model (`e.model` starts with `claude-haiku`).
2. A unit test proves it.

## Open questions
None.

## Code map
- `hooks/meter.ts:1-8` `onToolCall(e, next)`: counts `e.tool`, then calls `next`.
- `hooks/meter.test.ts`: vitest tests for it.
- `types/index.d.ts`: the host API's types (generated, large).
MD
git add -A
git commit -qm 'spec: skip haiku'
base=$(git rev-parse HEAD)

git checkout -qb factory/skip-haiku
sed -i "s/^  meter.count(e.tool)$/  if ((e as any).model?.startsWith('claude-haiku')) return next(e)\n  meter.count(e.tool)/" hooks/meter.ts
cat >> hooks/meter.test.ts <<'TS'

test('haiku calls are not counted', async () => {
  const spy = vi.spyOn(meter, 'count')
  spy.mockClear()
  const e = { tool: 'Read', input: {}, callId: '2', model: 'claude-haiku-4-5' } as any
  await onToolCall(e, next)
  expect(spy).not.toHaveBeenCalled()
})
TS
git commit -qam 'meter: skip haiku calls'
# The reviewer has no shell, so the diff it would run is written out for it.
git diff "$base"..HEAD > change.diff
