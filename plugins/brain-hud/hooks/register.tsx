import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

import type { Brain, EntryType, Folder, Offer, Pulse, PulseKind } from '../types'
import { faceText, KIND_COLOR, SCENE, sceneSvg } from './art'
import { GRAPH, graphSvg, routeOf } from './graph'
import type { Theme } from './graph'
import { diffBrain, FOLDERS, SKILL, lessonCount, logPrompt, paraStats, parseMemory, parseMistakes, unrouted, withListing } from './brain'
import type { ParaFile } from './brain'
import { clockTime, contextLine, HANDOFF_TITLE, hasLoose, handoffEntry, insertBelowMarker, journalDoc, journalFile, JOURNAL_DIR, JOURNAL_LAST, journalText, looseEnds, stampOf, workerEntry } from './journal'
import type { JournalEntry, JournalKind } from './journal'
import { GOAL_REACHED, parseDoneResult, parseGoalClosedNote, parseGoalPrompt, parseStartPrompt, takeOverArgs, toolText } from './texts'

const brain = atom({ plugin: 'brain-hud', key: 'brain' } as const, null as Brain | null)
const pulse = atom({ plugin: 'brain-hud', key: 'pulse' } as const, null as Pulse | null)
const frame = atom({ plugin: 'brain-hud', key: 'frame' } as const, 0)
const offers = atom({ plugin: 'brain-hud', key: 'offers' } as const, [] as Offer[])
const open = atom({ plugin: 'brain-hud', key: 'open' } as const, ['Inbox'] as string[])
const canFollow = atom({ plugin: 'brain-hud', key: 'canFollow' } as const, false)
const started = atom({ plugin: 'brain-hud', key: 'started' } as const, [] as { id: string; title: string; isBug: boolean }[])
const goalText = atom({ plugin: 'brain-hud', key: 'goalText' } as const, '')
const paneShown = atom({ plugin: 'brain-hud', key: 'paneShown' } as const, false)
const more = atom({ plugin: 'brain-hud', key: 'more' } as const, '')
const theme = atom({ plugin: 'brain-hud', key: 'theme' } as const, 'dark' as Theme)
const routeLater = atom({ plugin: 'brain-hud', key: 'routeLater' } as const, 0)
const journal = atom({ plugin: 'brain-hud', key: 'journal' } as const, [] as JournalEntry[])
// How many journal entries the main agent was last told of, beside a prompt.
const told = atom({ plugin: 'brain-hud', key: 'told' } as const, 0)
const doneIds = atom({ plugin: 'brain-hud', key: 'doneIds' } as const, [] as string[])
const goalReached = atom({ plugin: 'brain-hud', key: 'goalReached' } as const, false)
const handedOff = atom({ plugin: 'brain-hud', key: 'handedOff' } as const, false)

const PANE = 'brain-hud'
const PANE_TITLE = 'Brain'
const MISTAKES = 'MISTAKES.md'
// The shared index first; projects set up before it was shared keep a per-harness one.
const MEMORY_PATHS = ['.agent-brain/shared/MEMORY.md', '.claude/agent-memory/claude/MEMORY.md']
const PARA_ROOT = '.agent-brain/shared'
const POLL_MS = 4_000
// In a project with no memory yet, the poll looks this often instead: a turn's end checks too.
const IDLE_POLL_MS = 32_000
const PULSE_MS = 6_000
const FRAME_MS = 160
const INBOX_SHOWN = 3
// Unrouted entries from which the band suggests routing them.
const ROUTE_AT = 3
const ACCENT = '#c96f97'

const FOLLOWUPS_DONE = 'mcp__followups__done'
const GOAL_PLAN = 'mcp__goal-run__plan'
const GOAL_UPDATE = 'mcp__goal-run__update'
const JOURNAL_TOOL = 'mcp__brain-hud__journal'
// The journal keeps this many entries; the oldest go first.
const JOURNAL_MAX = 200

