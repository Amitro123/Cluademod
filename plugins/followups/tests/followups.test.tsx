import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { migrate, parseFindings, section, startPrompt, sweepPrompt, upsert } from '../hooks/register'

const TOOL = 'mcp__followups__flag'
const DONE = 'mcp__followups__done'

const BAND = {
  plugin: 'followups',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

const PANE = {
  plugin: 'followups',
  component: 'Pane',
  requestId: 'followups',
  props: { title: 'To-do', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The engine beneath: a clock, a store, a folder with a README, and the side calls.
function engine(on: On, files: Record<string, string>, saved: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 12) })
  // mock.store keeps its entries private, so the two store calls the mod makes run over `saved`, which the test can read.
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__followups__${e.name}` } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  // Files by their path under the project root.
  // The engine resolves paths for the host OS (on Windows `/repo/x` arrives as `C:\repo\x`), so normalise both.
  const rel = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^\/repo\//, '')
  on('fs.exists', (_, e) => ({ value: rel(e.path) in files }) as never)
  on('fs.read', (_, e) => ({ value: files[rel(e.path)] ?? '' }) as never)
  on('fs.write', (_, e) => {
    files[rel(e.path)] = e.text
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')

describe('flag → ask → to-do → export', () => {
  test('each flag stops on a dialog: add, skip, reworded, or left for the band', async ($, on) => {
    const files: Record<string, string> = { 'README.md': '# My project\n\nIntro.\n' }
    engine(on, files)
    // The person's answers, in order; null dismisses the dialog.
    const answers: (string | null)[] = ['Add to to-do', 'Not needed', 'Rotate the staging key too', null]
    const asked: string[] = []
    // $.ui.ask is an AskUserQuestion tool call: this stands for the dialog.
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      const question = e.questions[0]!.question
      asked.push(question)
      const a = answers.shift()
      if (a === null || a === undefined) throw new Error('dismissed')
      return { result: { questions: e.questions, answers: { [question]: a } } } as never
    })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)

    const added = await $.tool.call({ tool: TOOL, title: 'Fix the flaky upload test', detail: 'Fails 1 in 5 runs', where: 'tests/upload.test.ts:42' } as never)
    expect(String(added.result)).toMatch(/added "Fix the flaky upload test"/)
    expect(asked[0]).toMatch(/Claude noticed: "Fix the flaky upload test" \(Fails 1 in 5 runs · tests\/upload\.test\.ts:42\)/)
    const skipped = await $.tool.call({ tool: TOOL, title: 'Bump lodash' } as never)
    expect(String(skipped.result)).toMatch(/skipped/)
    const reworded = await $.tool.call({ tool: TOOL, title: 'Rotate the leaked dev key' } as never)
    expect(String(reworded.result)).toMatch(/added "Rotate the staging key too"/)
    const unanswered = await $.tool.call({ tool: TOOL, title: 'Document RATE_LIMIT' } as never)
    expect(String(unanswered.result)).toMatch(/didn't answer/)
    const again = await $.tool.call({ tool: TOOL, title: 'fix the flaky  upload test' } as never)
    expect(String(again.result)).toMatch(/Already flagged/)
    expect(asked.length).toBe(4)

    // The unanswered one waits in the band.
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      const text = await texts(ui)
      expect(text).toMatch(/Track it\?/)
      expect(text).toMatch(/Document RATE_LIMIT/)
      await ui.unmount()
    }
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    await band.press({ key: 'skip' })
    expect(await texts(band)).not.toMatch(/Track it/)
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    expect(await texts(pane)).toMatch(/2 open · 0 in progress · 0 done/)
    await pane.press({ key: 'export-readme' })
    expect(files['README.md']).toMatch(/^# My project/)
    expect(files['README.md']).toMatch(/## Known issues & follow-ups/)
    expect(files['README.md']).toMatch(/- \[ \] Fix the flaky upload test — Fails 1 in 5 runs · `tests\/upload\.test\.ts:42`/)
    expect(files['README.md']).toMatch(/- \[ \] Rotate the staging key too/)
    expect(files['README.md']).not.toMatch(/lodash/)
    expect(await texts(pane)).toMatch(/Exported 2 to README\.md/)
    await pane.unmount()
  })

  test('/followup adds by hand; ticking off and re-exporting replaces the section', async ($, on) => {
    const files: Record<string, string> = {}
    engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'followup', args: 'Write the migration guide' } as never)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'export-memory' })
    expect(files['CLAUDE.md']).toMatch(/- \[ \] Write the migration guide/)
    const ids = (await pane.findAll({ type: 'Button' } as never)).map(b => String((b as { key?: string }).key))
    const toggle = ids.find(k => k.startsWith('t-'))!
    await pane.press({ key: toggle })
    expect(await texts(pane)).toMatch(/0 open · 0 in progress · 1 done/)
    await pane.press({ key: 'export-memory' })
    expect(files['CLAUDE.md']!.match(/followups:start/g)?.length).toBe(1)
    expect(files['CLAUDE.md']).toMatch(/- \[x\] Write the migration guide/)
    await pane.unmount()
  })

  test('Docs export starts docs/FOLLOW-UPS.md in a project without a docs folder', async ($, on) => {
    // $.fs.write creates missing directories, so a fresh project needs nothing first.
    const files: Record<string, string> = { 'README.md': '# My project\n' }
    engine(on, files)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await $.command.run({ command: 'followup', args: 'Check Docs export when docs/ does not exist' } as never)

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    await pane.press({ key: 'export-docs' })
    expect(files['docs/FOLLOW-UPS.md']).toMatch(/^<!-- followups:start -->\n# Follow-ups\n\n- \[ \] Check Docs export/)
    expect(files['README.md']).toBe('# My project\n')
    expect(await texts(pane)).toMatch(/Exported 1 to docs\/FOLLOW-UPS\.md/)
    await pane.unmount()
  })

  test('Add all in the band keeps every waiting flag', async ($, on) => {
    engine(on, {})
    // A dismissed dialog leaves the flag in the band.
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      throw new Error('dismissed')
    })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await $.tool.call({ tool: TOOL, title: 'First thing' } as never)
    await $.tool.call({ tool: TOOL, title: 'Second thing' } as never)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await texts(band)).toMatch(/\(\+1 more\)/)
    await band.press({ key: 'add-all' })
    expect(await texts(band)).not.toMatch(/Track it/)
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    expect(await texts(pane)).toMatch(/2 open · 0 in progress · 0 done/)
    await pane.unmount()
  })

  test('Clear done and ✕ remove items', async ($, on) => {
    engine(on, {})
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    for (const args of ['One', 'Two', 'Three']) await $.command.run({ command: 'followup', args } as never)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const keys = async () => (await pane.findAll({ type: 'Button' } as never)).map(b => String((b as { key?: string }).key))
    expect(await keys()).not.toContain('clear-done')

    // ✕ on the first row.
    await pane.press({ key: (await keys()).find(k => k.startsWith('x-'))! })
    expect(await texts(pane)).toMatch(/2 open · 0 in progress · 0 done/)
    expect(await texts(pane)).not.toMatch(/One/)

    // Tick one off, then Clear done removes only it.
    await pane.press({ key: (await keys()).find(k => k.startsWith('t-'))! })
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 1 done/)
    await pane.press({ key: 'clear-done' })
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 0 done/)
    expect(await keys()).not.toContain('clear-done')
    await pane.unmount()
  })

  test('/followup with no args shows usage and adds nothing; a repeated title is not added twice', async ($, on) => {
    const writes: Record<string, unknown> = {}
    engine(on, {}, writes)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const empty = await $.command.run({ command: 'followup', args: '   ' } as never)
    expect(String(empty.text)).toBe('Usage: /followup <what to do>')

    // The by-hand command de-duplicates like the flag tool: same title (normalised) is not added again.
    const first = await $.command.run({ command: 'followup', args: 'Same title' } as never)
    expect(String(first.text)).toMatch(/Added to follow-ups/)
    const dup = await $.command.run({ command: 'followup', args: '  same   TITLE ' } as never)
    expect(String(dup.text)).toBe('Already in your follow-ups: "Same title".')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 0 done/)
    await pane.unmount()
    expect((writes['items:/repo'] as unknown[]).length).toBe(1)

    // The tool call sees it as already known too.
    const again = await $.tool.call({ tool: TOOL, title: 'same TITLE' } as never)
    expect(String(again.result)).toMatch(/Already flagged/)
  })

  test('/followup on a flag waiting in the band keeps that flag', async ($, on) => {
    engine(on, {})
    on('tool.call', { tool: 'AskUserQuestion' }, () => {
      throw new Error('dismissed')
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: TOOL, title: 'Fix the flaky upload test', detail: 'Fails 1 in 5 runs' } as never)

    const r = await $.command.run({ command: 'followup', args: 'fix the flaky upload test' } as never)
    expect(String(r.text)).toBe('Added to follow-ups: Fix the flaky upload test')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).not.toMatch(/Track it/)
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(pane)
    expect(text).toMatch(/1 open · 0 in progress · 0 done/)
    expect(text).toMatch(/Fails 1 in 5 runs/)
    await pane.unmount()
  })

  test('a reload keeps the session state, so items held there before statuses are migrated too', async ($, on) => {
    engine(on, {})
    // $.state outlives a reload of the mod: an older version left this item with isDone and no status.
    // The test stands for the host here: it holds that one value and takes the mod's writes.
    let held: unknown = [{ id: 'old', title: 'Held in state', detail: '', where: '', at: 0, isDone: true }]
    let version = 1
    on('state.get', (_, e) => ((e as { key: string }).key === 'items' ? { value: { value: held, version } } : { value: { value: undefined, version: 0 } }) as never)
    on('state.set', (_, e) => {
      const w = e as { key: string; value: unknown }
      if (w.key === 'items') {
        held = w.value
        version += 1
      }
      return { value: { isSet: true, version } } as never
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/0 open · 0 in progress · 1 done/)
    await pane.unmount()
  })

  test('a new session loads the list saved in $.store for the folder', async ($, on) => {
    // The folder's earlier list is already in the store when the session starts.
    engine(on, {}, { 'items:/repo': [{ id: 'old', title: 'Carried over', detail: '', where: '', at: 0, isDone: false }] })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 0 done/)
    expect(await texts(pane)).toMatch(/○ \| Carried over/)
    await pane.unmount()
  })

  test('changes made in the pane are saved to $.store', async ($, on) => {
    const writes: Record<string, unknown> = { 'items:/repo': [{ id: 'old', title: 'Carried over', detail: '', where: '', at: 0, isDone: false }] }
    engine(on, {}, writes)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'followup', args: 'Added by hand' } as never)
    const stored = async () => writes['items:/repo'] as { title: string; status: string }[]
    expect((await stored()).map(i => i.title)).toEqual(['Carried over', 'Added by hand'])

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const keys = async () => (await pane.findAll({ type: 'Button' } as never)).map(b => String((b as { key?: string }).key))
    await pane.press({ key: 't-old' })
    expect((await stored()).find(i => i.title === 'Carried over')?.status).toBe('done')
    await pane.press({ key: 'clear-done' })
    expect((await stored()).map(i => i.title)).toEqual(['Added by hand'])
    await pane.press({ key: (await keys()).find(k => k.startsWith('x-'))! })
    expect(await stored()).toEqual([])
    await pane.unmount()
  })

  test('the model is told when to flag', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    const last = r.sections[r.sections.length - 1]
    expect(last?.id).toBe('followups:guidance')
    expect(last?.text).toMatch(/mcp__followups__flag/)
  })
})

describe('statuses, bugs, start and done', () => {
  const find = async (ui: { findAll: (q: never) => Promise<unknown[]> }, type: string) => ui.findAll({ type } as never) as Promise<{ key?: string; text?: string; props?: { color?: string; strikethrough?: boolean } }[]>

  test('flag kind bug shows a red marker; ordinary flags do not', async ($, on) => {
    engine(on, {})
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'Add to to-do' } } } as never
    })
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await $.tool.call({ tool: TOOL, title: 'Crash on empty input', kind: 'bug' } as never)
    await $.tool.call({ tool: TOOL, title: 'Write docs' } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    const bugs = (await find(pane, 'Text')).filter(t => t.text === '🐞')
    expect(bugs.length).toBe(1)
    expect(bugs[0]!.props?.color).toBe('#e5484d')
    expect(await texts(pane)).toMatch(/2 open · 0 in progress · 0 done/)
    await pane.unmount()
  })

  test('done also finds an item by its title, ignoring case and spacing', async ($, on) => {
    engine(on, {})
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'followup', args: 'Rotate the key' } as never)
    await $.command.run({ command: 'followup', args: 'Bump lodash' } as never)

    const ok = await $.tool.call({ tool: DONE, id: '  rotate THE   key ' } as never)
    expect(String(ok.result)).toMatch(/Marked "Rotate the key" done/)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 1 done/)
    await pane.unmount()
    const empty = await $.tool.call({ tool: DONE, id: '' } as never)
    expect(String(empty.deny ?? empty.result)).toMatch(/No to-do item/)
  })

  test('Start sets in progress, submits a prompt naming the item and id, and done completes it', async ($, on) => {
    const files: Record<string, string> = {}
    engine(on, files)
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'followup', args: 'Rotate the key' } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const keys = async () => (await find(pane, 'Button')).map(b => String(b.key))
    const sKey = (await keys()).find(k => k.startsWith('s-'))!
    const id = sKey.slice(2)
    await pane.press({ key: sKey })
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain(id)
    expect(sent[0]).toContain('Rotate the key')
    expect(sent[0]).toContain(DONE)
    expect(await texts(pane)).toMatch(/0 open · 1 in progress · 0 done/)
    expect(await keys()).not.toContain(sKey)
    await pane.press({ key: 'export-docs' })
    expect(files['docs/FOLLOW-UPS.md']).toMatch(/- \[ \] Rotate the key _\(in progress\)_/)

    const unknown = await $.tool.call({ tool: DONE, id: 'nope' } as never)
    expect(String(unknown.deny ?? unknown.result)).toMatch(/No to-do item with id "nope"/)
    const ok = await $.tool.call({ tool: DONE, id, note: 'rotated' } as never)
    expect(String(ok.result)).toMatch(/Marked "Rotate the key" done \(rotated\)/)
    const again = await $.tool.call({ tool: DONE, id } as never)
    expect(String(again.result)).toMatch(/already done/)
    expect(await texts(pane)).toMatch(/0 open · 0 in progress · 1 done/)
    const title = (await find(pane, 'Text')).find(t => t.text === 'Rotate the key')!
    expect(title.props?.color).toBe('#1f9d6b')
    expect(title.props?.strikethrough).toBe(true)
    await pane.unmount()
  })

  test('Start all open submits one prompt listing every open item', async ($, on) => {
    engine(on, {})
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    for (const args of ['One', 'Two']) await $.command.run({ command: 'followup', args } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'start-all' })
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/One[\s\S]*Two/)
    expect(await texts(pane)).toMatch(/0 open · 2 in progress · 0 done/)
    await pane.unmount()
  })

  test('saved items with isDone migrate to a status on load', async ($, on) => {
    engine(on, {}, {
      'items:/repo': [
        { id: 'a', title: 'Was open', detail: '', where: '', at: 0, isDone: false },
        { id: 'b', title: 'Was done', detail: '', where: '', at: 0, isDone: true },
      ],
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/1 open · 0 in progress · 1 done/)
    await pane.unmount()
    expect(migrate([{ id: 'a', isDone: true }])[0]).toMatchObject({ status: 'done', kind: 'task' })
  })

  test('the model is told about kind and done', async ($, on) => {
    on('prompt.compose', () => ({ sections: [] }))
    const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    const text = r.sections[r.sections.length - 1]!.text
    expect(text).toMatch(/kind to "bug"/)
    expect(text).toMatch(/mcp__followups__done/)
  })

  test('export marks bugs and in-progress items; startPrompt names where', () => {
    const base = { detail: '', where: '', at: 0 }
    const out = section('docs', [
      { ...base, id: '1', title: 'A', status: 'in_progress', kind: 'bug' },
      { ...base, id: '2', title: 'B', status: 'done' },
    ])
    expect(out).toContain('- [ ] A _(bug)_ _(in progress)_')
    expect(out).toContain('- [x] B')
    expect(startPrompt([{ ...base, id: 'z9', title: 'T', where: 'a.ts:1', status: 'open' }])).toMatch(/id z9: T \[where: a\.ts:1\]/)
  })
})

describe('export text', () => {
  test('an export is appended once, then replaced in place', () => {
    const one = section('docs', [{ id: '1', title: 'A', detail: '', where: '', at: 0, status: 'open' as const }])
    const first = upsert('# Doc\n', one)
    expect(first).toBe(`# Doc\n\n${one}\n`)
    const two = section('docs', [{ id: '1', title: 'A', detail: '', where: '', at: 0, status: 'done' as const }])
    expect(upsert(`${first}\nAfter.\n`, two)).toBe(`# Doc\n\n${two}\n\nAfter.\n`)
  })

  const END = '<!-- followups:end -->'
  const block = (title: string) => section('docs', [{ id: '1', title, detail: '', where: '', at: 0, status: 'open' as const }])
  const count = (s: string, m: string) => s.split(m).length - 1

  test('a stray END before START is not paired: the block is appended, not spliced', () => {
    const text = `intro\n${END}\ntail\n`
    const out = upsert(text, block('A'))
    expect(out).toBe(`intro\n${END}\ntail\n\n${block('A')}\n`)
  })

  test('re-exporting over a stray earlier END stays one block', () => {
    const text = `intro\n${END}\ntail\n`
    const once = upsert(text, block('A'))
    const twice = upsert(once, block('B'))
    expect(count(twice, 'followups:start')).toBe(1)
    expect(count(twice, 'followups:end')).toBe(2)
    expect(twice).toBe(`intro\n${END}\ntail\n\n${block('B')}\n`)
    expect(upsert(twice, block('B'))).toBe(twice)
  })

  test('END before START with a later END replaces only the well-formed pair', () => {
    const text = `${END}\nmid\n${block('A')}\nafter\n`
    expect(upsert(text, block('B'))).toBe(`${END}\nmid\n${block('B')}\nafter\n`)
  })
})

