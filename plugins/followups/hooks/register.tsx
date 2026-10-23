import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flag, Item } from '../types'

// ---------- state ----------

const pending = atom({ plugin: 'followups', key: 'pending' } as const, [] as Flag[])
const items = atom({ plugin: 'followups', key: 'items' } as const, [] as Item[])
const exported = atom({ plugin: 'followups', key: 'exported' } as const, '')

const PANE = 'followups'
const PANE_TITLE = 'To-do'
const TOOL = 'mcp__followups__flag'

// The model reads this in every request: when to flag, and when not to.
const GUIDANCE = `# Follow-ups
While you work you may notice things outside the task at hand that need attention later: a bug or broken behavior in nearby code, a failing or flaky test you didn't cause, a missing or stale doc, a TODO/FIXME, a security or performance concern, a config that looks wrong, or a step you skipped. The person tends to lose these if they aren't written down.
When you notice one, call ${TOOL} once for it, with a short imperative title ("Fix the flaky upload test") and a one-line detail; add \`where\` (file:line, command, URL) when there is one. The tool stops and asks the person in a dialog whether to keep it and returns their answer, so don't ask them yourself. Don't fix it unless they asked, and keep going with the task. Don't flag the task you were asked to do, its normal next steps, or something you are about to fix anyway.`

// Where each export goes, and the heading its section gets there.
const TARGETS = {
  memory: { label: 'Memory', path: 'CLAUDE.md', heading: '## Open follow-ups', note: 'Claude reads this at the start of every session.' },
  docs: { label: 'Docs', path: 'docs/FOLLOW-UPS.md', heading: '# Follow-ups', note: '' },
  readme: { label: 'README', path: 'README.md', heading: '## Known issues & follow-ups', note: '' },
} as const
type Target = keyof typeof TARGETS

const START = '<!-- followups:start -->'
const END = '<!-- followups:end -->'

// ---------- helpers ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const newId = (at: number) => `${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// Exports and the saved list belong to the project, so both key on its root.
const storeKey = async ($: EngineInterface) => `items:${await $.session.root()}`

async function save($: EngineInterface) {
  await $.store.set(await storeKey($), await read($, items))
}

const ADD = 'Add to to-do'
const SKIP = 'Not needed'

// Stops the turn on the engine's own question dialog and answers the tool with what the person
// chose. Typing under "Other" keeps it under their wording. A dismissed dialog (or a run with
// no one to ask) leaves the flag in the band above the prompt, so it is never lost.
async function ask($: EngineInterface, flag: Flag): Promise<string> {
  const extra = [flag.detail, flag.where].filter(Boolean).join(' · ')
  let answer: string
  try {
    answer = await $.ui.ask(`Claude noticed: "${flag.title}"${extra ? ` (${extra})` : ''}. Add it to your follow-ups?`, {
      header: 'Follow-up',
      options: [ADD, SKIP],
    })
  } catch {
    answer = ''
  }
  if (!answer.trim()) {
    await update($, pending, list => [...list, flag])
    return `The person didn't answer; "${flag.title}" waits above the prompt for them. Carry on with the task.`
  }
  if (answer === SKIP) return `The person skipped "${flag.title}". Don't flag or raise it again. Carry on with the task.`
  const kept = answer === ADD ? flag : { ...flag, title: clip(answer.trim(), 120) }
  await keep($, [kept])
  return `The person added "${kept.title}" to their follow-ups. Don't fix it now unless they ask. Carry on with the task.`
}

async function keep($: EngineInterface, flags: Flag[]) {
  if (!flags.length) return
  const ids = new Set(flags.map(f => f.id))
  await update($, pending, list => list.filter(f => !ids.has(f.id)))
  await update($, items, list => [...list, ...flags.map(f => ({ ...f, isDone: false }))])
  await save($)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
}

// The markdown an export writes: the items as a checklist between two markers.
export function section(target: Target, list: Item[]): string {
  const t = TARGETS[target]
  const lines = list.map(i => {
    const extra = [i.detail, i.where && `\`${i.where}\``].filter(Boolean).join(' · ')
    return `- [${i.isDone ? 'x' : ' '}] ${i.title}${extra ? ` — ${extra}` : ''}`
  })
  return [START, t.heading, '', ...(t.note ? [`_${t.note}_`, ''] : []), ...lines, END].join('\n')
}

// Puts the section in the file: in place of an earlier export, else at the end. Only a START…END
// pair counts (END after START); a stray END before it is ignored, so a re-export stays one block.
export function upsert(text: string, block: string): string {
  const first = text.indexOf(START)
  const b = first === -1 ? -1 : text.indexOf(END, first + START.length)
  const a = b === -1 ? -1 : text.lastIndexOf(START, b)
  if (a !== -1 && b !== -1) return text.slice(0, a) + block + text.slice(b + END.length)
  return text.trim() ? `${text.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`
}