const VERB: Record<PulseKind, string> = {
  mistake: 'Logged a mistake',
  success: 'Logged a success',
  decision: 'Logged a decision',
  handoff: 'Left a handoff',
  route: 'Filed into memory',
  promote: 'Promoted a rule',
  dream: 'Dreamed',
}

const timers: { cancel: () => void }[] = []
let anim: { cancel: () => void } | null = null
// The files' last modification times: a change made outside a tool call (the skill's own hooks,
// a script) is caught by the poll. A reload reads them again once, which shows nothing new.
let mtimes = ''
// Refreshes run one at a time, so an Edit and the poll that see the same change show it once.
let refreshing: Promise<void> = Promise.resolve()
// What each subagent was asked, by its id, for its report's journal line.
const spawns = new Map<string, { task: string; type: string }>()
// Tool calls already journaled: a call is seen at tool.call and again at classic.PostToolUse.
const journaled = new Set<string>()
let journalOn = true
let handoffOn = true
// The journal file is written one write at a time, each with the whole journal.
let writing: Promise<void> = Promise.resolve()

const lessons = (n: number) => `${n} ${n === 1 ? 'lesson' : 'lessons'}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

async function rootPath($: EngineInterface, rel: string): Promise<string> {
  return `${(await $.session.root()).replace(/[\\/]$/, '')}/${rel}`
}

async function readOr($: EngineInterface, rel: string): Promise<string | null> {
  return $.fs.read(await rootPath($, rel)).then(t => String(t), () => null)
}

// The memory as it stands on disk, or null where the project has no mistake-brain memory.
async function scan($: EngineInterface): Promise<Brain | null> {
  const mistakes = await readOr($, MISTAKES)
  let memory: string | null = null
  let index: string | null = null
  for (const p of MEMORY_PATHS) {
    memory = await readOr($, p)
    if (memory !== null) {
      index = p
      break
    }
  }
  if (mistakes === null && memory === null) return null
  const parsed = parseMemory(memory ?? '')
  // Each PARA file is read too, so its lessons are counted from the file itself.
  const onDisk: Partial<Record<Folder, ParaFile[]>> = {}
  for (const f of FOLDERS) {
    const list = await $.fs.list(await rootPath($, `${PARA_ROOT}/${f}`)).catch(() => [])
    const files: ParaFile[] = []
    for (const x of list.filter(x => x.kind === 'file' && x.name.endsWith('.md'))) {
      const text = await readOr($, `${PARA_ROOT}/${f}/${x.name}`)
      files.push(text === null ? { file: x.name, lessons: -1, updated: '', summary: '' } : paraStats(x.name, text))
    }
    onDisk[f] = files
  }
  return { ...parsed, folders: withListing(parsed.folders, onDisk), entries: parseMistakes(mistakes ?? ''), index }
}

async function stamp($: EngineInterface): Promise<string> {
  const parts: string[] = []
  for (const p of [MISTAKES, ...MEMORY_PATHS]) {
    const st = await $.fs.stat(await rootPath($, p)).catch(() => null)
    parts.push(st ? `${st.mtimeMs}:${st.size}` : '-')
  }
  // The PARA files too: a lesson can land there with no change to the index.
  for (const f of FOLDERS) {
    const list = await $.fs.list(await rootPath($, `${PARA_ROOT}/${f}`)).catch(() => [])
    parts.push(list.map(x => `${x.name}:${x.mtimeMs}:${x.size}`).sort().join(','))
  }
  return parts.join('|')
}

// Reads the memory again and shows what changed, if anything did.
function refresh($: EngineInterface): Promise<void> {
  refreshing = refreshing.then(() => reread($), () => reread($))
  return refreshing
}

async function reread($: EngineInterface) {
  mtimes = await stamp($)
  const before = await read($, brain)
  const after = await scan($)
  await update($, brain, () => after)
  // Routed down below the count Later or Route now saw: the reminder counts from there.
  if (after) await update($, routeLater, n => Math.min(n, unrouted(after)))
  const ev = after ? diffBrain(before, after) : null
  if (!ev) return
  await show($, ev)
  if (ev.title !== HANDOFF_TITLE) await note($, 'memory', `${VERB[ev.kind]}: ${ev.title}`)
}

// ---------- the session journal ----------

async function note($: EngineInterface, kind: JournalKind, text: string, call?: string) {
  if (!journalOn || !text) return
  if (call) {
    if (journaled.has(call)) return
    journaled.add(call)
  }
  await append($, { at: clockTime(await $.clock.now()), kind, text })
}

async function append($: EngineInterface, entry: JournalEntry) {
  await update($, journal, list => [...list, entry].slice(-JOURNAL_MAX))
  const entries = await read($, journal)
  writing = writing.then(() => writeJournal($, entries), () => writeJournal($, entries))
  await writing
}

// A copy on disk, in the project's .claude/brain/, for a later session or a person to read; kept out
// of git through the repository's own exclude file.
async function writeJournal($: EngineInterface, entries: readonly JournalEntry[]) {
  const id = await $.session.id()
  await $.fs.write(await rootPath($, journalFile(id)), journalDoc(id, entries)).catch(() => {})
  if (!excluded) excluded = await keepOutOfGit($)
}

// Whether .claude/brain/ is in git's exclude file: tried with each write until it is.
let excluded = false

// True once nothing is left to do: listed, not a git repository, or no git to run. Only a write to
// the exclude file that failed is tried again with the next entry.
async function keepOutOfGit($: EngineInterface): Promise<boolean> {
  const root = await $.session.root()
  const found = await $.process.run(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: root, timeoutMs: 10_000 }).catch(() => null)
  if (!found) return true
  if (found.exitCode !== 0 || !found.stdout.trim()) return true
  const rel = found.stdout.trim()
  const path = /^([a-zA-Z]:)?[\\/]/.test(rel) ? rel : `${root.replace(/[\\/]$/, '')}/${rel}`
  const text = await $.fs.read(path).then(t => String(t), () => '')
  if (text.split('\n').some(l => l.trim() === `${JOURNAL_DIR}/`)) return true
  return $.fs.write(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${JOURNAL_DIR}/\n`).then(() => true, () => false)
}

