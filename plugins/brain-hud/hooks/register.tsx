import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brain, EntryType, Folder, Offer, Pulse, PulseKind } from '../types'
import { brainMapSvg, faceText, KIND_COLOR, MAP, SCENE, sceneSvg } from './art'
import { diffBrain, FOLDERS, lessonCount, logPrompt, parseMemory, parseMistakes, unrouted, withListing } from './brain'
import { GOAL_REACHED, parseDoneResult, parseGoalClosedNote, parseGoalPrompt, parseStartPrompt } from './texts'

const brain = atom({ plugin: 'brain-hud', key: 'brain' } as const, null as Brain | null)
const pulse = atom({ plugin: 'brain-hud', key: 'pulse' } as const, null as Pulse | null)
const frame = atom({ plugin: 'brain-hud', key: 'frame' } as const, 0)
const offers = atom({ plugin: 'brain-hud', key: 'offers' } as const, [] as Offer[])
const open = atom({ plugin: 'brain-hud', key: 'open' } as const, ['Inbox'] as string[])
const canFollow = atom({ plugin: 'brain-hud', key: 'canFollow' } as const, false)
const started = atom({ plugin: 'brain-hud', key: 'started' } as const, [] as { id: string; title: string; isBug: boolean }[])
const goalText = atom({ plugin: 'brain-hud', key: 'goalText' } as const, '')
const paneShown = atom({ plugin: 'brain-hud', key: 'paneShown' } as const, false)

const PANE = 'brain-hud'
const PANE_TITLE = 'Brain'
const MISTAKES = 'MISTAKES.md'
// The shared index first; projects set up before it was shared keep a per-harness one.
const MEMORY_PATHS = ['.agent-brain/shared/MEMORY.md', '.claude/agent-memory/claude/MEMORY.md']
const PARA_ROOT = '.agent-brain/shared'
const POLL_MS = 4_000
const PULSE_MS = 6_000
const FRAME_MS = 160
const INBOX_SHOWN = 8
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
  for (const p of MEMORY_PATHS) {
    memory = await readOr($, p)
    if (memory !== null) break
  }
  if (mistakes === null && memory === null) return null
  const index = parseMemory(memory ?? '')
  const onDisk: Partial<Record<Folder, string[]>> = {}
  for (const f of FOLDERS) {
    const list = await $.fs.list(await rootPath($, `${PARA_ROOT}/${f}`)).catch(() => [])
    onDisk[f] = list.filter(x => x.kind === 'file' && x.name.endsWith('.md')).map(x => x.name)
  }
  return { ...index, folders: withListing(index.folders, onDisk), entries: parseMistakes(mistakes ?? '') }
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

async function toggle($: EngineInterface, name: string) {
  await update($, open, l => (l.includes(name) ? l.filter(x => x !== name) : [...l, name]))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    anim?.cancel()
    anim = null
    await $.command.register({ name: 'brain', description: "Show the agent's project memory (mistake-brain)" })
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
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: (await read($, brain)) ? 'Opened the Brain pane.' : 'No mistake-brain memory in this project yet: /mistake-brain init sets one up.' }
  })

  on('turn.start', async ($, e, next) => {
    await checkFollow($)
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

  // A follow-up Claude finished may be worth remembering: a bug as a mistake, else a success.
  on('tool.call', { tool: FOLLOWUPS_DONE }, async ($, e, next) => {
    const r = await next(e)
    const m = parseDoneResult(String(r.result ?? ''))
    if (!m) return r
    const id = String((e as unknown as { id?: unknown }).id ?? '')
    const item = (await read($, started)).find(x => x.id === id)
    const types: EntryType[] = item?.isBug ? ['mistake', 'success', 'decision'] : ['success', 'decision', 'mistake']
    await offer($, { key: `fu:${id || m.title}`, from: 'followups', title: m.title, detail: m.note, types })
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
    const text = String((e as unknown as { goal?: unknown }).goal ?? '').trim()
    if (text) await update($, goalText, () => text)
    return r
  }).catch(($, e, next) => next(e))

  // A reached goal: a success to repeat, a handoff for what comes next, or the decisions it took.
  on('tool.call', { tool: GOAL_UPDATE }, async ($, e, next) => {
    const r = await next(e)
    if (!String(r.result ?? '').includes(GOAL_REACHED)) return r
    await offerGoal($, (await read($, goalText)) || 'the session goal')
    return r
  }).catch(($, e, next) => next(e))


  // ---------- the band ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, pulse)
    const pending = await read($, offers)
    if (e.props.hasSurvey || (!p && !pending.length)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg
    const t = await read($, frame)
    const below = await next(e)
    const o = pending[0]
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
            <Text dimColor wrap="truncate-end">{o.from === 'followups' ? 'Finished from the to-do list. Claude logs it to MISTAKES.md with mistake-brain.' : 'Claude logs it to MISTAKES.md with mistake-brain.'}</Text>
            <Box flexDirection="row" gap={1}>
              {o.types.map((type, i) => (
                <Button key={`log-${type}`} label={`Log as ${type}`} hotkey={String(i + 1)} variant={i === 0 ? 'primary' : undefined} onPress={() => logIt($, o, type)} />
              ))}
              <Button key="log-skip" label="Not now" onPress={() => update($, offers, l => l.filter(x => x.key !== o.key))} />
            </Box>
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
    const counts = Object.fromEntries(FOLDERS.map(f => [f, b.folders[f].length])) as Record<Folder, number>
    if (b.archives > counts.Archives) counts.Archives = b.archives
    const fresh = (title: string) => (p && (p.title === title || p.file === title) ? '✦ ' : '')
    const waiting = unrouted(b)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={ACCENT}>{`🧠 Brain · ${lessons(lessonCount(b))}`}</Text>
          <Text dimColor>{`${b.entries.length} in the inbox (${waiting} unrouted) · ${b.rules.length ? `${b.rules.length} rules` : 'no rules promoted yet'} · ${b.lastDream ? `last dream ${b.lastDream}` : 'no dream yet'}`}</Text>
        </Box>
        {Svg ? <Svg source={brainMapSvg(counts, waiting, p?.folder)} alt={`Memory: ${FOLDERS.map(f => `${f} ${counts[f]}`).join(', ')}; ${waiting} unrouted`} width={MAP.width} height={MAP.height} /> : null}
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
                        {l.summary ? <Text dimColor wrap="truncate-end">{`      ${clip(l.summary, 110)}`}</Text> : null}
                      </Box>
                    ))
                  : null}
              </Box>
            )
          })}
          <Text dimColor>{`  ⚖ Rules · ${b.rules.length ? b.rules.map(r => clip(r, 50)).join(' · ') : 'none promoted yet'}`}</Text>
        </Box>
      </Box>
    )
  })
}
