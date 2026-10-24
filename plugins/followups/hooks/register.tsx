import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flag, Item, Status } from '../types'

// ---------- state ----------

const pending = atom({ plugin: 'followups', key: 'pending' } as const, [] as Flag[])
const items = atom({ plugin: 'followups', key: 'items' } as const, [] as Item[])
const exported = atom({ plugin: 'followups', key: 'exported' } as const, '')
const skipped = atom({ plugin: 'followups', key: 'skipped' } as const, [] as string[])
// The list as this session last loaded or saved it, to merge with another session's saves.
const base = atom({ plugin: 'followups', key: 'base' } as const, [] as Item[])

const PANE = 'followups'
const PANE_TITLE = 'To-do'
const TOOL = 'mcp__followups__flag'
const DONE_TOOL = 'mcp__followups__done'

// One accent for the header; status colors for the rows (all read on light and dark themes).
const ACCENT = '#4f7cff'
const COLOR = { open: '#e08a1e', in_progress: '#2a9fd6', done: '#1f9d6b', bug: '#e5484d' } as const
const MARK = { open: '○', in_progress: '◐', done: '✓' } as const

// The model reads this in every request: when to flag, and when not to.
const GUIDANCE = `# Follow-ups
While you work you may notice things outside the task at hand that need attention later: a bug or broken behavior in nearby code, a failing or flaky test you didn't cause, a missing or stale doc, a TODO/FIXME, a security or performance concern, a config that looks wrong, or a step you skipped. The person tends to lose these if they aren't written down.
Before you end a turn, look back over it: anything you noticed, worked around, left unverified or put off for later that the person would want to come back to gets flagged now, even when you also mention it in your reply. Findings in a subagent's or worker's report count too: flag them before your final reply.
When you notice one, call ${TOOL} once for it, with a short imperative title ("Fix the flaky upload test") and a one-line detail; add \`where\` (file:line, command, URL) when there is one. Set kind to "bug" when the thing is broken behavior (a bug, a failing test, a crash, wrong output); leave kind out for ordinary tasks. The tool stops and asks the person in a dialog whether to keep it and returns their answer, so don't ask them yourself. Don't fix it unless they asked, and keep going with the task. Don't flag the task you were asked to do, its normal next steps, or something you are about to fix anyway.
When a message says it started a to-do item and gives its id, do that work, and when it is finished call ${DONE_TOOL} with that id (and a short note of what you did). Call ${DONE_TOOL} only for items started that way; never for unrelated work, and not before the work is actually done.`

// Words that mark a reply as leaving something open. Narrow on purpose (a false stop costs a turn),
// so extend it one phrase at a time. Left out as too common: "בהמשך" ("later", but also "following
// that") and "follow-up" / "follow up" (this mod's own word, in nearly every reply about it).
export const STOP_PHRASES = [
  'not verified', 'unverified', 'not tested', 'untested', 'no coverage', 'left open', 'still open', 'known gap',
  'open question', 'open questions', 'unsure about', 'unsure-about',
  'לא אומת', 'לא נבדק', 'לא נבדקו', 'פער', 'פריט המשך', 'שאלה פתוחה', 'שאלות פתוחות',
]
export const STOP_MESSAGE = 'You mentioned items that need follow-up. Call mcp__followups__flag for each, or say there are none.'

// What the after-answer check asks a small model: what in this answer was left open.
export const SWEEP_RULES = `You read the final reply an AI coding assistant just gave, with any reports its sub-agents handed it this turn, and list the follow-ups in them: problems or loose ends mentioned but left open, which the person could lose track of.
Count: a bug or broken behavior, a failing or flaky test, a missing or stale doc, a TODO or FIXME, a security or performance concern, a config that looks wrong, a step that was skipped, something left unverified or untested, something put off for later, or an open question or decision that came up and wasn't settled.
Don't count: the work that was done, a yes/no question about going ahead with the very next step, an offer to do the next step now, or anything in the already-tracked list.
Answer with a JSON array only, at most 3 entries, each {"title": "short imperative, under 80 characters", "detail": "one line, under 160 characters", "where": "file:line, command or URL, or empty", "kind": "bug" or "task"}. Answer [] when there is nothing.`
// Answers shorter than this rarely leave anything open; skipping them saves a call per short turn.
const SWEEP_MIN_CHARS = 200

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
export const isStatus = (s: unknown): s is Status => s === 'open' || s === 'in_progress' || s === 'done'