// A subagent's answer: the routed-worker's report, or any other agent's last word.
async function workerDone($: EngineInterface, agentId: string, answer: string) {
  if (!journalOn) return
  let s = spawns.get(agentId)
  if (!s) {
    // Spawned before a reload: the list still knows what it was asked.
    const a = (await $.agent.list().catch(() => [])).find(x => x.id === agentId)
    s = { task: a?.description ?? '', type: a?.type ?? '' }
  }
  const entry = workerEntry(clockTime(await $.clock.now()), s.task, s.type, answer)
  if (entry) await append($, entry)
}

// One line beside a prompt when the journal grew since the last one, so the main agent knows there
// is more than its own bottom lines and where to read it.
async function withJournal($: EngineInterface, e: PromptSubmitInput): Promise<PromptSubmitInput> {
  if (!journalOn || e.command) return e
  const entries = await read($, journal)
  if (entries.length <= (await read($, told))) return e
  await update($, told, () => entries.length)
  return { ...e, context: [...(e.context ?? []), contextLine(entries, JOURNAL_TOOL)] }
}

// At the end, what the session leaves open goes to MISTAKES.md as a handoff draft for the next one.
async function handOff($: EngineInterface) {
  if (!journalOn || !handoffOn || (await read($, handedOff))) return
  const entries = await read($, journal)
  if (!entries.length) return
  const loose = looseEnds(entries, await read($, started), await read($, doneIds), { text: await read($, goalText), reached: await read($, goalReached) })
  if (!hasLoose(loose)) return
  const text = await readOr($, MISTAKES)
  if (text === null) return
  const next = insertBelowMarker(text, handoffEntry(stampOf(await $.clock.now()), entries, loose, journalFile(await $.session.id())))
  if (next === null) return
  await update($, handedOff, () => true)
  await $.fs.write(await rootPath($, MISTAKES), next).catch(() => {})
}