async function exportTo($: EngineInterface, target: Target) {
  const list = await read($, items)
  const t = TARGETS[target]
  if (!list.length) return update($, exported, () => 'Nothing to export yet.')
  try {
    const path = `${(await $.session.root()).replace(/[\\/]$/, '')}/${t.path}`
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, upsert(typeof before === 'string' ? before : '', section(target, list)))
    await update($, exported, () => `Exported ${list.length} to ${t.path}`)
    $.ui.toast(`Follow-ups exported to ${t.path}`)
  } catch (err) {
    await update($, exported, () => `Couldn't write ${t.path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'flag',
      description: 'Flag something you noticed that needs attention later (outside the current task). The person is asked in a dialog whether to add it to their follow-up to-do list; the result is their answer.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, e.g. "Fix the flaky upload test"' },
          detail: { type: 'string', description: 'One line: what is wrong and why it matters' },
          where: { type: 'string', description: 'Optional file:line, command or URL' },
        },
        required: ['title'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'followups', description: 'Show the follow-up to-do list' })
    await $.command.register({ name: 'followup', description: 'Add a follow-up to the to-do list', argumentHint: '<what to do>' })
    // Items kept in this folder before carry over to a new session.
    if (!(await read($, items)).length) {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved) && saved.length) await update($, items, () => saved as Item[])
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { sections: [...r.sections, { id: 'followups:guidance', text: GUIDANCE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; detail?: unknown; where?: unknown }
    const title = clip(String(input.title ?? '').trim(), 120)
    if (!title) return { deny: 'A follow-up needs a title.' }
    const known = [...(await read($, pending)), ...(await read($, items))]
    if (known.some(f => norm(f.title) === norm(title))) {
      return { result: `Already flagged: "${title}". No need to flag it again.` }
    }
    const at = await $.clock.now()
    const flag: Flag = {
      id: newId(at),
      title,
      detail: clip(String(input.detail ?? '').trim(), 300),
      where: clip(String(input.where ?? '').trim(), 160),
      at,
    }
    return { result: await ask($, flag) }
  })

  on('command.run', { command: 'followups' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Follow-ups pane opened.' }
  })

  on('command.run', { command: 'followup' }, async ($, e) => {
    const title = clip(e.args.trim(), 120)
    if (!title) return { text: 'Usage: /followup <what to do>' }
    const known = [...(await read($, pending)), ...(await read($, items))]
    if (known.some(f => norm(f.title) === norm(title))) return { text: `Already flagged: "${title}". No need to add it again.` }
    const at = await $.clock.now()
    await keep($, [{ id: newId(at), title, detail: '', where: '', at }])
    return { text: `Added to follow-ups: ${title}` }
  })

  // ---------- the band: Claude asks ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    const flag = list[0]
    if (e.props.hasSurvey || !flag) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const more = list.length - 1
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="#e08a1e" bold>◆ Claude noticed something. Track it?</Text>
            {more ? <Text dimColor>{`(+${more} more)`}</Text> : null}
          </Box>
          <Text bold wrap="truncate-end">{`  ${flag.title}`}</Text>
          {flag.detail ? <Text dimColor wrap="truncate-end">{`  ${flag.detail}`}</Text> : null}
          {flag.where ? <Text dimColor wrap="truncate-end">{`  ${flag.where}`}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button key="add" label="Add to to-do" hotkey="a" variant="primary" onPress={() => keep($, [flag])} />
            <Button key="skip" label="Skip" hotkey="s" onPress={() => update($, pending, l => l.filter(f => f.id !== flag.id))} />
            {more ? <Button key="add-all" label={`Add all ${list.length}`} onPress={async () => keep($, await read($, pending))} /> : null}
          </Box>
        </Box>
        {below}
      </Box>
    )
  })

  // ---------- the pane: the to-do and its export ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const note = await read($, exported)
    const open = list.filter(i => !i.isDone).length
    const toggle = (id: string) => async () => {
      await update($, items, l => l.map(i => (i.id === id ? { ...i, isDone: !i.isDone } : i)))
      await save($)
    }
    const remove = (id: string) => async () => {
      await update($, items, l => l.filter(i => i.id !== id))
      await save($)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>☑ To-do</Text>
          <Text dimColor>{list.length ? `${open} open · ${list.length - open} done` : ''}</Text>
        </Box>
        {list.length ? (
          <Box flexDirection="column">
            {list.map(i => (
              <Box key={`row-${i.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Button key={`t-${i.id}`} label={`${i.isDone ? '✓' : '○'} ${i.title}`} plain onPress={toggle(i.id)} />
                  <Button key={`x-${i.id}`} label="✕" plain onPress={remove(i.id)} />
                </Box>
                {!i.isDone && (i.detail || i.where) ? (
                  <Text dimColor wrap="truncate-end">{`   ${[i.detail, i.where].filter(Boolean).join(' · ')}`}</Text>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : (
          <Text dimColor>Nothing tracked yet. When Claude spots something, it asks above the prompt. /followup adds one by hand.</Text>
        )}
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>Export to</Text>
            {(Object.keys(TARGETS) as Target[]).map(t => (
              <Button key={`export-${t}`} label={TARGETS[t].label} onPress={() => exportTo($, t)} />
            ))}
            {list.some(i => i.isDone) ? (
              <Button key="clear-done" label="Clear done" plain onPress={async () => {
                await update($, items, l => l.filter(i => !i.isDone))
                await save($)
              }} />
            ) : null}
          </Box>
          <Text dimColor>{note || 'Memory → CLAUDE.md · Docs → docs/FOLLOW-UPS.md · README → README.md'}</Text>
        </Box>
      </Box>
    )
  })
}