// Items saved before statuses existed carry isDone; map them to a status.
export function migrate(saved: unknown): Item[] {
  if (!Array.isArray(saved)) return []
  return saved.map((raw: Record<string, unknown>) => {
    const { isDone, ...rest } = raw
    const status: Status = isStatus(raw.status) ? raw.status : isDone === true ? 'done' : 'open'
    return { ...rest, status, kind: raw.kind === 'bug' ? 'bug' : 'task' } as Item
  })
}

// The reply without fenced code blocks (an unclosed fence runs to the end) and inline code.
export function prose(text: string): string {
  return outsideFences(text).join('\n').replace(/``[^\n]*?``/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

// The lines of a reply outside fenced code blocks (an unclosed fence runs to the end).
function outsideFences(text: string): string[] {
  const out: string[] = []
  let fence = ''
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length) fence = ''
    } else if (m) fence = m[1]!
    else out.push(line)
  }
  return out
}

// The names a report gives what it leaves open (the model router's routed-worker writes Unsure-about,
// with its Open questions there), and the other sections a label heading may name.
const OPEN_SECTIONS = ['open questions', 'open question', 'open items', 'unsure-about', 'unsure about', 'שאלות פתוחות']
const LABEL_SECTIONS = [...OPEN_SECTIONS, 'findings', 'files', 'changes', 'summary', 'notes', 'next steps', 'deliverable']
const NONE = /^(?:none|nothing|n\/?a|no|אין|ללא)\.?$/iu
// "Open questions: none" says nothing is open: the stop check reads past it.
const OPEN_NONE = /(?:open questions?|open items|unsure[- ]about|שאלות פתוחות|שאלה פתוחה)\**\s*[:—-]?\s*\**\s*(?:none|nothing|n\/?a|אין|ללא)(?![\p{L}\p{N}])\.?/giu

// A section heading: "## Name" (any name), or a label of a known section ("**Name:**", "Name:", "3. Name:"),
// with whatever follows its colon on the same line.
function headingOf(line: string): { name: string; rest: string } | null {
  const hash = /^\s*#{1,6}\s+\**([^*:]+?)\**\s*:?\s*$/u.exec(line)
  if (hash) return { name: hash[1]!.trim().toLowerCase(), rest: '' }
  const label = /^\s*(?:\d+\.\s+)?\**([\p{L}][\p{L} -]{1,30}?)\**\s*:\**\s*(.*)$/u.exec(line)
  if (label && LABEL_SECTIONS.includes(label[1]!.trim().toLowerCase())) {
    return { name: label[1]!.trim().toLowerCase(), rest: label[2]!.replace(/\*+$/, '').trim() }
  }
  return null
}

// The items under a report's open-questions section, one per bullet or numbered line (or the text
// after its label); "none" and its kin give nothing. At most 5.
export function openItems(text: string): string[] {
  const out: string[] = []
  const add = (raw: string) => {
    const item = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim()
    if (item && !NONE.test(item)) out.push(clip(item, 200))
  }
  let isOpen = false
  for (const line of outsideFences(text)) {
    const h = headingOf(line)
    if (h) {
      isOpen = OPEN_SECTIONS.includes(h.name)
      if (isOpen && h.rest) add(h.rest)
    } else if (isOpen && line.trim()) add(line)
  }
  return out.slice(0, 5)
}

// Phrases as whole words in the prose of a reply, any case. Subagent reports relayed in it count too.
export function leftOpen(text: string, phrases: string[] = STOP_PHRASES): string[] {
  const body = prose(text).replace(OPEN_NONE, ' ')
  return phrases.filter(p => {
    const src = p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    return !!src && new RegExp(`(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`, 'iu').test(body)
  })
}

export function sweepPrompt(answer: string, known: string[], reports: string[] = []): string {
  return [
    'Already tracked (skip these):',
    ...(known.length ? known.map(t => `- ${t}`) : ['- (none)']),
    '',
    ...reports.flatMap(r => ['A sub-agent\'s report:', '<report>', r.slice(-6_000), '</report>', '']),
    'The reply:',
    '<reply>',
    answer.slice(-12_000),
    '</reply>',
  ].join('\n')
}