async function show($: EngineInterface, ev: Omit<Pulse, 'at'>) {
  const t = await $.clock.now()
  await update($, pulse, () => ({ ...ev, at: t }))
  await update($, frame, () => t)
  // The pane opens by itself once a session; after that the band alone shows a change.
  if (!(await read($, paneShown))) {
    await update($, paneShown, () => true)
    void $.ui.open({ id: PANE, title: PANE_TITLE })
  }
  anim?.cancel()
  anim = $.clock.every(FRAME_MS, async () => {
    const now = await $.clock.now()
    const p = await read($, pulse)
    if (!p || now - p.at >= PULSE_MS) {
      anim?.cancel()
      anim = null
      await update($, pulse, () => null)
      return
    }
    await update($, frame, () => now)
  })
}

async function offer($: EngineInterface, o: Offer) {
  if (!(await read($, brain))) return
  await update($, offers, list => (list.some(x => x.key === o.key) ? list : [...list, o].slice(-3)))
}

async function logIt($: EngineInterface, o: Offer, type: EntryType) {
  await update($, offers, list => list.filter(x => x.key !== o.key))
  // Not awaited: the prompt waits for the session to be idle, and the press shouldn't.
  void $.prompt.submit({ text: logPrompt(type, o.title, o.detail) }).catch(async () => {
    await update($, offers, list => (list.some(x => x.key === o.key) ? list : [o, ...list]))
    $.ui.toast(`Could not ask Claude to log it; try again, or /${SKILL} log`)
  })
}

// A follow-up Claude finished may be worth remembering: a bug as a mistake, else a success.
async function followupDone($: EngineInterface, rawId: unknown, result: string, call?: string) {
  const m = parseDoneResult(result)
  if (!m) return
  const id = String(rawId ?? '')
  if (id) await update($, doneIds, l => (l.includes(id) ? l : [...l, id].slice(-50)))
  await note($, 'todo', `${m.title}${m.note ? ` — ${clip(m.note, 160)}` : ''}`, call)
  const item = (await read($, started)).find(x => x.id === id)
  const types: EntryType[] = item?.isBug ? ['mistake', 'success', 'decision'] : ['success', 'decision', 'mistake']
  await offer($, { key: `fu:${id || m.title}`, from: 'followups', title: m.title, detail: m.note, types })
}

async function goalPlanned($: EngineInterface, rawGoal: unknown, result: string, call?: string) {
  const text = String(rawGoal ?? '').trim()
  if (text) await update($, goalText, () => text)
  if (/^Approved\./.test(result)) {
    await update($, goalReached, () => false)
    await note($, 'goal', `plan approved: ${clip(text || (await read($, goalText)) || 'the session goal', 160)}`, call)
  }
}

// A reached goal: a success to repeat, a handoff for what comes next, or the decisions it took.
async function goalUpdated($: EngineInterface, result: string, call?: string) {
  // "t2 is done. 3/5 tasks done (60%)." as goal-run answers it; a task started is no news.
  const step = /^(\S+ is done\. \d+\/\d+ tasks done \(\d+%\)\.)/.exec(result)?.[1]
  if (step) await note($, 'goal', `${step}${result.includes(GOAL_REACHED) ? ` ${GOAL_REACHED}` : ''}`, call)
  if (result.includes(GOAL_REACHED)) await offerGoal($, (await read($, goalText)) || 'the session goal')
}

// Routing is the skill's: run it as /brain-hud:mistake-brain route, or ask Claude to where the
// command can't be run from here. The reminder then waits until more entries come in.
async function routeNow($: EngineInterface, count: number) {
  await update($, routeLater, () => count)
  runSkill($, 'route', 'Route the unrouted MISTAKES.md entries')
}

// Sets up the memory in a project that has none: the skill's init.
function setUp($: EngineInterface) {
  runSkill($, 'init', "Set up mistake-brain memory in this project")
}

