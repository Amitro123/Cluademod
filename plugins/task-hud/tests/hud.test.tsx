import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { activityOf, modelName } from '../hooks/register'

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
function engine(on: On, { spawn = true } = {}) {
  mock.clock(on, { now: Date.UTC(2026, 9, 22, 12) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'task-hud' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }) as never)
  if (spawn) on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
}

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


const SPAWN = {
  tool_use_id: 'tu', prompt: 'Do it', subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
} as const

describe('to-do sources', () => {
  test('TaskCreate and TaskUpdate drive the bar; a deleted task leaves it', async ($, on) => {
    let next = 0
    on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }) as never)
    on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }) as never)
    engine(on)
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    await $.turn.start({ text: 'Ship the release', turnId: 't1' })
    for (const subject of ['Bump the version', 'Write the changelog', 'Tag it']) {
      await $.tool.call({ tool: 'TaskCreate', subject, description: subject } as never)
    }
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Writing the changelog' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' } as never)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/Ship the release/)
    expect(text).toMatch(/Tasks 1\/2/)
    expect(text).toMatch(/50%/)
    expect(text).toMatch(/Now: Writing the changelog/)
    await ui.unmount()
  })

  test("a sub-agent's TodoWrite leaves the bar alone", async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.tool.call({ tool: 'TodoWrite', agentId: 'a1', todos: [{ content: 'Inner', activeForm: 'Inner', status: 'in_progress' }] } as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(ui)).toBe('engine')
    await ui.unmount()
  })

  test('a finished list clears on the next prompt; an unfinished one stays', async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    await todos($, 2)
    await $.turn.start({ text: 'Keep going', turnId: 't2' })
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(ui)).toMatch(/Tasks 2\/5/)
    await ui.unmount()

    await todos($, 5)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(ui)).toMatch(/All done/)
    await ui.unmount()
    await $.turn.start({ text: 'Something new', turnId: 't3' })
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(ui)).not.toMatch(/Tasks/)
    await ui.unmount()
  })
})

describe('sub-agent cards', () => {
  test('an agent that errors or is interrupted shows as stopped', async ($, on) => {
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++n}` }))
    engine(on, { spawn: false })
    await $.agent.spawn({ ...SPAWN, description: 'Broken one' } as never)
    await $.agent.spawn({ ...SPAWN, description: 'Cut short' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', agentId: 'a1' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'x1', agentId: 'a1', reason: 'error' } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 'x2', agentId: 'a2', reason: 'aborted' } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/Finished · 2/)
    expect(text).not.toMatch(/Running/)
    expect(text).toMatch(/Stopped · 1 steps/)
    expect(text).toMatch(/Stopped · 0 steps/)
    expect(text).toMatch(/Ran Run the tests/)
    expect(text).toMatch(/Sonnet 5\.5/)
    expect(text).toMatch(/✕/)
    await ui.unmount()
  })

  test('a resumed agent runs again on its own card', async ($, on) => {
    engine(on)
    await $.agent.spawn({ ...SPAWN, description: 'Script' } as never)
    await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'x1', agentId: 'a1', reason: 'answer' } as never)
    await $.agent.spawn({ ...SPAWN, description: 'Script', prompt: 'One more pass', resume: { agentId: 'a1' } } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(ui)
    expect(text).toMatch(/1 sub-agent\b/)
    expect(text).toMatch(/Running · 1/)
    expect(text).not.toMatch(/Finished/)
    await ui.unmount()
  })

  test("the card's tokens are the agent's context on its latest request", async ($, on) => {
    engine(on)
    on('turn.step', async function* (_, e) {
      return {
        turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
        usage: { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 },
      } as never
    })
    await $.agent.spawn({ ...SPAWN, description: 'Research' } as never)
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'a1' } as never)
    for await (const _ of stream) { /* drain */ }
    await stream.result

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(ui)).toMatch(/45k tokens/)
    await ui.unmount()
  })
})

describe('text', () => {
  test('model names read as the family and version', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelName('haiku')).toBe('Haiku')
    expect(modelName('some-other-model')).toBe('some-other-model')
  })

  test('each tool call reads as what the agent is doing, then did', () => {
    expect(activityOf('Read', { file_path: '/w/notes/a.md' })).toEqual({ now: 'Reading a.md', past: 'Read a.md' })
    expect(activityOf('Grep', { pattern: 'TODO' }).now).toBe('Searching for TODO')
    expect(activityOf('WebFetch', { url: 'https://example.com/x?y=1' }).past).toBe('Fetched example.com')
    expect(activityOf('Skill', { skill: 'pdf' }).now).toBe('Reading the pdf skill')
    expect(activityOf('mcp__github__get_file_contents', {}).now).toBe('Using get_file_contents')
    expect(activityOf('Bash', { command: 'git status\ngit log' }).now).toBe('Running git status')
  })
})
