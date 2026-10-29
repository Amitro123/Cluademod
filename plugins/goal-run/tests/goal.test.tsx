import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { runnerX, trackText } from '../hooks/art'
import { addSide, insertTask, mergeGoal, movePending, orderPlan, parseStartPrompt, planItems, poseOf, reminder, replan, stepTokens } from '../hooks/register'
import type { Goal } from '../types'
import { doneResult, factoryTakesGoal, parsePlanApprovedArgs, parsePlanOutcome, PLAN_APPROVED_FOR_FACTORY, PLAN_KEPT_FOR_FACTORY, planChangesForFactory, projectFrom } from '../hooks/texts'

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
  const asked: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 24, 9) })
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  const writes: string[] = []
  on('store.set', (_, e) => {
    writes.push(e.key)
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
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
    asked.push(q)
    const a = answers.shift()
    if (a === null || a === undefined) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [q]: a } } } as never
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE(steps.shift() ?? 0) } as never
  })
  // The followups mod's done tool, as it answers for an item it knows.
  on('tool.call', { tool: 'mcp__followups__done' }, (_, e) => ({ result: `Marked "${String((e as { id?: unknown }).id)}" done.` }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const steps: number[] = []
  return { sent, toasts, clock, saved, steps, asked, writes }
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
    const w = engine(on, { answers: ['Approve, run through'] })
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
    expect(w.sent.at(-1)).toMatch(/The plan is approved \(runs through\)/)
    expect(await texts(pane)).toMatch(/0\/3 tasks/)
    await pane.unmount()

    const bad = await $.tool.call({ tool: UPDATE, id: 't9', status: 'done' } as never)
    expect(String(bad.deny)).toMatch(/its ids are t1, t2, t3/)
  })

  test("while a goal is worked, the person's prompts carry where it stands", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    const r = await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } } as never)
    expect(r.context?.join('\n')).toMatch(/Session goal: Ship it\. 1\/2 tasks done \(50%\)/)
    expect(r.context?.join('\n')).toMatch(/\[pending\] t2 \(medium priority\): Two/)
    void w
  })
})