// The small model's answer, read leniently: the first JSON array in it, only well-formed entries.
export function parseFindings(text: string): Omit<Flag, 'id' | 'at'>[] {
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a === -1 || b < a) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(a, b + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { title?: unknown }).title === 'string')
    .map(f => ({
      title: clip(String(f.title).trim(), 120),
      detail: clip(String(f.detail ?? '').trim(), 300),
      where: clip(String(f.where ?? '').trim(), 160),
      kind: f.kind === 'bug' ? ('bug' as const) : ('task' as const),
    }))
    .filter(f => f.title)
    .slice(0, 3)
}

// Everything already flagged, kept or turned down, normalised for comparing titles.
async function knownTitles($: EngineInterface): Promise<Set<string>> {
  const all = [...(await read($, pending)), ...(await read($, items))].map(f => norm(f.title))
  return new Set([...all, ...(await read($, skipped))])
}

// Reads a finished answer for loose ends Claude mentioned but didn't flag, and offers them in the band.
// The look runs quietly; when it can't run at all, the person is told once per session.
let isWarned = false
function warn($: EngineInterface, why: string) {
  if (isWarned) return
  isWarned = true
  $.ui.log(`followups: the look for loose ends after each answer couldn't run (${why}), so they aren't offered above the prompt. Claude's own flags and the end-of-turn check still work.`)
}

async function sweep($: EngineInterface, answer: string, reports: string[]) {
  const known = await knownTitles($)
  let r
  try {
    r = await $.model.complete({ model: 'haiku', system: SWEEP_RULES, prompt: sweepPrompt(answer, [...known], reports), maxTokens: 600, effort: 'low', timeoutMs: 20_000 })
  } catch (err) {
    return warn($, err instanceof Error ? err.message : String(err))
  }
  if (!r.isAnswered) {
    // An interrupted look (the person moved on) isn't a fault worth a line.
    if (r.reason !== 'aborted') warn($, r.reason === 'api-error' ? `api-error ${r.status ?? ''}`.trim() : r.reason)
    return
  }
  const fresh = await knownTitles($)
  const found = parseFindings(r.text).filter(f => !fresh.has(norm(f.title)))
  if (!found.length) return
  const at = await $.clock.now()
  await update($, pending, l => [...l, ...found.map(f => ({ ...f, id: newId(at), at }))])
  $.ui.toast(found.length === 1 ? 'Claude noticed a possible follow-up: see above the prompt' : `Claude noticed ${found.length} possible follow-ups: see above the prompt`)
}

// A sub-agent's report that names open questions has them offered in the band at once: read
// straight from its section, no model, so it works where the after-answer look can't run.
// Resolves how many it offered.
async function offerOpenItems($: EngineInterface, report: string): Promise<number> {
  const known = await knownTitles($)
  const fresh = openItems(report).filter(t => !known.has(norm(clip(t, 120))))
  if (!fresh.length) return 0
  const at = await $.clock.now()
  const flags: Flag[] = fresh.map(t => ({ id: newId(at), kind: 'task', title: clip(t, 120), detail: "From a sub-agent's open questions", where: '', at }))
  await update($, pending, l => [...l, ...flags])
  $.ui.toast(fresh.length === 1 ? 'A sub-agent left an open question: see above the prompt' : `A sub-agent left ${fresh.length} open questions: see above the prompt`)
  return fresh.length
}

