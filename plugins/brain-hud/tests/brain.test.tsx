import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { claudeCells, sceneSvg } from '../hooks/art'
import { diffBrain, logPrompt, parseMemory, parseMistakes, withListing } from '../hooks/brain'
import type { Brain } from '../types'
// The wording followups and goal-run write, from the copy of shared/texts.ts they use too.
import { doneResult, GOAL_REACHED, goalClosedNote, goalPrompt, parseStartPrompt, startLine } from '../hooks/texts'

// Shaped like agent-brain-org's own files.
const entry = (at: string, title: string, type: string | null, status = 'unrouted') =>
  [`## [${at}] ${title}`, ...(type ? [`- **Type:** ${type}`] : []), '- **What happened:** something.', `- **PARA route:** ${status === 'unrouted' ? 'unrouted' : 'Project: .agent-brain/shared/Projects/skill.md'}`, `- **Status:** ${status}`, ''].join('\n')

const MISTAKES_HEAD = '# MISTAKES.md\n\nRaw, append-only log.\n\n<!-- mistake-brain: new entries are inserted immediately below this line -->\n\n'

const MEMORY = `# MEMORY.md — shared session index

## Projects
- [Project] Projects/mistake-brain-skill.md — bugs and decisions while building the skill (29 lessons, last updated 2026-10-05)

## Areas
_(none yet)_

## Resources
- [Resource] Resources/independent-review-before-commit.md — write a reviewer prompt (1 lesson, last updated 2026-08-15)
- [Resource] Resources/skill-deployment-pattern.md — one adapter per host (3 lessons, last updated 2026-08-26)

## Archives
Archives: 0 files (not loaded at session start)

## Rules promoted so far
_(none yet — see CLAUDE.md and .claude/rules/ for the live rules)_

## Last dream
**2026-09-18** — heartbeat gap.
`

describe('reading the memory', () => {
  test('MISTAKES.md: each entry with its type and status; an entry without a type is a mistake', () => {
    const list = parseMistakes(MISTAKES_HEAD + entry('2026-10-05 17:30', 'Index stub broke the installed hook', 'mistake', 'routed') + entry('2026-10-05 15:55', 'Added an end-to-end test', 'decision') + entry('2026-08-01 09:00', 'Old entry', null))
    expect(list.map(e => [e.title, e.type, e.status])).toEqual([
      ['Index stub broke the installed hook', 'mistake', 'routed'],
      ['Added an end-to-end test', 'decision', 'unrouted'],
      ['Old entry', 'mistake', 'unrouted'],
    ])
  })

  test('MEMORY.md: the files per folder with their lessons, the archive count, the rules and the last dream', () => {
    const m = parseMemory(MEMORY)
    expect(m.folders.Projects).toEqual([{ file: 'mistake-brain-skill.md', summary: 'bugs and decisions while building the skill', lessons: 29, updated: '2026-10-05', isIndexed: true }])
    expect(m.folders.Areas).toEqual([])
    expect(m.folders.Resources.map(l => [l.file, l.lessons])).toEqual([['independent-review-before-commit.md', 1], ['skill-deployment-pattern.md', 3]])
    expect(m.archives).toBe(0)
    expect(m.rules).toEqual([])
    expect(m.lastDream).toBe('2026-09-18')
  })

  test('a PARA file on disk that MEMORY.md does not name still shows, marked', () => {
    const f = withListing(parseMemory(MEMORY).folders, { Resources: ['skill-deployment-pattern.md', 'output-discipline.md'] })
    expect(f.Resources.map(l => [l.file, l.isIndexed])).toEqual([
      ['independent-review-before-commit.md', true],
      ['skill-deployment-pattern.md', true],
      ['output-discipline.md', false],
    ])
  })

  test("followups' Start prompt: ids, titles and bugs", () => {
    expect(parseStartPrompt('Work on:\n- id k1-a: Fix the upload (bug) — fails 1 in 5 [where: up.ts:4]\n- id k2-b: Update the docs')).toEqual([
      { id: 'k1-a', title: 'Fix the upload', isBug: true },
      { id: 'k2-b', title: 'Update the docs' },
    ])
  })
})