describe('the track fits the pane', () => {
  test('a narrow pane draws the track narrower, keeping its shape', async ($, on) => {
    engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    const sizeAt = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } } as never)
      const svg = (await ui.findAll({ type: 'Svg' } as never))[0] as { props?: { width?: number; height?: number } }
      await ui.unmount()
      return svg.props!
    }
    const wide = await sizeAt(80)
    const narrow = await sizeAt(30)
    expect(wide.width).toBe(360)
    expect(narrow.width).toBeLessThan(360)
    expect(narrow.width).toBeLessThanOrEqual(30 * 7)
    expect(Math.abs(narrow.height! / narrow.width! - wide.height! / wide.width!)).toBeLessThan(0.02)
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

  test('where the band has no text field (mobile), the question says to type /session-goal', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/repo', surface: 'mobile', isInteractive: true } as never)
    const phone = await $.ui.mount({ ...BAND, surface: 'mobile' } as never)
    expect(await phone.find({ key: 'goal' } as never)).toBeUndefined()
    expect(await texts(phone)).toMatch(/Type \/session-goal and your goal to set one/)
    await phone.unmount()
    const desk = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await desk.find({ key: 'goal' } as never)).toBeDefined()
    expect(await texts(desk)).not.toMatch(/Type \/session-goal/)
    await desk.unmount()
  })

  test('a newer goal set in another session of the project is not overwritten', async ($, on) => {
    const w = engine(on, { saved: { 'goal:/repo': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const theirs: Goal = { ...unfinished, text: 'Their goal', setAt: Date.UTC(2026, 9, 24, 8) }
    w.saved['goal:/repo'] = theirs
    // This session clears the older goal it holds: the other session's newer goal stays saved.
    await $.command.run({ command: 'session-goal', args: 'clear' } as never)
    expect((w.saved['goal:/repo'] as Goal).text).toBe('Their goal')
    // A goal this session sets afterwards is the newer one, and is saved.
    await $.command.run({ command: 'session-goal', args: 'My goal' } as never)
    expect((w.saved['goal:/repo'] as Goal).text).toBe('My goal')
  })

  test("once another session's newer goal wins, the person is told once that progress here isn't saved", async ($, on) => {
    const w = engine(on, { saved: { 'goal:/repo': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    w.saved['goal:/repo'] = { ...unfinished, text: 'Their goal', setAt: Date.UTC(2026, 9, 24, 8) }
    // Saved at each turn's end: the newer goal stays, and the person hears it once.
    for (let i = 0; i < 2; i++) {
      await step($, w, 1_000)
      await $.turn.complete({ answer: 'x', reason: 'answer', durationMs: 1, isAborted: false, turnId: `t${i}` } as never)
    }
    expect((w.saved['goal:/repo'] as Goal).text).toBe('Their goal')
    expect(w.toasts.filter(t => /newer goal was set in another session/.test(t))).toHaveLength(1)
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
    expect(text).toMatch(/\[in progress\] t1 \(medium priority\): a/)
    expect(text).toMatch(/\[done\] t2 \(medium priority\): b/)
    expect(text).toMatch(/Take the first pending task next/)
    expect(text).toContain(UPDATE)
  })
})

describe('work started from the followups to-do list', () => {
  // What followups' Start submits, under its own name.
  const START = [
    'Start this item from my to-do list:',
    '- id fu-1: Rotate the dev key (bug) — A real-looking key is committed [where: .env.example:3]',
    'Do the work. When an item is finished, call mcp__followups__done with its id (and a short note).',
  ].join('\n')
  const fromTodo = { text: START, wait: false, origin: { kind: 'plugin', name: 'followups' } } as never
  const fromPerson = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

  // An approved two-task goal with its first task done: 50%.
  async function halfway($: Engine, on: On) {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    return w
  }

  test("with the factory taking items over, a one-item Start is its run, not a side job; two items still are", async ($, on) => {
    // The goal is the person's own, planned before the factory was there to take it.
    let loaded = false
    on('command.list', () => ({ value: loaded ? [{ name: 'factory', description: 'f', source: 'plugin' }] : [] }) as never)
    await halfway($, on)
    loaded = true
    await $.prompt.submit(fromTodo)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).not.toMatch(/Add to your goal/)
    await band.unmount()
    const two = ['Start these 2 items from my to-do list, one after the other:', '- id fu-1: Rotate the dev key', '- id fu-2: Update the docs', 'Do the work.'].join('\n')
    await $.prompt.submit({ text: two, wait: false, origin: { kind: 'plugin', name: 'followups' } } as never)
    const again = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(again)).toMatch(/Add to your goal/)
    await again.unmount()
  })

  test('kept separate: no goal reminder beside it, and its tokens counted outside the goal', async ($, on) => {
    const w = await halfway($, on)
    const r = await $.prompt.submit(fromTodo)
    expect((r.context ?? []).join('\n')).not.toMatch(/Session goal/)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/Add to your goal\? "Rotate the dev key"/)
    expect(await texts(band)).toMatch(/The plan grows to 3 tasks: 50% → 33%/)
    await step($, w, 20_000)
    await band.press({ key: 'side-apart' })
    expect(await texts(band)).not.toMatch(/Add to your goal/)
    await band.unmount()

    // Still the side job's turn: outside. The person's own next prompt ends it.
    await step($, w, 5_000)
    const next = await $.prompt.submit(fromPerson('back to the goal'))
    expect((next.context ?? []).join('\n')).toMatch(/Session goal: Ship it/)
    await step($, w, 7_000)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(pane)
    expect(text).toMatch(/Outside the goal \(from the to-do list\) \| 25k tokens/)
    expect(text).toMatch(/1\/2 tasks/)
    expect(text).toMatch(/50%/)
    await pane.unmount()
  })

  test('added to the goal: a task in progress with the tokens so far, closed when the to-do item is', async ($, on) => {
    const w = await halfway($, on)
    await $.prompt.submit(fromTodo)
    await step($, w, 10_000)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'side-add' })
    await band.unmount()
    await step($, w, 4_000)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    let text = await texts(pane)
    expect(text).toMatch(/1\/3 tasks/)
    expect(text).toMatch(/33%/)
    expect(text).toMatch(/Rotate the dev key \| 14k tokens/)
    expect(text).not.toMatch(/Outside the goal/)

    await $.tool.call({ tool: 'mcp__followups__done', id: 'fu-1' } as never)
    text = await texts(pane)
    expect(text).toMatch(/2\/3 tasks/)
    expect(text).toMatch(/67%/)
    await pane.unmount()
  })

  test('with goal-run beneath followups, the PostToolUse event still closes the task (and twice is harmless)', async ($, on) => {
    on('classic.PostToolUse', () => ({}) as never)
    const w = await halfway($, on)
    await $.prompt.submit(fromTodo)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'side-add' })
    await band.unmount()
    await $.tool.call({ tool: UPDATE, id: 't2', status: 'done' } as never)
    // followups answered the tool above goal-run, so only the classic event reaches it.
    const post = { tool_name: 'mcp__followups__done', tool_input: { id: 'fu-1' }, tool_response: [{ type: 'text', text: doneResult('Rotate the dev key', '') }], tool_use_id: 'u1' }
    await $.classic.PostToolUse(post as never)
    await $.classic.PostToolUse(post as never)
    expect(w.toasts.filter(t => t === 'Goal reached: Ship it')).toHaveLength(1)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/3\/3 tasks/)
    await pane.unmount()
  })

  test('when the to-do item closes the last task, the done result says the goal is reached', async ($, on) => {
    const w = await halfway($, on)
    await $.prompt.submit(fromTodo)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'side-add' })
    await band.unmount()
    await $.tool.call({ tool: UPDATE, id: 't2', status: 'done' } as never)
    const r = await $.tool.call({ tool: 'mcp__followups__done', id: 'fu-1' } as never)
    expect((r.context ?? []).join('\n')).toMatch(/That closed the last task of the session goal "Ship it"\. The goal is reached\./)
    expect(w.toasts).toContain('Goal reached: Ship it')
  })

  test('an item followups closed before the answer joins the goal as done', async ($, on) => {
    await halfway($, on)
    await $.prompt.submit(fromTodo)
    await $.tool.call({ tool: 'mcp__followups__done', id: 'fu-1' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'side-add' })
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/2\/3 tasks/)
    await pane.unmount()
  })

  test('with a plan not yet approved, nothing is offered, but the work is still kept apart', async ($, on) => {
    const w = engine(on, { answers: [null] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.prompt.submit(fromTodo)
    await step($, w, 9_000)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).not.toMatch(/Add to your goal/)
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/Outside the goal \(from the to-do list\) \| 9k tokens/)
    await pane.unmount()
  })

  test("reads the items of followups' Start prompt, one or several", () => {
    expect(parseStartPrompt(START)).toEqual([{ id: 'fu-1', title: 'Rotate the dev key', isBug: true, detail: 'A real-looking key is committed', where: '.env.example:3' }])
    const many = ['Start these 2 items from my to-do list, one after the other:', '- id a: First', '- id b: Second — why it matters', 'Do the work.'].join('\n')
    expect(parseStartPrompt(many)).toEqual([{ id: 'a', title: 'First' }, { id: 'b', title: 'Second', detail: 'why it matters' }])
    expect(parseStartPrompt('just a prompt')).toEqual([])
  })

  test('adding splits the tokens so far across the new tasks and numbers them after the plan', () => {
    const g: Goal = { text: 'x', status: 'active', activeId: null, other: 0, outside: 9, tasks: [{ id: 't1', title: 'a', status: 'done', tokens: 1 }, { id: 't2', title: 'b', status: 'pending', tokens: 0 }] }
    const { goal: grown, taskIds } = addSide(g, { items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], tokens: 9, isAsking: true, taskIds: [], doneIds: ['b'], isLive: true }, 'ab12')
    expect(taskIds).toEqual(['t3-ab12', 't4-ab12'])
    expect(grown.tasks.slice(2).map(t => [t.status, t.tokens, t.followupId])).toEqual([['in_progress', 5, 'a'], ['done', 4, 'b']])
    expect(grown.activeId).toBe('t3-ab12')
    expect(grown.outside).toBe(0)
  })
})