const newId = (at: number) => `${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// Exports and the saved list belong to the project, so both key on its root.
const storeKey = async ($: EngineInterface) => `items:${await $.session.root()}`

// A three-way merge with what another session in the same project saved meanwhile. `base` is the
// list as this session last loaded or saved it: what changed here since wins, what changed only
// there is taken, and an item either side deleted stays deleted.
export function mergeLists<T extends { id: string }>(base: T[], mine: T[], stored: T[]): T[] {
  const was = new Map(base.map(i => [i.id, JSON.stringify(i)]))
  const there = new Map(stored.map(i => [i.id, i]))
  const held = new Set(mine.map(i => i.id))
  const kept = mine.flatMap(i => {
    if (was.get(i.id) !== JSON.stringify(i)) return [i]
    const other = there.get(i.id)
    return other ? [other] : []
  })
  return [...kept, ...stored.filter(i => !held.has(i.id) && !was.has(i.id))]
}

async function save($: EngineInterface) {
  const key = await storeKey($)
  const saved = await $.store.get(key)
  const from = await read($, base)
  const stored = Array.isArray(saved) ? migrate(saved) : from
  const merged = await update($, items, mine => mergeLists(from, mine, stored))
  await $.store.set(key, merged)
  await update($, base, () => merged)
}

// What the person turned down, kept per project like the list, so it isn't offered again later.
const skippedKey = async ($: EngineInterface) => `skipped:${await $.session.root()}`

async function turnDown($: EngineInterface, title: string) {
  const t = norm(title)
  // Another session in the folder may have turned things down meanwhile: the list only grows, so join them.
  const key = await skippedKey($)
  const saved = await $.store.get(key)
  const there = Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : []
  const list = await update($, skipped, l => [...new Set([...there, ...l, t])])
  await $.store.set(key, list)
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
    answer = await $.ui.ask(`Claude noticed${flag.kind === 'bug' ? ' a bug' : ''}: "${flag.title}"${extra ? ` (${extra})` : ''}. Add it to your follow-ups?`, {
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
  if (answer === SKIP) {
    await turnDown($, flag.title)
    return `The person skipped "${flag.title}". Don't flag or raise it again. Carry on with the task.`
  }
  const kept = answer === ADD ? flag : { ...flag, title: clip(answer.trim(), 120) }
  await keep($, [kept])
  return `The person added "${kept.title}" to their follow-ups. Don't fix it now unless they ask. Carry on with the task.`
}

async function keep($: EngineInterface, flags: Flag[]) {
  if (!flags.length) return
  const ids = new Set(flags.map(f => f.id))
  await update($, pending, list => list.filter(f => !ids.has(f.id)))
  // By id, inside the update: two presses before a redraw both carry the same flag.
  await update($, items, list => {
    const have = new Set(list.map(i => i.id))
    return [...list, ...flags.filter(f => !have.has(f.id)).map(f => ({ ...f, kind: f.kind ?? 'task', status: 'open' as const }))]
  })
  await save($)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
}

// The message that starts an item: names it, carries the id, and says how to report back.
export function startPrompt(list: Item[]): string {
  const one = (i: Item) =>
    `- id ${i.id}: ${i.title}${i.kind === 'bug' ? ' (bug)' : ''}${i.detail ? ` — ${i.detail}` : ''}${i.where ? ` [where: ${i.where}]` : ''}`
  return [
    list.length === 1 ? 'Start this item from my to-do list:' : `Start these ${list.length} items from my to-do list, one after the other:`,
    ...list.map(one),
    `Do the work. When an item is finished, call ${DONE_TOOL} with its id (and a short note). Don't call it for anything else.`,
  ].join('\n')
}

async function setStatus($: EngineInterface, ids: Set<string>, status: Status) {
  await update($, items, l => l.map(i => (ids.has(i.id) ? { ...i, status } : i)))
  await save($)
}

async function start($: EngineInterface, which: Item[]) {
  if (!which.length) return
  await setStatus($, new Set(which.map(i => i.id)), 'in_progress')
  // A turn of its own once the session is idle; it may not resolve until then, so not awaited. If
  // it can't be sent, the items go back to open, where their Start button is.
  $.prompt.submit({ text: startPrompt(which) }).catch(() => setStatus($, new Set(which.map(i => i.id)), 'open'))
}