describe('what changed', () => {
  const base = (): Brain => ({ ...parseMemory(MEMORY), entries: parseMistakes(MISTAKES_HEAD + entry('2026-10-05 15:55', 'Added an end-to-end test', 'decision')) })

  test('a new entry shows as its own kind', () => {
    const after = { ...base(), entries: [...parseMistakes(entry('2026-10-24 10:00', 'Forgot to await the write', 'mistake')), ...base().entries] }
    expect(diffBrain(base(), after)).toEqual({ kind: 'mistake', title: 'Forgot to await the write' })
  })

  test('a dream, a promoted rule, a lesson routed into a folder', () => {
    expect(diffBrain(base(), { ...base(), lastDream: '2026-10-24' })?.kind).toBe('dream')
    expect(diffBrain(base(), { ...base(), rules: ['Always await DB writes'] })).toEqual({ kind: 'promote', title: 'Always await DB writes' })
    const grown = base()
    grown.folders.Projects = [{ ...grown.folders.Projects[0]!, lessons: 30 }]
    expect(diffBrain(base(), grown)).toEqual({ kind: 'route', title: 'mistake-brain-skill.md', folder: 'Projects', file: 'mistake-brain-skill.md' })
  })

  test('an entry whose title was edited is not a new one', () => {
    const retitled = { ...base(), entries: base().entries.map(e => ({ ...e, title: `${e.title} (reworded)` })) }
    expect(diffBrain(base(), retitled)).toBeNull()
  })

  test('nothing new, nothing shown; the first reading shows nothing either', () => {
    expect(diffBrain(base(), base())).toBeNull()
    expect(diffBrain(null, base())).toBeNull()
  })

  test('what Claude is asked to log goes through the skill, with the type', () => {
    const text = logPrompt('mistake', 'Fix the upload', 'retried without backoff')
    expect(text).toMatch(/\/mistake-brain log, as Type: mistake/)
    expect(text).toContain('Fix the upload')
  })
})

describe('the art', () => {
  test('every kind draws, and the brain sleeps with its eyes closed in a dream', () => {
    for (const kind of ['mistake', 'success', 'decision', 'handoff', 'route', 'promote', 'dream'] as const) {
      expect(sceneSvg(kind, 3)).toMatch(/^<svg[^>]*>.*<\/svg>$/)
    }
    const eyes = (k: 'idle' | 'dream') => claudeCells(k === 'dream' ? 'dream' : 'success', 1).filter(([, y, fill]) => fill === '#1d1f2b' && y === 5).length
    expect(eyes('idle')).toBe(2)
    expect(eyes('dream')).toBe(0)
  })
})

// ---------- in a session ----------