describe('the order of the plan', () => {
  const P = (title: string, priority: 'high' | 'medium' | 'low', dependsOn: number[] = []) => ({ title, priority, dependsOn })

  test('highest priority first, ties in the order given', () => {
    const order = orderPlan([P('Polish the docs', 'low'), P('Fix the crash', 'high'), P('Add the flag', 'medium'), P('Fix the leak', 'high')])
    expect(order.map(t => t.title)).toEqual(['Fix the crash', 'Fix the leak', 'Add the flag', 'Polish the docs'])
    expect(order.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4'])
  })

  test('a dependency comes first even when it matters less, and the task says what it needs', () => {
    // Tests (high) can't come before the exporter they test (medium).
    const order = orderPlan([P('Write the exporter', 'medium'), P('Add tests', 'high', [1]), P('Update the changelog', 'low')])
    expect(order.map(t => t.title)).toEqual(['Write the exporter', 'Add tests', 'Update the changelog'])
    expect(order[1]!.needs).toEqual(['t1'])
    expect(order[0]!.needs).toBeUndefined()
  })

  test('a dependency cycle or a bad reference does not lose a task', () => {
    const order = orderPlan([P('A', 'low', [2]), P('B', 'high', [1]), P('C', 'medium', [9, 3])])
    expect(order.map(t => t.title).sort()).toEqual(['A', 'B', 'C'])
    expect(order.length).toBe(3)
  })

  test('plain titles still work, as medium priority', () => {
    expect(planItems(['One', { title: 'Two', priority: 'high', dependsOn: [1] }, { title: '  ' }])).toEqual([
      { title: 'One', priority: 'medium', dependsOn: [] },
      { title: 'Two', priority: 'high', dependsOn: [1] },
    ])
  })

  test("a step's tokens are the new ones: cache reads, the context already counted, are left out", () => {
    expect(stepTokens({ input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000 })).toBe(3_500)
  })

  test('↑ and ↓ move a task among the pending ones, never past one in progress or done', () => {
    const tasks = orderPlan([P('a', 'high'), P('b', 'high'), P('c', 'high'), P('d', 'high')])
    const g: Goal = { text: 'x', status: 'active', activeId: 't1', other: 0, tasks: tasks.map((t, i) => (i === 0 ? { ...t, status: 'in_progress' } : t)) }
    expect(movePending(g, 't4', -1).tasks.map(t => t.title)).toEqual(['a', 'b', 'd', 'c'])
    expect(movePending(g, 't2', -1).tasks.map(t => t.title)).toEqual(['a', 'b', 'c', 'd'])
    expect(movePending(g, 't4', 1).tasks.map(t => t.title)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('↑ carries the tasks a task needs along with it, ↓ the tasks that need it', () => {
    const t = (id: string, title: string, needs?: string[]) => ({ id, title, status: 'pending' as const, tokens: 0, ...(needs ? { needs } : {}) })
    const g: Goal = { text: 'x', status: 'active', activeId: null, other: 0, tasks: [t('t1', 'a'), t('t2', 'b'), t('t3', 'c', ['t2']), t('t4', 'd')] }
    const titles = (x: Goal) => x.tasks.map(k => k.title)
    expect(titles(movePending(g, 't3', -1))).toEqual(['b', 'c', 'a', 'd'])
    expect(titles(movePending(g, 't2', 1))).toEqual(['a', 'd', 'b', 'c'])
    // Through another task, too.
    const chain: Goal = { ...g, tasks: [...g.tasks.slice(0, 3), t('t4', 'd', ['t3'])] }
    expect(titles(movePending(chain, 't4', -1))).toEqual(['b', 'c', 'd', 'a'])
    // Nothing left to pass: the order stays.
    const top: Goal = { ...g, tasks: [t('t1', 'a'), t('t2', 'b', ['t1']), t('t3', 'c')] }
    expect(titles(movePending(top, 't2', -1))).toEqual(['a', 'b', 'c'])
  })

  test('the dialog shows the order with priorities and dependencies, and the pane lets the person reorder', async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship the export' } as never)
    const r = await $.tool.call({
      tool: PLAN,
      tasks: [{ title: 'Write the exporter', priority: 'medium' }, { title: 'Add tests', priority: 'high', dependsOn: [1] }, { title: 'Fix the crash', priority: 'high' }],
    } as never)
    expect(String(r.result)).toMatch(/t1 \(high priority\): Fix the crash/)
    expect(String(r.result)).toMatch(/t3 \(high priority\): Add tests, needs t2/)
    expect(w.asked[0]).toMatch(/1\. \[high\] Fix the crash\n2\. \[medium\] Write the exporter\n3\. \[high\] Add tests \(needs 2\)\nOrdered by priority, dependencies first\./)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    let text = await texts(pane)
    expect(text).toMatch(/▲ high \| Fix the crash.*■ med \| Write the exporter.*▲ high \| Add tests/)
    expect(text).toMatch(/needs 2/)
    // The person wants the exporter first.
    await pane.press({ key: 'up-t2' })
    text = await texts(pane)
    expect(text).toMatch(/Write the exporter.*Fix the crash.*Add tests/)
    await pane.unmount()
    const next = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } } as never)
    expect((next.context ?? []).join('\n')).toMatch(/t2 \(medium priority\): Write the exporter\n- \[pending\] t1 \(high priority\): Fix the crash/)
  })
})

