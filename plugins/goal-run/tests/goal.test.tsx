import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { runnerX, trackText } from '../hooks/art'
import { poseOf, reminder } from '../hooks/register'
import type { Goal } from '../types'

const PLAN = 'mcp__goal-run__plan'
const UPDATE = 'mcp__goal-run__update'

const BAND = {
  plugin: 'goal-run',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

const PANE = {
  plugin: 'goal-run',
  component: 'Pane',
  requestId: 'goal-run',
  props: { title: 'Goal', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const USAGE = (n: number) => ({ model: 'm', input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

// The engine beneath: clock, store, the side calls, prompts the mod submits, and the plan dialog's answers.
function engine(on: On, { saved = {} as Record<string, unknown>, answers = [] as (string | null)[] } = {}) {
  const sent: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 24, 9) })
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__goal-run__${e.name}` } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined } as never
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!.question
    const a = answers.shift()
    if (a === null || a === undefined) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [q]: a } } } as never
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE(steps.shift() ?? 0) } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const steps: number[] = []
  return { sent, toasts, clock, saved, steps }
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')

async function step($: Engine, w: { steps: number[] }, tokens: number, agentId?: string) {
  w.steps.push(tokens)
  const s = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of s) { /* drain */ }
  await s.result
}

describe('from the question to the finish line', () => {
  test('ask, plan, approve, run the tasks with their tokens, reach the goal', async ($, on) => {
    const w = engine(on, { answers: ['Approve'] })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)

    // The session opens with the question; the person types a goal.
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await texts(band)).toMatch(/Is there a goal you want to work on this session\?/)
    // Typing into the band's field and pressing Enter (desktop has Input; the cast keeps that).
    await (band as unknown as { input: (a: { key: string; text: string }) => Promise<unknown> }).input({ key: 'goal', text: 'Ship the CSV export' })
    expect(await texts(band)).not.toMatch(/Is there a goal/)
    await band.unmount()
    expect(w.sent[0]).toMatch(/My goal for this session: Ship the CSV export/)
    expect(w.sent[0]).toContain(PLAN)

    // Planning costs tokens too; they count as "other".
    await step($, w, 3_000)
    const plan = await $.tool.call({ tool: PLAN, goal: 'Ship the CSV export', tasks: ['Write the exporter', 'Add tests'] } as never)
    expect(String(plan.result)).toMatch(/^Approved/)
    expect(String(plan.result)).toContain(UPDATE)

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    let text = await texts(pane)
    expect(text).toMatch(/Ship the CSV export/)
    expect(text).toMatch(/0%/)
    expect(text).toMatch(/0\/2 tasks/)
    expect(text).toMatch(/Planning and between tasks \| 3k tokens/)

    // Work on t1: its requests (a sub-agent's included) are its tokens.
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'in_progress' } as never)
    await step($, w, 40_000)
    await step($, w, 5_000, 'worker-1')
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    text = await texts(pane)
    expect(text).toMatch(/50%/)
    expect(text).toMatch(/Write the exporter \| 45k tokens/)

    await $.tool.call({ tool: UPDATE, id: 't2', status: 'in_progress' } as never)
    await step($, w, 12_000)
    const last = await $.tool.call({ tool: UPDATE, id: 't2', status: 'done' } as never)
    expect(String(last.result)).toMatch(/2\/2 tasks done \(100%\)\. The goal is reached\./)
    text = await texts(pane)
    expect(text).toMatch(/100%/)
    expect(text).toMatch(/Goal reached!/)
    expect(text).toMatch(/Add tests \| 12k tokens/)
    expect(text).toMatch(/60k tokens/)
    expect(w.toasts).toContain('Goal reached: Ship the CSV export')
    await pane.unmount()
    // Kept per project, for the next session.
    expect((w.saved['goal:/repo'] as Goal).status).toBe('done')
  })

  test('the person asks for changes, or leaves the dialog: nothing starts until approved', async ($, on) => {
    const w = engine(on, { answers: ['Split the tests into unit and e2e', null] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship the CSV export' } as never)

    const changed = await $.tool.call({ tool: PLAN, tasks: ['Write the exporter', 'Add tests'] } as never)
    expect(String(changed.result)).toMatch(/wants changes: Split the tests into unit and e2e/)
    const early = await $.tool.call({ tool: UPDATE, id: 't1', status: 'in_progress' } as never)
    expect(String(early.deny)).toMatch(/no approved plan/)

    const waiting = await $.tool.call({ tool: PLAN, tasks: ['Write the exporter', 'Unit tests', 'E2E tests'] } as never)
    expect(String(waiting.result)).toMatch(/waits for approval in the Goal pane/)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/Proposed plan: approve it to start/)
    await pane.press({ key: 'approve' })
    expect(await texts(pane)).not.toMatch(/Proposed plan/)
    expect(w.sent.at(-1)).toMatch(/The plan is approved/)
    expect(await texts(pane)).toMatch(/0\/3 tasks/)
    await pane.unmount()

    const bad = await $.tool.call({ tool: UPDATE, id: 't9', status: 'done' } as never)
    expect(String(bad.deny)).toMatch(/its ids are t1, t2, t3/)
  })

  test("while a goal is worked, the person's prompts carry where it stands", async ($, on) => {
    const w = engine(on, { answers: ['Approve'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    const r = await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } } as never)
    expect(r.context?.join('\n')).toMatch(/Session goal: Ship it\. 1\/2 tasks done \(50%\)/)
    expect(r.context?.join('\n')).toMatch(/\[pending\] t2: Two/)
    void w
  })
})

describe('a new session', () => {
  const unfinished: Goal = { text: 'Ship it', status: 'active', tasks: [{ id: 't1', title: 'One', status: 'done', tokens: 10 }, { id: 't2', title: 'Two', status: 'pending', tokens: 0 }], activeId: null, other: 0 }

  test('offers to continue an unfinished goal, or to start a new one', async ($, on) => {
    engine(on, { saved: { 'goal:/repo': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/Keep going on your goal\? Ship it \(50%\)/)
    await band.press({ key: 'new-goal' })
    expect(await texts(band)).toMatch(/Is there a goal you want to work on/)
    await band.press({ key: 'no-goal' })
    expect(await texts(band)).not.toMatch(/goal/)
    await band.unmount()
  })

  test('/goal clear forgets the goal', async ($, on) => {
    const w = engine(on, { saved: { 'goal:/repo': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'clear' } as never)
    expect(w.saved['goal:/repo']).toBeNull()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/No goal yet/)
    await pane.unmount()
  })
})

describe('the runner', () => {
  const g = (status: Goal['status'], inProgress: boolean): Goal => ({
    text: 'x', status, activeId: null, other: 0,
    tasks: [{ id: 't1', title: 'a', status: inProgress ? 'in_progress' : 'pending', tokens: 0 }],
  })

  test('runs while a task is in progress, stands otherwise, cheers at the goal', () => {
    expect(poseOf(g('active', true))).toBe('run')
    expect(poseOf(g('active', false))).toBe('stand')
    expect(poseOf(g('proposed', false))).toBe('stand')
    expect(poseOf(g('done', false))).toBe('cheer')
    expect(poseOf(null)).toBe('stand')
  })

  test('moves along the track with the progress', () => {
    expect(runnerX(0)).toBeLessThan(runnerX(0.5))
    expect(runnerX(0.5)).toBeLessThan(runnerX(1))
    expect(runnerX(2)).toBe(runnerX(1))
    expect(trackText(0, 'stand', 0, 30).startsWith(' (•_•)')).toBe(true)
    expect(trackText(1, 'cheer', 0, 30)).toMatch(/━\\\(\^o\^\)\/ ⚑$/)
  })

  test("the prompt reminder names every task's state and the update tool", () => {
    const text = reminder({ ...g('active', true), tasks: [{ id: 't1', title: 'a', status: 'in_progress', tokens: 0 }, { id: 't2', title: 'b', status: 'done', tokens: 0 }] })
    expect(text).toMatch(/\[in progress\] t1: a/)
    expect(text).toMatch(/\[done\] t2: b/)
    expect(text).toContain(UPDATE)
  })
})
