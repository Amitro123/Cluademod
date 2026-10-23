import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'task-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const PANE = {
  plugin: 'task-hud',
  component: 'Pane',
  requestId: 'task-hud',
  props: { title: 'Sub-agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine beneath the plugin: a clock, the side calls, and every tool answering.
function engine(on: On, broken = false) {
  ticks = 0
  on('state.set', (_, e, next) => {
    if (broken) throw new Error('boom')
    if ((e as { key?: string }).key === 'tick') ticks++
    return next(e)
  })
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 12) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => {
    if (broken) throw new Error('boom')
    return { value: { command: 'task-hud' } } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // Task tools answer as the engine's do: a created task has an id, an update succeeds.
  on('tool.call', (_, e) => ({
    result: e.tool === 'TaskCreate' ? { task: { id: `t-${e.subject}` } } : e.tool === 'TaskUpdate' ? { success: true } : {},
  }) as never)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  return clock
}

const SPAWN = {
  tool_use_id: 'tu1', prompt: 'Draft it', description: 'Script', subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
} as never
// How many times the redraw timer has written, counted beneath the plugin.
let ticks = 0
const tickOf = (_: Engine) => ticks

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')

async function todos($: Engine, done: number) {
  const statuses = ['completed', 'completed', 'completed', 'completed', 'pending'].map((s, i) =>
    i < done ? 'completed' : i === done ? 'in_progress' : 'pending') as ('pending' | 'in_progress' | 'completed')[]
  const names = ['Research', 'Thumbnails', 'Pre-outline', 'B-roll list', 'Write the script']
  await $.tool.call({
    tool: 'TodoWrite',
    todos: names.map((n, i) => ({ content: n, activeForm: n, status: statuses[i]! })),
  })
}

describe('band', () => {
  test('fills as to-dos are ticked off, named after the prompt', async ($, on) => {
    engine(on)
    // The engine's own band beneath: empty.
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.turn.start({ text: 'Video prep: Claude Projects', turnId: 't1' })
    await todos($, 4)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      const text = await texts(ui)
      expect(text).toMatch(/Video prep: Claude Projects/)
      expect(text).toMatch(/80%/)
      expect(text).toMatch(/Now: Write the script/)
      await ui.unmount()
    }
  })

  test('stays out of the way with no to-dos', async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(ui)).toBe('engine')
    await ui.unmount()
  })

  test("keeps the band beneath it (another mod's) below the bar", async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>spark</Text>
    })
    await todos($, 1)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/20%/)
    expect(text).toMatch(/spark/)
    await ui.unmount()
  })
})

describe('pane', () => {
  test('a sub-agent runs, works and finishes', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn({
      tool_use_id: 'tu1', prompt: 'Draft it', description: 'Script', subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
    } as never)
    await $.tool.call({ tool: 'Read', file_path: '/w/pre-outline.md', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/w/script.md', content: 'x', agentId: 'a1' } as never)

    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as never)
      const text = await texts(ui)
      expect(text).toMatch(/Running · 1/)
      expect(text).toMatch(/Script/)
      expect(text).toMatch(/general-purpose · Opus 5\.5/)
      expect(text).toMatch(/Step 2 · Writing script\.md/)
      expect(text).toMatch(/Reading pre-outline\.md/)
      await ui.unmount()
    }

    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/Finished · 1/)
    expect(text).toMatch(/Done · 2 steps/)
    expect(text).toMatch(/Wrote script\.md/)
    await ui.press({ key: 'clear' })
    expect(await texts(ui)).toMatch(/No sub-agents yet/)
    await ui.unmount()
  })
})

describe('pane edge cases', () => {
  test('shows just the file name of a Windows path', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: 'C:\\x', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn(SPAWN)
    await $.tool.call({ tool: 'Read', file_path: 'C:\\x\\file.md', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/w/script.md', content: 'x', agentId: 'a1' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/Reading file\.md/)
    expect(text).not.toMatch(/C:/)
    await ui.unmount()
  })

  test('an agent that fails is shown as stopped', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn(SPAWN)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'error' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/Finished · 1/)
    expect(text).toMatch(/Stopped · 0 steps/)
    expect(text).not.toMatch(/Running/)
    await ui.unmount()
  })

  test('a resumed agent runs again and ticks again', async ($, on) => {
    const clock = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn(SPAWN)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' } as never)
    await clock.advance(2000)
    const idle = await tickOf($)
    await clock.advance(2000)
    expect(await tickOf($)).toBe(idle)
    await $.agent.spawn({ ...(SPAWN as object), resume: 'a1' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(ui)).toMatch(/Running · 1/)
    await ui.unmount()
    await clock.advance(2000)
    expect(await tickOf($)).toBeGreaterThan(idle as number)
  })

  test('an agent with no turn.complete is stopped when silent, and the timer ends', async ($, on) => {
    const clock = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn(SPAWN)
    await clock.advance(10 * 60_000 + 1000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(ui)).toMatch(/Stopped/)
    await ui.unmount()
    const stopped = await tickOf($)
    await clock.advance(10_000)
    expect(await tickOf($)).toBe(stopped)
  })

  test('the timer ends with the session', async ($, on) => {
    const clock = engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.agent.spawn(SPAWN)
    await clock.advance(2000)
    await $.session.end({ reason: 'other', sessionId: 's1', resume: {} } as never)
    const ended = await tickOf($)
    await clock.advance(5000)
    expect(await tickOf($)).toBe(ended)
  })

  test('a throwing dependency never breaks the turn', async ($, on) => {
    engine(on, true)
    await expect($.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)).resolves.toBeDefined()
    await expect($.agent.spawn(SPAWN)).resolves.toBeDefined()
    await expect($.tool.call({ tool: 'Read', file_path: '/w/a.md', agentId: 'a1' } as never)).resolves.toBeDefined()
    await expect($.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' } as never)).resolves.toBeDefined()
    await expect($.turn.start({ text: 'hi', turnId: 't1' })).resolves.toBeDefined()
  })
})

describe('task tools', () => {
  test('two TaskCreate calls at once both land, and TaskUpdate edits them', async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
    await $.turn.start({ text: 'Plan', turnId: 't1' })
    await Promise.all(['A', 'B'].map(subject => $.tool.call({ tool: 'TaskCreate', subject, description: subject } as never)))
    const band = async () => {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
      const text = await texts(ui)
      await ui.unmount()
      return text
    }
    expect(await band()).toMatch(/Tasks 0\/2/)
    await $.tool.call({ tool: 'TaskUpdate', taskId: 't-A', status: 'completed' } as never)
    expect(await band()).toMatch(/Tasks 1\/2/)
    await $.tool.call({ tool: 'TaskUpdate', taskId: 't-B', status: 'deleted' } as never)
    expect(await band()).toMatch(/Tasks 1\/1/)
  })
})