describe('adding a task mid-goal', () => {
  const ADD = 'mcp__goal-run__add'
  // An approved plan: t1 high (done), t2 high, t3 medium, t4 low.
  async function underway($: Engine, on: On, answers: (string | null)[]) {
    const w = engine(on, { answers: ['Approve, run through', ...answers] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: [{ title: 'A', priority: 'high' }, { title: 'B', priority: 'high' }, { title: 'C', priority: 'medium' }, { title: 'D', priority: 'low' }] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    return w
  }
  const titles = async ($: Engine) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const t = await texts(ui)
    await ui.unmount()
    return t
  }

  test('goes in by priority among the pending tasks, after what it needs, once the person says add it', async ($, on) => {
    const w = await underway($, on, ['Add it'])
    const r = await $.tool.call({ tool: ADD, title: 'Rotate the key', priority: 'high' } as never)
    expect(w.asked.at(-1)).toMatch(/Add to the goal: \[high\] Rotate the key\. It goes in as #3, before "C"\. Progress 25% → 20%\./)
    expect(String(r.result)).toMatch(/^Added t5-[0-9a-z]{4} \(high priority\) as #3/)
    expect(await titles($)).toMatch(/A .*B .*Rotate the key .*C .*D/)
  })

  test('a task that needs a later one goes after it', async ($, on) => {
    await underway($, on, ['Add it'])
    await $.tool.call({ tool: ADD, title: 'Ship the docs', priority: 'high', needs: ['t3'] } as never)
    expect(await titles($)).toMatch(/C .*Ship the docs .*D/)
  })

  test('not now, or no answer, adds nothing', async ($, on) => {
    await underway($, on, ['Not now', null])
    expect(String((await $.tool.call({ tool: ADD, title: 'X', priority: 'low' } as never)).result)).toMatch(/chose not to add/)
    expect(String((await $.tool.call({ tool: ADD, title: 'Y', priority: 'low' } as never)).result)).toMatch(/hasn't answered/)
    expect(await titles($)).toMatch(/1\/4 tasks/)
  })

  test('insertTask leaves done and in-progress tasks where they are', () => {
    const g: Goal = { text: 'x', status: 'active', activeId: 't2', other: 0, tasks: [
      { id: 't1', title: 'a', status: 'done', tokens: 5, priority: 'low' },
      { id: 't2', title: 'b', status: 'in_progress', tokens: 3, priority: 'low' },
      { id: 't3', title: 'c', status: 'pending', tokens: 0, priority: 'low' },
    ] }
    const { goal: grown, at } = insertTask(g, { title: 'new', priority: 'high', needs: [] })
    expect(at).toBe(2)
    expect(grown.tasks.map(t => t.title)).toEqual(['a', 'b', 'new', 'c'])
  })

  test('a new plan mid-goal keeps the done tasks and their tokens', () => {
    const before: Goal = { text: 'x', status: 'active', activeId: 't2', other: 1, outside: 7, pace: 'ask', tasks: [
      { id: 't1', title: 'a', status: 'done', tokens: 40, priority: 'high' },
      { id: 't2', title: 'b', status: 'in_progress', tokens: 9, priority: 'high' },
    ] }
    const g = replan(before, 'x', orderPlan([{ title: 'b2', priority: 'high', dependsOn: [] }, { title: 'c', priority: 'low', dependsOn: [1] }]))
    expect(g.tasks.map(t => [t.id, t.title, t.status, t.tokens])).toEqual([['t1', 'a', 'done', 40], ['t2', 'b2', 'pending', 0], ['t3', 'c', 'pending', 0]])
    expect(g.tasks[2]!.needs).toEqual(['t2'])
    expect(g.other).toBe(10)
    expect(g.outside).toBe(7)
    expect(g.pace).toBe('ask')
  })

  test('a bug from the to-do list joins the goal as high priority', () => {
    const g: Goal = { text: 'x', status: 'active', activeId: null, other: 0, tasks: [] }
    const { goal: grown } = addSide(g, { items: [{ id: 'a', title: 'A', isBug: true }, { id: 'b', title: 'B' }], tokens: 0, isAsking: true, taskIds: [], doneIds: [], isLive: true })
    expect(grown.tasks.map(t => t.priority)).toEqual(['high', 'medium'])
  })
})

describe('after approval: run through, or ask between tasks', () => {
  async function approved($: Engine, on: On, choice: string, more: (string | null)[] = []) {
    const w = engine(on, { answers: [choice, ...more] })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('classic.Stop', () => ({}))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    const r = await $.tool.call({ tool: PLAN, tasks: [{ title: 'One', priority: 'high' }, { title: 'Two', priority: 'medium' }, { title: 'Three', priority: 'low' }] } as never)
    return { w, r }
  }
  const stop = { stop_hook_active: false, last_assistant_message: 'Did one.' } as never

  test('run through: a done task says go on, and a stop with tasks left is sent on once', async ($, on) => {
    const { r } = await approved($, on, 'Approve, run through')
    expect(String(r.result)).toMatch(/go straight on to the next pending one/)
    const done = await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    expect(String(done.result)).toMatch(/Go straight on to t2: Two\./)
    const first = await $.classic.Stop(stop)
    expect(first.block).toMatch(/2 tasks to do.*Go on with t2: Two\. If you are blocked or need their decision, say so plainly and stop\./)
    expect((await $.classic.Stop(stop)).block).toBeUndefined()
    // The person's next prompt allows one more nudge.
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as never)
    expect((await $.classic.Stop({ stop_hook_active: true, last_assistant_message: '' } as never)).block).toBeUndefined()
    expect((await $.classic.Stop(stop)).block).toMatch(/Go on with t2/)
  })

  test('ask between tasks: the person decides after each one, and no stop is sent on', async ($, on) => {
    const { w, r } = await approved($, on, 'Approve, ask between tasks', ['Continue', 'Stop here'])
    expect(String(r.result)).toMatch(/marking a task done asks them whether to go on/)
    const one = await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    expect(w.asked.at(-1)).toMatch(/"One" is done \(33%\)\. Go on to "Two"\?/)
    expect(String(one.result)).toMatch(/The person says go on: start t2: Two\./)
    const two = await $.tool.call({ tool: UPDATE, id: 't2', status: 'done' } as never)
    expect(String(two.result)).toMatch(/wants to stop here\. Don't start t3/)
    expect((await $.classic.Stop(stop)).block).toBeUndefined()
  })

  test('the pace can be switched in the pane, and the last task needs no question', async ($, on) => {
    const { w } = await approved($, on, 'Approve, ask between tasks')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'pace' })
    await pane.unmount()
    const asked = w.asked.length
    const r = await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    expect(String(r.result)).toMatch(/Go straight on to t2/)
    expect(w.asked.length).toBe(asked)
  })
})

describe('a plan from a factory run', () => {
  const tasks = [{ title: 'Token bucket core', priority: 'high' }, { title: 'Middleware with Retry-After', priority: 'high', dependsOn: [1] }]

  test('its dialog approves the build, and the main loop is told not to work the tasks', async ($, on) => {
    const w = engine(on, { answers: ['Approve, start building'] })
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('classic.Stop', () => ({}))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    expect(w.asked.at(-1)).toMatch(/The factory's spec for this goal\. Approve it, and the builder starts\?/)
    expect(String(r.result).startsWith(PLAN_APPROVED_FOR_FACTORY)).toBe(true)
    expect(parsePlanOutcome(String(r.result))).toEqual({ approved: true, goalTasks: [{ id: 't1', title: 'Token bucket core' }, { id: 't2', title: 'Middleware with Retry-After' }] })
    // No goal reminder on the person's prompts, no nudge at a stop, no question between tasks.
    const p = await $.prompt.submit({ text: 'how is it going?', origin: { kind: 'composer' } } as never)
    expect((p.context ?? []).join('\n')).not.toMatch(/Session goal/)
    const done = await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    expect(String(done.result)).toBe('t1 is done. 1/2 tasks done (50%).')
    expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'x' } as never)).block).toBeUndefined()
  })

  test('changes go back to the factory, not to a new plan from the main loop', async ($, on) => {
    engine(on, { answers: ['Split the middleware task'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    expect(parsePlanOutcome(String(r.result))).toEqual({ changes: 'Split the middleware task' })
    expect(parsePlanOutcome(planChangesForFactory(''))).toEqual({ changes: '' })
    expect(String(r.result)).toMatch(/spec-writer revises the spec; don't propose a plan yourself/)
  })

  test("the person's own goal stays: the factory's plan is refused, and asks in its own band", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship the CSV export' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['Write the exporter', 'Add tests'] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    expect(String(r.result)).toBe(PLAN_KEPT_FOR_FACTORY)
    expect(parsePlanOutcome(String(r.result))).toEqual({ kept: true })
    expect(w.asked).toHaveLength(1)
    const g = w.saved['goal:/repo'] as Goal
    expect(g.text).toBe('Ship the CSV export')
    expect(g.source).toBeUndefined()
    expect(g.tasks.map(t => t.status)).toEqual(['done', 'pending'])
  })

  test("a goal still being planned is the factory's to plan: its plan replaces it", async ($, on) => {
    const w = engine(on, { answers: ['Approve, start building'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Rate limiter' } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    expect(String(r.result).startsWith(PLAN_APPROVED_FOR_FACTORY)).toBe(true)
    expect((w.saved['goal:/repo'] as Goal).source).toBe('factory')
  })

  test("a regular plan's answers are not the factory's", async ($, on) => {
    engine(on, { answers: ['Approve, run through', 'Change it'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    const approved = await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    expect(String(approved.result)).toMatch(/^Approved\./)
    expect(parsePlanOutcome(String(approved.result))).toBeNull()
    const changed = await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    expect(String(changed.result)).toMatch(/^The person wants changes to the plan/)
    expect(parsePlanOutcome(String(changed.result))).toBeNull()
  })

  test("a factory plan starts fresh: a finished goal's done tasks aren't carried in", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through', 'Approve, start building'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One'] } as never)
    await $.tool.call({ tool: UPDATE, id: 't1', status: 'done' } as never)
    await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    const g = w.saved['goal:/repo'] as Goal
    expect(g.text).toBe('Rate limiter')
    expect(g.tasks.map(t => [t.id, t.title])).toEqual([['t1', 'Token bucket core'], ['t2', 'Middleware with Retry-After']])
  })

  test("approved later in the Goal pane, it's passed on with /factory plan-approved", async ($, on) => {
    const ran: string[] = []
    on('command.run', (_, e) => {
      ran.push(`${e.command} ${e.args ?? ''}`.trim())
      return { text: '' } as never
    })
    const w = engine(on, { answers: [null] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks } as never)
    expect(parsePlanOutcome(String(r.result))).toBeNull()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'approve' })
    expect(ran).toContain(`factory plan-approved ${JSON.stringify([{ id: 't1', title: 'Token bucket core' }, { id: 't2', title: 'Middleware with Retry-After' }])}`)
    expect(w.sent.some(t => /Start with the first pending task/.test(t))).toBe(false)
    await pane.unmount()
  })

  test("the factory is given goal-run's ids, in goal-run's order, on both paths", async ($, on) => {
    const ran: string[] = []
    on('command.run', (_, e) => {
      ran.push(String(e.args ?? ''))
      return { text: '' } as never
    })
    // The spec's order puts the low-priority docs first; goal-run puts the core first.
    const outOfOrder = [{ title: 'Write docs', priority: 'low' }, { title: 'Core', priority: 'high' }]
    const ids = [{ id: 't1', title: 'Core' }, { id: 't2', title: 'Write docs' }]
    engine(on, { answers: ['Approve, start building', null] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Docs', source: 'factory', tasks: outOfOrder } as never)
    expect(parsePlanOutcome(String(r.result))).toEqual({ approved: true, goalTasks: ids })
    await $.tool.call({ tool: PLAN, goal: 'Docs', source: 'factory', tasks: outOfOrder } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'approve' })
    await pane.unmount()
    expect(parsePlanApprovedArgs(ran.at(-1)!)).toEqual({ goalTasks: ids })
  })
})


describe('one goal per repository, whichever worktree the session is in', () => {
  const unfinished: Goal = { text: 'Ship it', status: 'active', tasks: [{ id: 't1', title: 'One', status: 'done', tokens: 10 }, { id: 't2', title: 'Two', status: 'pending', tokens: 0 }], activeId: null, other: 0 }

  test('the key is the main repository: its own checkout and a worktree agree', () => {
    expect(projectFrom('/repo', '.git')).toBe('/repo')
    expect(projectFrom('/repo/', '.git\n')).toBe('/repo')
    expect(projectFrom('/repo/.claude/worktrees/a', '/repo/.git')).toBe('/repo')
    expect(projectFrom('C:\\work\\api-wt', 'C:\\work\\api\\.git')).toBe('C:\\work\\api')
    expect(projectFrom('/scratch', '')).toBe('/scratch')
    // A session rooted in a subfolder: git answers relative to it.
    expect(projectFrom('/repo/sub', '../.git')).toBe('/repo')
    expect(projectFrom('/repo/a/b', '../../.git\n')).toBe('/repo')
    expect(projectFrom('C:\\repo\\sub', '..\\.git')).toBe('C:\\repo')
  })

  test("a goal saved from the main checkout is there in a worktree session", async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/main/.git\n', stderr: '' } }) as never)
    const w = engine(on, { saved: { 'goal:/main': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.command.run({ command: 'session-goal', args: '' } as never)
    expect(String(r.text)).toBe('Goal: Ship it (50%)')
    await $.tool.call({ tool: UPDATE, id: 't2', status: 'done' } as never)
    expect((w.saved['goal:/main'] as Goal).status).toBe('done')
  })

  test('a goal saved under the old per-folder key moves to the repository key', async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/main/.git\n', stderr: '' } }) as never)
    const w = engine(on, { saved: { 'goal:/repo': unfinished } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect((w.saved['goal:/main'] as Goal).text).toBe('Ship it')
  })
})

describe('a goal run through the factory', () => {
  test('Run as factory hands the goal to /factory, and the factory plan replaces it', async ($, on) => {
    const ran: string[] = []
    on('command.list', () => ({ value: [{ name: 'factory', description: 'f', source: 'plugin' }] }) as never)
    // The factory doesn't take goals over here: the person sends this one with the button.
    on('config.list', () => ({ value: [{ key: 'factory.takeOver', value: 'off' }] }) as never)
    on('command.run', (_, e) => {
      ran.push(`${e.command} ${e.args ?? ''}`.trim())
      return { text: '' } as never
    })
    const w = engine(on, { answers: ['Approve, run through', 'Approve, start building'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Rate limiter' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'factory' })
    expect(ran).toContain('factory Rate limiter')
    expect((w.saved['goal:/repo'] as Goal).source).toBe('factory')
    // No button once it's the factory's.
    expect(await pane.find({ key: 'factory' } as never)).toBeFalsy()
    await pane.unmount()
    const r = await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks: [{ title: 'Bucket', priority: 'high' }] } as never)
    expect(String(r.result).startsWith(PLAN_APPROVED_FOR_FACTORY)).toBe(true)
    expect((w.saved['goal:/repo'] as Goal).tasks.map(t => t.title)).toEqual(['Bucket'])
  })

  const withFactory = (on: On, takeOver?: string, said = 'Factory run started: Ship it. Branch factory/ship-it.') => {
    const ran: string[] = []
    on('command.list', () => ({ value: [{ name: 'factory', description: 'f', source: 'plugin' }] }) as never)
    on('config.list', () => ({ value: takeOver ? [{ key: 'factory.takeOver', value: takeOver }] : [] }) as never)
    on('command.run', (_, e) => {
      ran.push(`${e.command} ${e.args ?? ''}`.trim())
      return { text: e.command === 'factory' ? said : '' } as never
    })
    return ran
  }

  test("a factory that registers after this mod started is seen: a new goal's plan goes to it", async ($, on) => {
    let loaded = false
    on('command.list', () => ({ value: loaded ? [{ name: 'factory', description: 'f', source: 'plugin' }] : [] }) as never)
    on('config.list', () => ({ value: [] }) as never)
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    loaded = true
    const r = await $.tool.call({ tool: PLAN, goal: 'Ship it', tasks: ['One', 'Two'] } as never)
    expect(String(r.result)).toBe(factoryTakesGoal('Ship it'))
  })

  test('the Goal pane offers the factory once it registers, from the next turn', async ($, on) => {
    let loaded = false
    on('command.list', () => ({ value: loaded ? [{ name: 'factory', description: 'f', source: 'plugin' }] : [] }) as never)
    on('config.list', () => ({ value: [{ key: 'factory.takeOver', value: 'off' }] }) as never)
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    loaded = true
    await $.turn.start({ turnId: 't1', text: 'go on' } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await pane.find({ key: 'factory' } as never)).toBeTruthy()
    await pane.unmount()
  })

  test('a new goal Claude plans goes to the factory when it takes goals over: no plan, no dialog', async ($, on) => {
    const ran = withFactory(on)
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, goal: 'Ship it', tasks: ['One', 'Two'] } as never)
    expect(String(r.result)).toBe(factoryTakesGoal('Ship it'))
    expect(String(r.result)).toMatch(/Call mcp__factory__start now with feature "Ship it"/)
    expect(ran).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.saved['goal:/repo']).toBeUndefined()
  })

  test("with the factory's takeOver off, or a goal already under way, Claude's plan stays a plan", async ($, on) => {
    const ran = withFactory(on, 'off')
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: PLAN, goal: 'Ship it', tasks: ['One', 'Two'] } as never)
    expect(ran.filter(c => c.startsWith('factory'))).toEqual([])
    expect(w.asked).toHaveLength(1)
  })

  test('a goal under way: re-planning it stays here, even with the factory taking goals over', async ($, on) => {
    withFactory(on)
    const active: Goal = { text: 'Ship it', status: 'active', tasks: [{ id: 't1', title: 'One', status: 'done', tokens: 10 }, { id: 't2', title: 'Two', status: 'pending', tokens: 0 }], activeId: null, other: 0 }
    const w = engine(on, { saved: { 'goal:/repo': active }, answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const r = await $.tool.call({ tool: PLAN, tasks: ['One', 'Two', 'Three'] } as never)
    expect(String(r.result)).not.toMatch(/mcp__factory__start/)
    expect(w.asked).toHaveLength(1)
  })

  test('without the factory installed there is no button', async ($, on) => {
    engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One'] } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await pane.find({ key: 'factory' } as never)).toBeFalsy()
    await pane.unmount()
  })
})

describe("another session's changes to the goal reach this one", () => {
  const start = async ($: Engine, on: On) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    return w
  }
  const shownGoal = async ($: Engine) => String((await $.command.run({ command: 'session-goal', args: '' } as never)).text)

  test('a resumed session takes in progress made elsewhere', async ($, on) => {
    const w = await start($, on)
    const there = w.saved['goal:/repo'] as Goal
    w.saved['goal:/repo'] = { ...there, tasks: there.tasks.map(t => ({ ...t, status: 'done' })), status: 'done' }
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true, source: 'resume' } as never)
    expect(await shownGoal($)).toBe('Goal: Ship it (100%)')
  })

  test('a goal cleared elsewhere is gone here at the next prompt', async ($, on) => {
    const w = await start($, on)
    w.saved['goal:/repo'] = null
    await $.turn.start({ turnId: 't9', text: 'next' } as never)
    expect(await shownGoal($)).toMatch(/^No goal yet/)
  })

  test('a newer goal set elsewhere replaces this one at the next prompt', async ($, on) => {
    const w = await start($, on)
    const there = w.saved['goal:/repo'] as Goal
    w.saved['goal:/repo'] = { ...there, text: 'Write the docs', setAt: (there.setAt ?? 0) + 1000 }
    await $.turn.start({ turnId: 't9', text: 'next' } as never)
    expect(await shownGoal($)).toMatch(/^Goal: Write the docs/)
  })
})

describe('tokens are saved once a turn, not at every step', () => {
  test("steps (a sub-agent's too) count in memory; the main loop's turn end saves them once", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'in_progress' } as never)
    const before = w.writes.length
    await step($, w, 1000)
    await step($, w, 2000, 'a1')
    await step($, w, 3000)
    expect(w.writes.length).toBe(before)
    await $.turn.complete({ answer: 'x', agentId: 'a1', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
    expect(w.writes.length).toBe(before)
    await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
    expect(w.writes.length).toBe(before + 1)
    expect((w.saved['goal:/repo'] as Goal).tasks[0]!.tokens).toBe(6000)
    await $.turn.complete({ answer: 'again', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
    expect(w.writes.length).toBe(before + 1)
  })

  test('the session ending saves what the last steps counted', async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One'] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'in_progress' } as never)
    await step($, w, 500)
    await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as never)
    expect((w.saved['goal:/repo'] as Goal).tasks[0]!.tokens).toBe(500)
  })
})

