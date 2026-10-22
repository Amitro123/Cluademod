import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { section, upsert } from '../hooks/register'

const TOOL = 'mcp__followups__flag'

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
function engine(on: On, files: Record<string, string>) {
  mock.clock(on, { now: Date.UTC(2026, 9, 22, 12) })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__followups__${e.name}` } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  // Files by their path under the project root.
  const rel = (p: string) => p.replace(/^\/repo\//, '')
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
    expect(await texts(pane)).toMatch(/2 open · 0 done/)
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
    expect(await texts(pane)).toMatch(/0 open · 1 done/)
    await pane.press({ key: 'export-memory' })
    expect(files['CLAUDE.md']!.match(/followups:start/g)?.length).toBe(1)
    expect(files['CLAUDE.md']).toMatch(/- \[x\] Write the migration guide/)
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

describe('export text', () => {
  test('an export is appended once, then replaced in place', () => {
    const one = section('docs', [{ id: '1', title: 'A', detail: '', where: '', at: 0, isDone: false }])
    const first = upsert('# Doc\n', one)
    expect(first).toBe(`# Doc\n\n${one}\n`)
    const two = section('docs', [{ id: '1', title: 'A', detail: '', where: '', at: 0, isDone: true }])
    expect(upsert(`${first}\nAfter.\n`, two)).toBe(`# Doc\n\n${two}\n\nAfter.\n`)
  })
})
