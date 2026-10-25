import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brain, EntryType, Folder, Offer, Pulse, PulseKind } from '../types'
import { faceText, KIND_COLOR, SCENE, sceneSvg } from './art'
import { GRAPH, graphSvg, routeOf } from './graph'
import type { Theme } from './graph'
import { diffBrain, FOLDERS, lessonCount, logPrompt, parseMemory, parseMistakes, unrouted, withListing } from './brain'
import { GOAL_REACHED, parseDoneResult, parseGoalClosedNote, parseGoalPrompt, parseStartPrompt, toolText } from './texts'

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

const PANE = 'brain-hud'
const PANE_TITLE = 'Brain'
const MISTAKES = 'MISTAKES.md'
// The shared index first; projects set up before it was shared keep a per-harness one.
const MEMORY_PATHS = ['.agent-brain/shared/MEMORY.md', '.claude/agent-memory/claude/MEMORY.md']
const PARA_ROOT = '.agent-brain/shared'
const POLL_MS = 4_000
const PULSE_MS = 6_000
const FRAME_MS = 160
const INBOX_SHOWN = 3
// Unrouted entries from which the band suggests routing them.
const ROUTE_AT = 3
const ACCENT = '#c96f97'

const FOLLOWUPS_DONE = 'mcp__followups__done'
const GOAL_PLAN = 'mcp__goal-run__plan'
const GOAL_UPDATE = 'mcp__goal-run__update'

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
  const onDisk: Partial<Record<Folder, string[]>> = {}
  for (const f of FOLDERS) {
    const list = await $.fs.list(await rootPath($, `${PARA_ROOT}/${f}`)).catch(() => [])
    onDisk[f] = list.filter(x => x.kind === 'file' && x.name.endsWith('.md')).map(x => x.name)
  }
  return { ...parsed, folders: withListing(parsed.folders, onDisk), entries: parseMistakes(mistakes ?? ''), index }
}

async function stamp($: EngineInterface): Promise<string> {
  const parts: string[] = []
  for (const p of [MISTAKES, ...MEMORY_PATHS]) {
    const st = await $.fs.stat(await rootPath($, p)).catch(() => null)
    parts.push(st ? `${st.mtimeMs}:${st.size}` : '-')
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
  const ev = after ? diffBrain(before, after) : null
  if (ev) await show($, ev)
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
    $.ui.toast('Could not ask Claude to log it; try again, or /mistake-brain log')
  })
}

// A follow-up Claude finished may be worth remembering: a bug as a mistake, else a success.
async function followupDone($: EngineInterface, rawId: unknown, result: string) {
  const m = parseDoneResult(result)
  if (!m) return
  const id = String(rawId ?? '')
  const item = (await read($, started)).find(x => x.id === id)
  const types: EntryType[] = item?.isBug ? ['mistake', 'success', 'decision'] : ['success', 'decision', 'mistake']
  await offer($, { key: `fu:${id || m.title}`, from: 'followups', title: m.title, detail: m.note, types })
}

async function goalPlanned($: EngineInterface, rawGoal: unknown) {
  const text = String(rawGoal ?? '').trim()
  if (text) await update($, goalText, () => text)
}

// A reached goal: a success to repeat, a handoff for what comes next, or the decisions it took.
async function goalUpdated($: EngineInterface, result: string) {
  if (result.includes(GOAL_REACHED)) await offerGoal($, (await read($, goalText)) || 'the session goal')
}

// Routing is the skill's: run it as /mistake-brain route, or ask Claude to where that command isn't
// there to run. The reminder then waits until more entries come in.
async function routeNow($: EngineInterface, count: number) {
  await update($, routeLater, () => count)
  void $.command.run({ command: 'mistake-brain', args: 'route' }).catch(() =>
    $.prompt.submit({ text: 'Route the unrouted MISTAKES.md entries with /mistake-brain route.' }).catch(() => {
      $.ui.toast('Could not start routing; run /mistake-brain route')
    }),
  )
}

// One reached-goal offer at a time, whichever signal comes first.
async function offerGoal($: EngineInterface, text: string) {
  await offer($, { key: 'goal', from: 'goal-run', title: `Reached the goal: ${text}`, detail: '', types: ['success', 'handoff', 'decision'] })
}

async function toFollowup($: EngineInterface, title: string) {
  await $.command.run({ command: 'followup', args: title }).then(
    () => $.ui.toast(`Added to the to-do list: ${clip(title, 60)}`),
    () => $.ui.toast('The followups mod is needed to add it to a to-do list'),
  )
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    anim?.cancel()
    anim = null
    await $.command.register({ name: 'brain', description: "Show the agent's project memory (mistake-brain)" })
    await readTheme($)
    await refresh($)
    timers.push($.clock.every(POLL_MS, async () => {
      if ((await stamp($)) !== mtimes) await refresh($)
    }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    anim?.cancel()
    anim = null
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'brain' }, async ($) => {
    await readTheme($)
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: (await read($, brain)) ? 'Opened the Brain pane.' : 'No mistake-brain memory in this project yet: /mistake-brain init sets one up.' }
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

  // ---------- the other mods ----------

  // followups' Start names the items it hands Claude, remembered so their "done" can be offered;
  // goal-run's start prompt names the goal.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === 'followups') {
      const items = parseStartPrompt(e.text).map(i => ({ id: i.id, title: i.title, isBug: Boolean(i.isBug) }))
      if (items.length) await update($, started, l => [...l.filter(x => !items.some(i => i.id === x.id)), ...items].slice(-20))
    }
    if (e.origin.kind === 'plugin' && e.origin.name === 'goal-run') {
      const goal = parseGoalPrompt(e.text)
      if (goal) await update($, goalText, () => goal)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The other mods' tools are answered by their owners' tool.call hooks, which don't call next: a
  // hook here on those tools runs only while brain-hud sits above the owner, an order the engine
  // doesn't promise. So each one is also read from the classic PostToolUse event, which sees every
  // call whatever the order; an offer is made once, whichever comes first.
  on('tool.call', { tool: FOLLOWUPS_DONE }, async ($, e, next) => {
    const r = await next(e)
    await followupDone($, (e as unknown as { id?: unknown }).id, String(r.result ?? ''))
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
    await goalPlanned($, (e as unknown as { goal?: unknown }).goal)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: GOAL_UPDATE }, async ($, e, next) => {
    const r = await next(e)
    await goalUpdated($, String(r.result ?? ''))
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    const input = (e.tool_input ?? {}) as { id?: unknown; goal?: unknown }
    const text = toolText(e.tool_response)
    if (e.tool_name === FOLLOWUPS_DONE) await followupDone($, input.id, text)
    else if (e.tool_name === GOAL_PLAN) await goalPlanned($, input.goal)
    else if (e.tool_name === GOAL_UPDATE) await goalUpdated($, text)
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
          <Text dimColor>No MISTAKES.md or .agent-brain/ memory in this project yet. /mistake-brain init sets one up.</Text>
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
    const unindexed = FOLDERS.reduce((n, f) => n + b.folders[f].filter(l => !l.isIndexed).length, 0)
    const problem = b.index === null
      ? `No index found: neither ${MEMORY_PATHS.join(' nor ')} exists, so no lessons are counted.`
      : unindexed
        ? `${unindexed} PARA file${unindexed === 1 ? ' is' : 's are'} not in ${b.index}${lessonCount(b) ? '' : ', and it lists no lessons'}.`
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