describe('two sessions on the same goal keep both sides\' progress', () => {
  const task = (id: string, status: 'pending' | 'in_progress' | 'done', tokens: number) => ({ id, title: id, status, tokens })
  const base: Goal = { text: 'Ship it', status: 'active', setAt: 5, tasks: [task('t1', 'pending', 0), task('t2', 'pending', 0), task('t3', 'pending', 0)], activeId: null, other: 100 }

  test('each side changed a different task: both changes stay; tokens add both sides\' growth', () => {
    const mine: Goal = { ...base, tasks: [task('t1', 'done', 300), task('t2', 'pending', 0), task('t3', 'pending', 0)], other: 150 }
    const theirs: Goal = { ...base, tasks: [task('t1', 'pending', 0), task('t2', 'in_progress', 200), task('t3', 'pending', 0)], activeId: 't2', other: 120 }
    const m = mergeGoal(base, mine, theirs)
    expect(m.tasks.map(t => [t.id, t.status, t.tokens])).toEqual([['t1', 'done', 300], ['t2', 'in_progress', 200], ['t3', 'pending', 0]])
    expect(m.activeId).toBe('t2')
    expect(m.other).toBe(170)
  })

  test('both changed the same task: this side wins; every task done closes the goal; added tasks are kept', () => {
    const mine: Goal = { ...base, tasks: [task('t1', 'done', 10), task('t2', 'done', 0), task('t3', 'done', 0)] }
    const theirs: Goal = { ...base, tasks: [task('t1', 'in_progress', 5), task('t2', 'pending', 0), task('t3', 'pending', 0), task('t4', 'pending', 0)] }
    const m = mergeGoal(base, mine, theirs)
    expect(m.tasks.map(t => [t.id, t.status, t.tokens])).toEqual([['t1', 'done', 15], ['t2', 'done', 0], ['t3', 'done', 0], ['t4', 'pending', 0]])
    expect(m.status).toBe('active')
    expect(mergeGoal(base, mine, { ...theirs, tasks: theirs.tasks.slice(0, 3) }).status).toBe('done')
  })

  test('in a session: another session marked t2 done meanwhile; marking t1 here keeps both', async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two', 'Three'] } as never)
    const stored = w.saved['goal:/repo'] as Goal
    w.saved['goal:/repo'] = { ...stored, tasks: stored.tasks.map(t => (t.id === 't2' ? { ...t, status: 'done', tokens: 900 } : t)) }
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'done' } as never)
    const after = w.saved['goal:/repo'] as Goal
    expect(after.tasks.map(t => [t.id, t.status])).toEqual([['t1', 'done'], ['t2', 'done'], ['t3', 'pending']])
    expect(after.tasks[1]!.tokens).toBe(900)
  })

  test("a new prompt takes in the other session's change without losing tokens counted here and not saved yet", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'in_progress' } as never)
    await step($, w, 1000)
    const stored = w.saved['goal:/repo'] as Goal
    w.saved['goal:/repo'] = { ...stored, tasks: stored.tasks.map(t => (t.id === 't2' ? { ...t, status: 'done', tokens: 700 } : t)) }
    await $.turn.start({ text: 'go on', turnId: 'n1' } as never)
    await $.turn.complete({ answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId: 'n1' } as never)
    const after = w.saved['goal:/repo'] as Goal
    expect(after.tasks.map(t => [t.id, t.status, t.tokens])).toEqual([['t1', 'in_progress', 1000], ['t2', 'done', 700]])
  })
})