function runSkill($: EngineInterface, sub: string, ask: string) {
  void $.command.run({ command: SKILL, args: sub }).catch(() =>
    $.prompt.submit({ text: `${ask} with /${SKILL} ${sub}.` }).catch(() => {
      $.ui.toast(`Could not start it; run /${SKILL} ${sub}`)
    }),
  )
}

// One reached-goal offer at a time, whichever signal comes first.
async function offerGoal($: EngineInterface, text: string) {
  await update($, goalReached, () => true)
  await offer($, { key: 'goal', from: 'goal-run', title: `Reached the goal: ${text}`, detail: '', types: ['success', 'handoff', 'decision'] })
}

async function toFollowup($: EngineInterface, title: string) {
  await $.command.run({ command: 'followup', args: title }).then(
    () => $.ui.toast(`Added to the to-do list: ${clip(title, 60)}`),
    () => $.ui.toast('The followups mod is needed to add it to a to-do list'),
  )
}

// The factory is installed and takes goals and to-do items over (its takeOver option, on by default).
async function factoryTakesOver($: EngineInterface): Promise<boolean> {
  if (!(await $.command.list().catch(() => [])).some(c => c.name === 'factory')) return false
  const row = (await $.config.list().catch(() => [])).find(r => r.key === 'factory.takeOver')
  return String(row?.value ?? 'on') !== 'off'
}

async function checkFollow($: EngineInterface) {
  if (await read($, canFollow)) return
  const names = (await $.command.list().catch(() => [])).map(c => c.name)
  if (names.includes('followup')) await update($, canFollow, () => true)
}

// The graph's palette follows the theme set in /config; dark when it can't be read.
async function readTheme($: EngineInterface) {
  const row = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')
  const value = String((row as { value?: unknown } | undefined)?.value ?? '')
  await update($, theme, () => (/light/i.test(value) ? 'light' : 'dark'))
}

async function toggle($: EngineInterface, name: string) {
  await update($, open, l => (l.includes(name) ? l.filter(x => x !== name) : [...l, name]))
}