describe('after each answer, a look for loose ends', () => {
  const LONG = 'Added the limiter to POST /upload and its tests pass. '.repeat(3) +
    'While in there I saw the upload test is flaky (about 1 in 5 runs), and I did not check the Windows path handling.'
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  test('a finding the answer left open is offered in the band; tracked and turned-down ones are not', async ($, on) => {
    const clock = engine(on, {})
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      const q = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [q]: q.includes('lodash') ? 'Not needed' : 'Add to to-do' } } } as never
    })
    const asked: { model: string; prompt: string }[] = []
    on('model.complete', (_, e) => {
      asked.push({ model: e.model, prompt: String(e.prompt) })
      return { value: { isAnswered: true, usage, text: 'Here you go:\n' + JSON.stringify([
        { title: 'Fix the flaky upload test', detail: 'Fails about 1 in 5 runs', where: 'tests/upload.test.ts', kind: 'bug' },
        { title: 'Check the Windows path handling', detail: 'Not verified', where: '', kind: 'task' },
        { title: 'Bump lodash', detail: '', where: '', kind: 'task' },
      ]) } } as never
    })
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    // Claude flagged one itself, and the person turned one down earlier.
    await $.tool.call({ tool: TOOL, title: 'Fix the flaky upload test' } as never)
    await $.tool.call({ tool: TOOL, title: 'Bump lodash' } as never)

    await $.turn.complete({ answer: LONG, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.settle()

    expect(asked.length).toBe(1)
    expect(asked[0]!.model).toBe('haiku')
    expect(asked[0]!.prompt).toContain('fix the flaky upload test')
    expect(asked[0]!.prompt).toContain('bump lodash')
    expect(asked[0]!.prompt).toContain('did not check the Windows path handling')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    const text = await texts(band)
    expect(text).toMatch(/Track it\?/)
    expect(text).toMatch(/Check the Windows path handling/)
    expect(text).not.toMatch(/\+1 more/)
    await band.unmount()
  })

  test('short answers, sub-agents and turns that did not answer are not read', async ($, on) => {
    const clock = engine(on, {})
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return { value: { isAnswered: true, usage, text: '[]' } } as never
    })
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await $.turn.complete({ answer: LONG, durationMs: 10, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' } as never)
    await $.turn.complete({ answer: LONG, durationMs: 10, isAborted: true, turnId: 't3', reason: 'aborted' } as never)
    await clock.settle()
    expect(calls).toBe(0)
    await $.turn.complete({ answer: LONG, durationMs: 10, isAborted: false, turnId: 't4', reason: 'answer' } as never)
    await clock.settle()
    expect(calls).toBe(1)
  })

  test('a model that fails or answers nonsense adds nothing', async ($, on) => {
    const clock = engine(on, {})
    const replies = [
      { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage },
      { isAnswered: true, usage, text: 'I could not find anything [but here is a bracket' },
    ]
    on('model.complete', () => ({ value: replies.shift() }) as never)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    for (const turnId of ['t1', 't2']) {
      await $.turn.complete({ answer: LONG, durationMs: 10, isAborted: false, turnId, reason: 'answer' } as never)
      await clock.settle()
    }
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).not.toMatch(/Track it/)
    await band.unmount()
  })
})

describe('reading the finder\'s answer', () => {
  test('takes the JSON array out of surrounding text, keeps at most 3 well-formed entries', () => {
    const out = parseFindings('Sure!\n[{"title":"A","kind":"bug"},{"detail":"no title"},{"title":"  "},{"title":"B"},{"title":"C"},{"title":"D"}]\nThanks')
    expect(out.map(f => f.title)).toEqual(['A', 'B', 'C'])
    expect(out[0]!.kind).toBe('bug')
    expect(out[1]!.kind).toBe('task')
    expect(parseFindings('nothing here')).toEqual([])
    expect(parseFindings('{"title":"not an array"}')).toEqual([])
  })

  test('the prompt lists what is tracked and keeps the end of a long reply', () => {
    const p = sweepPrompt('x'.repeat(20_000) + 'THE END', ['one'])
    expect(p).toContain('- one')
    expect(p).toContain('THE END')
    expect(p.length).toBeLessThan(13_000)
  })
})