describe('a plan with a blank task', () => {
  test("the tasks after it keep depending on the ones they named", () => {
    const items = planItems([{ title: 'A' }, { title: '  ' }, { title: 'C', dependsOn: [1] }, { title: 'D', dependsOn: [3, 2] }])
    expect(items.map(i => [i.title, i.dependsOn])).toEqual([['A', []], ['C', [1]], ['D', [2]]])
  })
})

describe('the goal-reached toast', () => {
  test('shows once, when the last task is done; later updates of the done goal stay quiet', async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One'] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'done' } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't1', status: 'done' } as never)
    expect(w.toasts.filter(t => /^Goal reached/.test(t))).toHaveLength(1)
  })
})

describe('a re-plan and concurrent adds across sessions', () => {
  test("a re-plan here while another session marks the old t2 done: the new plan's t2 stays pending", async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through', 'Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two', 'Three'] } as never)
    const old = w.saved['goal:/repo'] as Goal
    // The other session marks the old plan's t2 done; this one re-plans meanwhile.
    w.saved['goal:/repo'] = { ...old, tasks: old.tasks.map(t => (t.id === 't2' ? { ...t, status: 'done', tokens: 400 } : t)) }
    await w.clock.advance(1_000)
    await $.tool.call({ tool: PLAN, tasks: ['Alpha', 'Beta'] } as never)
    const now = w.saved['goal:/repo'] as Goal
    expect(now.tasks.map(t => [t.id, t.title, t.status])).toEqual([['t1', 'Alpha', 'pending'], ['t2', 'Beta', 'pending']])
    expect((now.planAt ?? 0) > (old.planAt ?? 0)).toBe(true)
  })

  test('the older plan does not merge into the newer one: the session holding it is told once', async ($, on) => {
    const w = engine(on, { answers: ['Approve, run through'] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'session-goal', args: 'Ship it' } as never)
    await $.tool.call({ tool: PLAN, tasks: ['One', 'Two'] } as never)
    const mine = w.saved['goal:/repo'] as Goal
    w.saved['goal:/repo'] = { ...mine, planAt: (mine.planAt ?? 0) + 5_000, tasks: [{ id: 't1', title: 'Other plan', status: 'pending', tokens: 0 }] }
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't2', status: 'done' } as never)
    expect((w.saved['goal:/repo'] as Goal).tasks.map(t => t.title)).toEqual(['Other plan'])
    expect(w.toasts.filter(t => /re-planned in another session/.test(t))).toHaveLength(1)
  })

  test('two sessions each adding a task: both tasks are kept', () => {
    const g: Goal = { text: 'x', status: 'active', setAt: 1, planAt: 1, activeId: null, other: 0, tasks: [{ id: 't1', title: 'A', status: 'pending', tokens: 0 }] }
    const a = insertTask(g, { title: 'From A', priority: 'medium', needs: [] }, 'aaaa').goal
    const b = insertTask(g, { title: 'From B', priority: 'medium', needs: [] }, 'bbbb').goal
    const m = mergeGoal(g, a, b)
    expect(m.tasks.map(t => [t.id, t.title])).toEqual([['t1', 'A'], ['t2-aaaa', 'From A'], ['t2-bbbb', 'From B']])
  })
})