// The markdown an export writes: the items as a checklist between two markers.
export function section(target: Target, list: Item[]): string {
  const t = TARGETS[target]
  const lines = list.map(i => {
    const extra = [i.detail, i.where && `\`${i.where}\``].filter(Boolean).join(' · ')
    const tags = `${i.kind === 'bug' ? ' _(bug)_' : ''}${i.status === 'in_progress' ? ' _(in progress)_' : ''}`
    return `- [${i.status === 'done' ? 'x' : ' '}] ${i.title}${tags}${extra ? ` — ${extra}` : ''}`
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

export const register: Register = (on, options) => {
  const autoDetect = String(options.autoDetect ?? 'on') !== 'off'
  const openOnStart = String(options.openOnStart ?? 'on') !== 'off'
  const stopCheck = String(options.stopCheck ?? 'on') !== 'off'
  // The module's own, per turn: a person is at the prompt, flag was called, the check already stopped once.
  let isInteractive = false
  let isFlagged = false
  let isBlocked = false
  // Sub-agents' final reports since the main loop's last answer: the work, and its loose ends, is often there.
  let reports: string[] = []

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await $.tool.register({
      name: 'flag',
      description: 'Flag something you noticed that needs attention later, outside the current task: a bug or broken behavior, a failing or flaky test, a missing or stale doc, a TODO/FIXME, a security or performance concern, a step you skipped, or something you left unverified or put off. Call it as soon as you notice one (once per item), and before ending a turn for any you mention in your reply; the person tends to lose these otherwise. Not for the task itself or its normal next steps. The person is asked in a dialog whether to add it to their follow-up to-do list; the result is their answer.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, e.g. "Fix the flaky upload test"' },
          detail: { type: 'string', description: 'One line: what is wrong and why it matters' },
          where: { type: 'string', description: 'Optional file:line, command or URL' },
          kind: { type: 'string', enum: ['bug', 'task'], description: 'bug for broken behavior; task (default) for anything else' },
        },
        required: ['title'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'done',
      description: 'Mark a to-do item finished. Call it when you finish an item the person started from their to-do list (the message gave its id), never for unrelated work.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The item id from the start message' },
          note: { type: 'string', description: 'Optional: what you did' },
        },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'followups', description: 'Show the follow-up to-do list' })
    await $.command.register({ name: 'followup', description: 'Add a follow-up to the to-do list', argumentHint: '<what to do>' })
    // $.state outlives a reload, so a list an older version held is migrated in place too.
    const held = await read($, items)
    if (held.some(i => !isStatus((i as { status?: unknown }).status))) await update($, items, l => migrate(l))
    // Items kept in this folder before carry over to a new session.
    if (!held.length) {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved) && saved.length) {
        const list = migrate(saved)
        await update($, items, () => list)
        await update($, base, () => list)
      }
    }
    const turnedDown = await $.store.get(await skippedKey($))
    if (Array.isArray(turnedDown)) {
      const fromStore = turnedDown.filter((t): t is string => typeof t === 'string')
      await update($, skipped, l => [...new Set([...fromStore, ...l])])
    }
    // Open work left from an earlier session is shown, so it isn't forgotten.
    if (openOnStart && (await read($, items)).some(i => i.status !== 'done')) void $.ui.open({ id: PANE, title: PANE_TITLE })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { sections: [...r.sections, { id: 'followups:guidance', text: GUIDANCE, scope: 'session' as const }] }
  })

  // A new turn from the person (a continuation after a stop has no text) starts the check afresh.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      isFlagged = false
      isBlocked = false
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    isFlagged = true // any call counts, even one the person turns down
    const input = e as unknown as { title?: unknown; detail?: unknown; where?: unknown; kind?: unknown }
    const title = clip(String(input.title ?? '').trim(), 120)
    if (!title) return { deny: 'A follow-up needs a title.' }
    if ((await read($, skipped)).includes(norm(title))) {
      return { result: `The person already said "${title}" isn't needed. Don't raise it again.` }
    }
    const known = [...(await read($, pending)), ...(await read($, items))]
    if (known.some(f => norm(f.title) === norm(title))) {
      return { result: `Already flagged: "${title}". No need to flag it again.` }
    }
    const at = await $.clock.now()
    const flag: Flag = {
      id: newId(at),
      kind: input.kind === 'bug' ? 'bug' : 'task',
      title,
      detail: clip(String(input.detail ?? '').trim(), 300),
      where: clip(String(input.where ?? '').trim(), 160),
      at,
    }
    return { result: await ask($, flag) }
  })

  on('tool.call', { tool: DONE_TOOL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; note?: unknown }
    const ref = String(input.id ?? '').trim()
    const list = await read($, items)
    const item = list.find(i => i.id === ref) ?? list.find(i => ref && norm(i.title) === norm(ref))
    if (!item) return { deny: `No to-do item with id "${ref}". Use the id from the start message.` }
    if (item.status === 'done') return { result: `"${item.title}" is already done. Nothing to change.` }
    await setStatus($, new Set([item.id]), 'done')
    const note = clip(String(input.note ?? '').trim(), 200)
    $.ui.toast(`Done: ${item.title}`)
    return { result: `Marked "${item.title}" done${note ? ` (${note})` : ''}.` }
  })

  // After a main-loop answer, look it over for loose ends Claude didn't flag. Run from a timer so
  // the end of the turn never waits on the extra model call.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      if (e.reason === 'answer' && e.answer.trim()) {
        reports = [...reports, e.answer.trim()].slice(-4)
        // Offered in the band: the stop check needn't send Claude back to flag them again.
        if (await offerOpenItems($, e.answer)) isFlagged = true
      }
      return r
    }
    const taken = reports
    reports = []
    // A turn the Stop check sent back has had Claude go over its own reply: a second reading would
    // only offer the same loose ends again under other titles.
    const chars = [e.answer, ...taken].join('\n').trim().length
    if (autoDetect && !isBlocked && e.reason === 'answer' && chars >= SWEEP_MIN_CHARS) {
      const answer = e.answer
      $.clock.after(0, () => sweep($, answer, taken).catch(err => warn($, err instanceof Error ? err.message : String(err))))
    }
    return r
  })

  // The end of the main loop's turn: when the reply names something left open and flag wasn't called,
  // stop it once with a nudge. classic.Stop is the one event that can send Claude back to work
  // (`block`); turn.complete only reads. Without a person at the prompt, nobody could answer, so no check.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (!stopCheck || !isInteractive || isFlagged || isBlocked || e.stop_hook_active || r.block) return r
    if (!leftOpen(e.last_assistant_message ?? '').length) return r
    isBlocked = true
    return { ...r, block: STOP_MESSAGE }
  }).catch(($, e, next) => (next.called ? next(e) : {}))

  on('command.run', { command: 'followups' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Follow-ups pane opened.' }
  })

  on('command.run', { command: 'followup' }, async ($, e) => {
    const title = clip(e.args.trim(), 120)
    if (!title) return { text: 'Usage: /followup <what to do>' }
    const tracked = (await read($, items)).find(i => norm(i.title) === norm(title))
    if (tracked) return { text: `Already in your follow-ups: "${tracked.title}".` }
    // A flag still waiting in the band is what the person means: keep it, detail and all.
    const waiting = (await read($, pending)).find(f => norm(f.title) === norm(title))
    if (waiting) {
      await keep($, [waiting])
      return { text: `Added to follow-ups: ${waiting.title}` }
    }
    const at = await $.clock.now()
    await keep($, [{ id: newId(at), kind: 'task', title, detail: '', where: '', at }])
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
            <Button key="skip" label="Skip" hotkey="s" onPress={async () => {
              await update($, pending, l => l.filter(f => f.id !== flag.id))
              await turnDown($, flag.title)
            }} />
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
    const count = (st: Status) => list.filter(i => i.status === st).length
    const [open, doing, done] = [count('open'), count('in_progress'), count('done')]
    const toggle = (id: string) => async () => {
      await update($, items, l => l.map(i => (i.id === id ? { ...i, status: i.status === 'done' ? ('open' as const) : ('done' as const) } : i)))
      await save($)
    }
    const remove = (id: string) => async () => {
      await update($, items, l => l.filter(i => i.id !== id))
      await save($)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold color={ACCENT}>☑ To-do</Text>
          <Text dimColor>{list.length ? `${open} open · ${doing} in progress · ${done} done` : ''}</Text>
          {open > 1 ? <Button key="start-all" label="▶ Start all open" plain onPress={() => start($, list.filter(i => i.status === 'open'))} /> : null}
        </Box>
        {list.length ? (
          <Box flexDirection="column">
            {list.map(i => (
              <Box key={`row-${i.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexDirection="row" gap={1}>
                    {i.kind === 'bug' ? <Text color={COLOR.bug} bold>🐞</Text> : null}
                    <Text color={COLOR[i.status]}>{MARK[i.status]}</Text>
                    <Text color={COLOR[i.status]} dimColor={i.status === 'done'} strikethrough={i.status === 'done'} wrap="truncate-end">{i.title}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    {i.status === 'open' ? <Button key={`s-${i.id}`} label="▶ Start" plain onPress={() => start($, [i])} /> : null}
                    <Button key={`t-${i.id}`} label={i.status === 'done' ? '↺ Reopen' : '✓ Done'} plain onPress={toggle(i.id)} />
                    <Button key={`x-${i.id}`} label="✕" plain onPress={remove(i.id)} />
                  </Box>
                </Box>
                {i.status !== 'done' && (i.detail || i.where) ? (
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
            {list.some(i => i.status === 'done') ? (
              <Button key="clear-done" label="Clear done" plain onPress={async () => {
                await update($, items, l => l.filter(i => i.status !== 'done'))
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