const BAND = {
  plugin: 'brain-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const
const PANE = {
  plugin: 'brain-hud',
  component: 'Pane',
  requestId: 'brain-hud',
  props: { title: 'Brain', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')
const buttons = async (ui: { findAll: (q: never) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Button' } as never)).map(b => String((b as { key?: string }).key))

// The engine beneath: a project in memory (files by path under /repo, each write bumps its time),
// a clock, and the side calls the mod makes.
function engine(on: On, files: Record<string, string>, { commands = ['followup'] as string[], failSubmit = false, closesGoal = '' } = {}) {
  const w = { sent: [] as string[], ran: [] as string[], opened: [] as string[], times: {} as Record<string, number>, pulses: 0 }
  on('state.set', (_, e, next) => {
    const { key, value } = e as { key?: string; value?: unknown }
    if (key === 'pulse' && value) w.pulses++
    return next(e)
  })
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 24, 9) })
  const rel = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^\/repo\//, '')
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', (_, e) => {
    const p = rel(e.path)
    if (!(p in files)) throw new Error(`ENOENT: ${p}`)
    return { value: files[p] } as never
  })
  on('fs.stat', (_, e) => {
    const p = rel(e.path)
    if (!(p in files)) throw new Error(`ENOENT: ${p}`)
    return { value: { kind: 'file', size: files[p]!.length, mtimeMs: w.times[p] ?? 1, isLink: false } } as never
  })
  on('fs.list', (_, e) => {
    const dir = `${rel(e.path ?? '').replace(/\/$/, '')}/`
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/')).map(p => p.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) } as never
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('command.list', () => ({ value: commands.map(name => ({ name })) }) as never)
  on('command.run', (_, e) => {
    w.ran.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: '' } as never
  })
  on('ui.open', (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => {
    if (failSubmit) throw new Error('not now')
    w.sent.push(e.text)
    return { text: e.text } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'mcp__followups__done') return { result: doneResult('Fix the upload', 'added a retry'), ...(closesGoal ? { context: [goalClosedNote(closesGoal)] } : {}) } as never
    if (e.tool === 'mcp__goal-run__update') return { result: `t2 is done. 2/2 tasks done (100%). ${GOAL_REACHED}` } as never
    return { result: {} } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const write = (path: string, text: string) => {
    files[path] = text
    w.times[path] = (w.times[path] ?? 1) + 1
  }
  // The same object, so counters read after the fact are the live ones.
  return Object.assign(w, { clock, write })
}

const project = () => ({
  'MISTAKES.md': MISTAKES_HEAD + entry('2026-10-05 15:55', 'Added an end-to-end test', 'decision', 'routed') + entry('2026-10-05 14:10', 'Pick up the rollout', 'handoff'),
  '.agent-brain/shared/MEMORY.md': MEMORY,
  '.agent-brain/shared/Projects/mistake-brain-skill.md': '# lessons',
  '.agent-brain/shared/Resources/independent-review-before-commit.md': '#',
  '.agent-brain/shared/Resources/skill-deployment-pattern.md': '#',
  '.agent-brain/shared/Resources/output-discipline.md': '#',
})

describe('in a session', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane draws the memory as a tree (${surface})`, async ($, on) => {
      engine(on, project())
      await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
      await $.turn.start({ text: 'hi', turnId: 't1' } as never)
      const pane = await $.ui.mount({ ...PANE, surface } as never)
      let text = await texts(pane)
      expect(text).toMatch(/🧠 33 lessons \| · 1 unrouted/)
      // No rules yet, so no rules row; no summaries until a file changes.
      expect(text).not.toMatch(/Rules/)
      expect(text).toMatch(/● decision/)
      expect(text).toMatch(/Added an end-to-end test/)
      // Folders open on a press, and a file the index misses is marked.
      await pane.press({ key: 'f-Resources' })
      text = await texts(pane)
      expect(text).toMatch(/skill-deployment-pattern\.md/)
      expect(text).toMatch(/output-discipline\.md \| not in MEMORY\.md/)
      expect(text).not.toMatch(/one adapter per host/)
      if (surface === 'desktop') expect(await pane.find({ type: 'Svg' } as never)).toBeDefined()
      await pane.unmount()
    })
  }

  test('a new entry written to MISTAKES.md plays its scene in the band and opens the pane', async ($, on) => {
    const files = project()
    const w = engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toBe('')
    w.write('MISTAKES.md', files['MISTAKES.md']!.replace('line -->\n\n', `line -->\n\n${entry('2026-10-24 09:01', 'Forgot to await the DB write', 'mistake')}`))
    await $.tool.call({ tool: 'Edit', file_path: '/repo/MISTAKES.md', old_string: 'a', new_string: 'b' } as never)
    let text = await texts(band)
    expect(text).toMatch(/🧠ϟ\(>_<\)/)
    expect(text).toMatch(/Logged a mistake \| Forgot to await the DB write/)
    expect(w.opened).toContain('brain-hud')
    // After a few seconds the scene ends.
    await w.clock.advance(7_000)
    text = await texts(band)
    expect(text).not.toMatch(/Logged a mistake/)
    await band.unmount()
  })

  test("a change made outside a tool call (the skill's own hooks) is caught by the poll", async ($, on) => {
    const files = project()
    const w = engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    w.write('.agent-brain/shared/MEMORY.md', MEMORY.replace('(29 lessons', '(30 lessons'))
    await w.clock.advance(4_100)
    expect(await texts(band)).toMatch(/Filed into memory → Projects \| mistake-brain-skill\.md/)
    await band.unmount()
    // The pane gives the summary of the file that just changed, and only that one.
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'f-Projects' })
    expect(await texts(pane)).toMatch(/✦ mistake-brain-skill\.md .*bugs and decisions while building the skill/)
    await pane.unmount()
  })

  test('a follow-up Claude finished is offered to memory; a bug as a mistake first', async ($, on) => {
    const w = engine(on, project())
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const line = startLine({ id: 'k1-a', title: 'Fix the upload', kind: 'bug', detail: 'fails 1 in 5', where: 'up.ts:4' })
    await $.prompt.submit({ text: `Start this item from my to-do list:\n${line}`, origin: { kind: 'plugin', name: 'followups' } } as never)
    await $.tool.call({ tool: 'mcp__followups__done', id: 'k1-a', note: 'added a retry' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/Worth remembering\? Fix the upload/)
    // One line: the suggested type, "…" for the others, Not now.
    expect(await texts(band)).not.toMatch(/Claude logs it/)
    expect(await buttons(band)).toEqual(['log-mistake', 'log-more', 'log-skip'])
    await band.press({ key: 'log-more' })
    expect(await buttons(band)).toEqual(['log-mistake', 'log-success', 'log-decision', 'log-skip'])
    // Numbered hotkeys: followups' band takes a and s, goal-run's g, k, c and n.
    const keys = (await band.findAll({ type: 'Button' } as never)).map(b => (b as { props?: { hotkey?: string } }).props?.hotkey)
    expect(keys.slice(0, 3)).toEqual(['1', '2', '3'])
    await band.press({ key: 'log-mistake' })
    expect(w.sent.at(-1)).toMatch(/\/mistake-brain log, as Type: mistake/)
    expect(w.sent.at(-1)).toContain('Fix the upload')
    expect(await texts(band)).not.toMatch(/Worth remembering/)
    await band.unmount()
  })

  test('a reached goal is offered as a success or a handoff; Not now drops it', async ($, on) => {
    engine(on, project())
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__goal-run__plan', goal: 'Ship the CSV export', tasks: [] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't2', status: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/Worth remembering\? Reached the goal: Ship the CSV export/)
    expect(await buttons(band)).toEqual(['log-success', 'log-more', 'log-skip'])
    await band.press({ key: 'log-more' })
    expect((await buttons(band)).slice(0, 2)).toEqual(['log-success', 'log-handoff'])
    await band.press({ key: 'log-skip' })
    expect(await texts(band)).toBe('')
    await band.unmount()
  })

  test('the goal is named from goal-run\'s own start prompt when the plan leaves it out', async ($, on) => {
    engine(on, project())
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.prompt.submit({ text: `${goalPrompt('Ship the CSV export')}\n\nBreak it into tasks.`, origin: { kind: 'plugin', name: 'goal-run' } } as never)
    await $.tool.call({ tool: 'mcp__goal-run__plan', tasks: [] } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't2', status: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/Reached the goal: Ship the CSV export/)
    await band.unmount()
  })

  test("a goal a to-do item closed is offered from goal-run's note on the done result, once", async ($, on) => {
    engine(on, project(), { closesGoal: 'Rotate the keys' })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__followups__done', id: 'k1-a' } as never)
    await $.tool.call({ tool: 'mcp__goal-run__update', id: 't2', status: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    // The follow-up's own offer shows first; the goal's waits behind it, and only once.
    expect(await texts(band)).toMatch(/Worth remembering\? Fix the upload/)
    await band.press({ key: 'log-skip' })
    expect(await texts(band)).toMatch(/Worth remembering\? Reached the goal: Rotate the keys/)
    await band.press({ key: 'log-skip' })
    expect(await texts(band)).toBe('')
    await band.unmount()
  })

  test('if the log prompt cannot be sent, the offer comes back', async ($, on) => {
    engine(on, project(), { failSubmit: true })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__followups__done', id: 'k1-a' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'log-success' })
    expect(await texts(band)).toMatch(/Worth remembering\? Fix the upload/)
    await band.unmount()
  })

  test('the pane opens by itself once a session; later changes play in the band only', async ($, on) => {
    const files = project()
    const w = engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    for (const [at, title] of [['2026-10-24 09:01', 'First'], ['2026-10-24 09:02', 'Second']] as const) {
      w.write('MISTAKES.md', files['MISTAKES.md']!.replace('line -->\n\n', `line -->\n\n${entry(at, title, 'success')}`))
      await $.tool.call({ tool: 'Edit', file_path: '/repo/MISTAKES.md', old_string: 'a', new_string: 'b' } as never)
    }
    expect(w.pulses).toBe(2)
    expect(w.opened.filter(id => id === 'brain-hud')).toHaveLength(1)
  })

  test('two refreshes at the same moment (Edits, the poll) play the change once', async ($, on) => {
    const files = project()
    const w = engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await w.clock.advance(3_900)
    w.write('MISTAKES.md', files['MISTAKES.md']!.replace('line -->\n\n', `line -->\n\n${entry('2026-10-24 09:01', 'Once', 'decision')}`))
    const edit = () => $.tool.call({ tool: 'Edit', file_path: '/repo/MISTAKES.md', old_string: 'a', new_string: 'b' } as never)
    await Promise.all([edit(), edit(), w.clock.advance(200)])
    expect(w.pulses).toBe(1)
  })

  test('after the session ends, the memory is no longer polled', async ($, on) => {
    const w = engine(on, project())
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.session.end({ reason: 'other', sessionId: 's1' } as never)
    w.write('.agent-brain/shared/MEMORY.md', MEMORY.replace('(29 lessons', '(30 lessons'))
    await w.clock.advance(10_000)
    expect(w.pulses).toBe(0)
  })

  test("a handoff's next step goes to followups' to-do list", async ($, on) => {
    const w = engine(on, project())
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.turn.start({ text: 'hi', turnId: 't1' } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'fu-1' })
    expect(w.ran).toEqual(['followup Pick up the rollout'])
    await pane.unmount()
  })

  test('no memory in the project: nothing is offered, and the pane says how to start one', async ($, on) => {
    engine(on, {})
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__followups__done', id: 'x' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toBe('')
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/\/mistake-brain init sets one up/)
    await pane.unmount()
  })
})

// Typed for the helpers above.
export type { Engine }