export const register: Register = (on, options) => {
  journalOn = String(options.journal ?? 'on') !== 'off'
  handoffOn = String(options.handoffDraft ?? 'on') !== 'off'

  on('session.start', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    journaled.clear()
    excluded = false
    spawns.clear()
    anim?.cancel()
    anim = null
    await $.command.register({ name: 'brain', description: "Show the agent's project memory (mistake-brain)" })
    if (journalOn) {
      await $.tool.register({
        name: 'journal',
        description: "Read this session's journal: one line per subagent/worker report (what it was asked, its findings, what it changed and where, its open questions), mistake-brain entries logged, to-dos finished and goal steps, with the time of each. Read it when you need what happened earlier in the session (what a worker found, what was fixed) instead of re-reading files or asking a worker again.",
        inputSchema: {
          type: 'object',
          properties: { last: { type: 'integer', description: `Optional: only the newest N entries (default ${JOURNAL_LAST})` } },
        },
        isDeferred: false,
      }).catch(() => {})
    }
    await readTheme($)
    await refresh($)
    let ticks = 0
    timers.push($.clock.every(POLL_MS, async () => {
      if (!(await read($, brain)) && ++ticks % (IDLE_POLL_MS / POLL_MS)) return
      if ((await stamp($)) !== mtimes) await refresh($)
    }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    anim?.cancel()
    anim = null
    await handOff($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'brain' }, async ($) => {
    await readTheme($)
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: (await read($, brain)) ? 'Opened the Brain pane.' : `No mistake-brain memory in this project yet: /${SKILL} init sets one up.` }
  })

  on('turn.start', async ($, e, next) => {
    await checkFollow($)
    // A theme changed in /config mid-session reaches the graph from the next prompt on.
    await readTheme($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A write to the memory shows at once; the poll catches the rest.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) return r
    const path = String((e as unknown as { file_path?: unknown }).file_path ?? '')
    if (/(^|[\\/])MISTAKES\.md$|[\\/]\.agent-brain[\\/]|[\\/]agent-memory[\\/]|[\\/]\.claude[\\/]rules[\\/]/.test(path)) await refresh($)
    return r
  }).catch(($, e, next) => next(e))

  // ---------- the session journal ----------

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) spawns.set(r.agentId, { task: e.description || e.prompt.split('\n')[0] || '', type: e.subagentType ?? '' })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined && e.reason === 'answer') await workerDone($, e.agentId, e.answer)
    // A memory set up during the turn (init) shows once it ends, whatever the poll's pace.
    if (e.agentId === undefined && (await stamp($)) !== mtimes) await refresh($)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: JOURNAL_TOOL }, async ($, e) => {
    const last = Number((e as unknown as { last?: unknown }).last)
    return { result: journalText(await read($, journal), Number.isFinite(last) && last > 0 ? Math.floor(last) : JOURNAL_LAST) }
  })

  // ---------- the other mods ----------

  // followups' Start names the items it hands Claude, remembered so their "done" can be offered;
  // goal-run's start prompt names the goal.
  on('prompt.submit', async ($, e, next) => {
    // A Start the factory takes over is the factory's: its PR prompt marks the item done.
    if (e.origin.kind === 'plugin' && e.origin.name === 'followups' && !(takeOverArgs(e.text, e.origin) && (await factoryTakesOver($)))) {
      const items = parseStartPrompt(e.text).map(i => ({ id: i.id, title: i.title, isBug: Boolean(i.isBug) }))
      if (items.length) await update($, started, l => [...l.filter(x => !items.some(i => i.id === x.id)), ...items].slice(-20))
    }
    if (e.origin.kind === 'plugin' && e.origin.name === 'goal-run') {
      const goal = parseGoalPrompt(e.text)
      if (goal) await update($, goalText, () => goal)
    }
    return next(await withJournal($, e))
  }).catch(($, e, next) => next(e))

  // The other mods' tools are answered by their owners' tool.call hooks, which don't call next: a
  // hook here on those tools runs only while brain-hud sits above the owner, an order the engine
  // doesn't promise. So each one is also read from the classic PostToolUse event, which sees every
  // call whatever the order; an offer is made once, whichever comes first.
  on('tool.call', { tool: FOLLOWUPS_DONE }, async ($, e, next) => {
    const r = await next(e)
    await followupDone($, (e as unknown as { id?: unknown }).id, String(r.result ?? ''), e.tool_use_id)
    // goal-run notes on the same result when this item closed the goal's last task (seen when
    // goal-run's hook runs beneath this one).
    for (const c of r.context ?? []) {
      const goal = parseGoalClosedNote(c)
      if (goal) await offerGoal($, goal)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: GOAL_PLAN }, async ($, e, next) => {
    const r = await next(e)
    await goalPlanned($, (e as unknown as { goal?: unknown }).goal, String(r.result ?? ''), e.tool_use_id)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: GOAL_UPDATE }, async ($, e, next) => {
    const r = await next(e)
    await goalUpdated($, String(r.result ?? ''), e.tool_use_id)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    const input = (e.tool_input ?? {}) as { id?: unknown; goal?: unknown }
    const text = toolText(e.tool_response)
    if (e.tool_name === FOLLOWUPS_DONE) await followupDone($, input.id, text, e.tool_use_id)
    else if (e.tool_name === GOAL_PLAN) await goalPlanned($, input.goal, text, e.tool_use_id)
    else if (e.tool_name === GOAL_UPDATE) await goalUpdated($, text, e.tool_use_id)
    return r
  }).catch(($, e, next) => next(e))


  // ---------- the band ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, pulse)
    const pending = await read($, offers)
    const b = await read($, brain)
    const toRoute = b ? unrouted(b) : 0
    const remind = toRoute >= ROUTE_AT && toRoute > (await read($, routeLater))
    if (e.props.hasSurvey || (!p && !pending.length && !remind)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg
    const t = await read($, frame)
    const below = await next(e)
    const o = pending[0]
    // The suggested type alone, until "…" asks for the others.
    const showAll = Boolean(o) && (await read($, more)) === o!.key
    return (
      <Box flexDirection="column">
        {p ? (
          <Box flexDirection="row" gap={1} paddingX={1} alignItems="center">
            {Svg ? (
              <Svg source={sceneSvg(p.kind, Math.floor((t - p.at) / FRAME_MS))} alt={`${VERB[p.kind]}: ${p.title}`} width={SCENE.width} height={SCENE.height} />
            ) : (
              <Text bold color={KIND_COLOR[p.kind]}>{faceText(p.kind)}</Text>
            )}
            <Box flexDirection="column">
              <Text bold color={KIND_COLOR[p.kind]}>{`${VERB[p.kind]}${p.folder ? ` → ${p.folder}` : ''}`}</Text>
              <Text dimColor wrap="truncate-end">{clip(p.title, 90)}</Text>
            </Box>
          </Box>
        ) : null}
        {o ? (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color={ACCENT} wrap="truncate-end">{`🧠 Worth remembering? ${o.title}`}</Text>
            <Box flexDirection="row" gap={1}>
              {(showAll ? o.types : o.types.slice(0, 1)).map((type, i) => (
                <Button key={`log-${type}`} label={`Log as ${type}`} {...(i === 0 ? { hotkey: 'l' } : {})} variant={i === 0 ? 'primary' : undefined} onPress={() => logIt($, o, type)} />
              ))}
              {showAll ? null : <Button key="log-more" label="…" hotkey="m" onPress={() => update($, more, () => o.key)} />}
              <Button key="log-skip" label="Not now" onPress={() => update($, offers, l => l.filter(x => x.key !== o.key))} />
            </Box>
          </Box>
        ) : null}
        {remind && !o ? (
          <Box flexDirection="row" gap={1} paddingX={1} alignItems="center">
            <Text bold color={ACCENT}>{`🧠 ${toRoute} entries to route`}</Text>
            <Button key="route-now" label="Route now" hotkey="r" variant="primary" onPress={() => routeNow($, toRoute)} />
            <Button key="route-later" label="Later" onPress={() => update($, routeLater, () => toRoute)} />
          </Box>
        ) : null}
        {below}
      </Box>
    )
  })

  // ---------- the pane: the memory as a tree ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg
    const b = await read($, brain)
    if (!b) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color={ACCENT}>🧠 Brain</Text>
          <Text dimColor>{`No MISTAKES.md or .agent-brain/ memory in this project yet. /${SKILL} init sets one up: the inbox, the PARA folders and the index.`}</Text>
          <Box flexDirection="row">
            <Button key="init" label="Set up memory" variant="primary" onPress={() => setUp($)} />
          </Box>
        </Box>
      )
    }
    const opened = await read($, open)
    const p = await read($, pulse)
    const follow = await read($, canFollow)
    const isOpen = (name: string) => opened.includes(name)
    const arrow = (name: string) => (isOpen(name) ? '▾' : '▸')
    // What the graph lights up: the file a lesson just went into, and the entry just logged or
    // routed, travelling from the inbox to its file for the first two seconds of a route.
    const t = p ? (await read($, frame)) - p.at : 0
    const freshAt = p ? b.entries.findIndex(en => en.title === p.title) : -1
    const travelling = p?.kind === 'route' && freshAt >= 0 && routeOf(b.entries[freshAt]!) && t < 2_000 ? { entry: freshAt, t: Math.max(0.05, t / 2_000) } : undefined
    const fresh = (title: string) => (p && (p.title === title || p.file === title) ? '✦ ' : '')
    const waiting = unrouted(b)
    // Where the index came from, said whenever it explains what the graph shows.
    const missing = FOLDERS.flatMap(f => b.folders[f].filter(l => !l.isIndexed).map(l => l.file))
    const unindexed = missing.length
    const problem = b.index === null
      ? `No index found: neither ${MEMORY_PATHS.join(' nor ')} exists, so no lessons are counted.`
      : unindexed
        ? `${unindexed} PARA file${unindexed === 1 ? ' is' : 's are'} not in ${b.index}: ${missing.slice(0, 3).join(', ')}${unindexed > 3 ? ', …' : ''}`
        : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color={ACCENT}>{`🧠 ${lessons(lessonCount(b))}`}</Text>
          <Text dimColor>{`· ${waiting} unrouted`}</Text>
        </Box>
        {problem ? <Text color="#d97706" wrap="truncate-end">{`⚠ ${problem}`}</Text> : null}
        {Svg ? (
          <Svg
            source={graphSvg(b, { theme: await read($, theme), ...(p?.file ? { hot: p.file } : {}), ...(freshAt >= 0 ? { fresh: freshAt } : {}), ...(travelling ? { travelling } : {}) })}
            alt={`Memory graph: MEMORY.md, ${FOLDERS.map(f => `${f} ${b.folders[f].length} files`).join(', ')}; ${b.entries.length} entries, ${waiting} still to route`}
            width={GRAPH.width}
            height={GRAPH.height}
          />
        ) : null}
        <Box flexDirection="column">
          <Button key="f-Inbox" label={`${arrow('Inbox')} 📥 Inbox · MISTAKES.md (${b.entries.length})`} plain onPress={() => toggle($, 'Inbox')} />
          {isOpen('Inbox')
            ? b.entries.slice(0, INBOX_SHOWN).map((en, i) => (
                <Box key={`e-${i}`} flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexDirection="row" gap={1}>
                    <Text>{i === Math.min(INBOX_SHOWN, b.entries.length) - 1 ? '   └─' : '   ├─'}</Text>
                    <Text color={KIND_COLOR[en.type]}>{`● ${en.type}`}</Text>
                    <Text wrap="truncate-end">{`${fresh(en.title)}${clip(en.title, 70)}`}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>{en.status}</Text>
                    {en.type === 'handoff' && follow ? <Button key={`fu-${i}`} label="+ to-do" plain onPress={() => toFollowup($, en.title)} /> : null}
                  </Box>
                </Box>
              ))
            : null}
          {isOpen('Inbox') && b.entries.length > INBOX_SHOWN ? <Text dimColor>{`   … ${b.entries.length - INBOX_SHOWN} older`}</Text> : null}
          {FOLDERS.map(f => {
            const files = b.folders[f]
            const n = files.reduce((k, l) => k + l.lessons, 0)
            const label = f === 'Archives' && !files.length ? `🗄 Archives · ${b.archives} files` : `${arrow(f)} ${f === 'Archives' ? '🗄' : '📁'} ${f} (${files.length})${n ? ` · ${lessons(n)}` : ''}`
            return (
              <Box key={`d-${f}`} flexDirection="column">
                {files.length ? <Button key={`f-${f}`} label={label} plain onPress={() => toggle($, f)} /> : <Text dimColor>{`  ${label}`}</Text>}
                {isOpen(f)
                  ? files.map((l, i) => (
                      <Box key={`l-${f}-${i}`} flexDirection="column">
                        <Box flexDirection="row" gap={1}>
                          <Text>{i === files.length - 1 ? '   └─' : '   ├─'}</Text>
                          <Text color={p?.file === l.file ? '#d4a017' : undefined} bold={p?.file === l.file}>{`${fresh(l.file)}${l.file}`}</Text>
                          <Text dimColor>{l.isIndexed ? [l.lessons ? lessons(l.lessons) : '', l.updated].filter(Boolean).join(' · ') : 'not in MEMORY.md'}</Text>
                        </Box>
                        {l.summary && p?.file === l.file ? <Text dimColor wrap="truncate-end">{`      ${clip(l.summary, 110)}`}</Text> : null}
                      </Box>
                    ))
                  : null}
              </Box>
            )
          })}
          {b.rules.length ? <Text dimColor>{`  ⚖ Rules · ${b.rules.map(r => clip(r, 50)).join(' · ')}`}</Text> : null}
          <Text dimColor wrap="truncate-end">{`  index: ${b.index ?? 'none found'}`}</Text>
        </Box>
      </Box>
    )
  })
}
