import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Agent, Todo, TodoStatus } from '../types'
import {
  BAR, CREATURE, LINE, barText, colorOf, creatureSvg, creatureText, progressLineSvg, taskBarSvg,
} from './art'

// ---------- state ----------

const todos = atom({ plugin: 'task-hud', key: 'todos' } as const, [] as Todo[])
const title = atom({ plugin: 'task-hud', key: 'title' } as const, '')
// The prompt that started the work, named on the band once a to-do list shows up.
const lastPrompt = atom({ plugin: 'task-hud', key: 'lastPrompt' } as const, '')
const retitle = atom({ plugin: 'task-hud', key: 'retitle' } as const, false)
const agents = atom({ plugin: 'task-hud', key: 'agents' } as const, [] as Agent[])
const tick = atom({ plugin: 'task-hud', key: 'tick' } as const, 0)

const PANE = 'task-hud'
const PANE_TITLE = 'Sub-agents'
// Redraws while an agent runs: its timer and its legs.
const TICK_MS = 500
// Activity lines kept per agent, and agents kept in the pane.
const KEEP_LINES = 3
const KEEP_AGENTS = 24
// An agent that has done nothing for this long is shown as stopped, so one whose turn never
// completes (a crash, an abort the engine did not report) cannot keep the timer running.
const STALE_MS = 10 * 60_000

const timers: { cancel: () => void }[] = []

// ---------- text ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const base = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? ''

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// "claude-opus-5-5" → "Opus 5.5", "haiku" → "Haiku".
export function modelName(id: string): string {
  const m = /(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?)?/i.exec(id)
  if (!m?.[1]) return id
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return m[2] ? `${fam} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : fam
}

// What a sub-agent's tool call reads as on its card.
export function activityOf(tool: string, input: Record<string, unknown>): Activity {
  const file = base(input.file_path ?? input.notebook_path ?? input.path)
  const say = (now: string, past: string, what: string) => ({ now: clip(`${now} ${what}`.trim(), 60), past: clip(`${past} ${what}`.trim(), 60) })
  switch (tool) {
    case 'Read': return say('Reading', 'Read', file)
    case 'Write': return say('Writing', 'Wrote', file)
    case 'Edit':
    case 'NotebookEdit': return say('Editing', 'Edited', file)
    case 'Bash': return say('Running', 'Ran', String(input.description ?? firstLine(String(input.command ?? ''))))
    case 'Grep':
    case 'Glob': return say('Searching for', 'Searched for', String(input.pattern ?? ''))
    case 'WebSearch': return say('Searching the web for', 'Searched the web for', String(input.query ?? ''))
    case 'WebFetch': {
      let host = String(input.url ?? '')
      try { host = new URL(host).host } catch { /* keep it as given */ }
      return say('Fetching', 'Fetched', host)
    }
    case 'Skill': return input.skill ? say('Reading the', 'Read the', `${input.skill} skill`) : say('Reading', 'Read', 'a skill')
    case 'Agent': return say('Sending out', 'Sent out', String(input.description ?? 'a sub-agent'))
    case 'TodoWrite': {
      const list = (input.todos ?? []) as { status: string; activeForm: string; content: string }[]
      const cur = list.find(t => t.status === 'in_progress')
      return cur ? say('', '', cur.activeForm) : say('Planning', 'Planned', `${list.length} to-dos`)
    }
    default: return say('Using', 'Used', tool.replace(/^mcp__[^_]+__/, ''))
  }
}

// How far along a card's line is. The number of steps an agent will take is unknown, so a
// running one creeps toward 90% as it works; a finished one is full.
const progressOf = (a: Agent) => (a.state !== 'running' ? 1 : Math.min(0.9, a.steps / (a.steps + 6)))

// ---------- updates ----------

const patchAgent = async ($: EngineInterface, id: string, fn: (a: Agent) => Agent) => {
  const t = await $.clock.now()
  await update($, agents, list => list.map(a => (a.id === id ? { ...fn(a), updatedAt: t } : a)))
}

const stopTicking = () => { for (const timer of timers.splice(0)) timer.cancel() }
const isStale = (a: Agent, t: number) => a.state === 'running' && t - (a.updatedAt ?? a.startedAt) > STALE_MS

// An agent stopped for silence alone that does something was still working: it runs again.
const revive = (a: Agent): Agent => (a.isSilent ? { ...a, state: 'running', endedAt: null, isSilent: false } : a)

async function reviveIfSilent($: EngineInterface, id: string) {
  if ((await read($, agents)).some(a => a.id === id && a.isSilent)) {
    await patchAgent($, id, revive)
    await ensureTicking($)
  }
}

async function ensureTicking($: EngineInterface) {
  if (timers.length) return
  timers.push($.clock.every(TICK_MS, async () => {
    const t = await $.clock.now()
    await update($, tick, () => t)
    const list = await update($, agents, l =>
      l.some(a => isStale(a, t)) ? l.map(a => (isStale(a, t) ? { ...a, state: 'failed' as const, endedAt: a.updatedAt ?? a.startedAt, isSilent: true } : a)) : l)
    if (!list.some(a => a.state === 'running')) stopTicking()
  }))
}

// Over the limit, the oldest finished agents go first: a running one stays listed however old.
export function keepAgents(list: Agent[], keep = KEEP_AGENTS): Agent[] {
  let over = list.length - keep
  if (over <= 0) return list
  return list.filter(a => (over > 0 && a.state !== 'running' ? (over--, false) : true))
}

// `next` is the new list, or a change to the current one (applied atomically, so two calls at once both land).
// The band is titled by the prompt the list was made for: a new list (empty before, or none of its
// tasks left) written in a new turn takes that turn's prompt. Status changes, a task appended to the
// list, and later writes in the turn keep the title.
async function setTodos($: EngineInterface, next: Todo[] | ((list: Todo[]) => Todo[])) {
  const before = await read($, todos)
  const after = await update($, todos, list => (typeof next === 'function' ? next(list) : next))
  if (!after.length) return
  const isNew = !before.length || ((await read($, retitle)) && !after.some(t => before.some(b => b.subject === t.subject)))
  if (!isNew) return
  await update($, retitle, () => false)
  const prompt = await read($, lastPrompt)
  await update($, title, () => clip(firstLine(prompt), 48))
}

const isStatus = (s: unknown): s is TodoStatus => s === 'pending' || s === 'in_progress' || s === 'completed'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    stopTicking()
    await $.command.register({ name: 'task-hud', description: 'Show the sub-agents pane' })
    if ((await read($, agents)).some(a => a.state === 'running')) await ensureTicking($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The session is over: nothing should keep redrawing.
  on('session.end', async ($, e, next) => {
    stopTicking()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'task-hud' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    return { text: 'Sub-agents pane opened.' }
  })

  // Whether the next turn's prompt is the person's: another mod's ("Start this item from my to-do
  // list:") doesn't title the band.
  let isPersons = true
  on('prompt.submit', async ($, e, next) => {
    isPersons = e.origin.kind !== 'plugin'
    return next(e)
  }).catch(($, e, next) => next(e))

  // A new request from the person: remember it as the band's title, and drop a finished list.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined || !e.text) return next(e)
    if (isPersons) {
      await update($, lastPrompt, () => e.text)
      await update($, retitle, () => true)
    }
    const list = await read($, todos)
    if (list.length && list.every(t => t.status === 'completed')) await update($, todos, () => [])
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------- the to-do list ----------

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && !('deny' in ran && ran.deny)) {
      await setTodos($, e.todos.map((t, i) => ({ id: `todo-${i}`, subject: t.content, activeForm: t.activeForm, status: t.status })))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    // A sub-agent's tasks are its own, not the main conversation's to-do list.
    if (id && e.agentId === undefined) {
      await setTodos($, list => [...list, { id, subject: e.subject, activeForm: e.activeForm ?? e.subject, status: 'pending' }])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const ok = (ran.result as { success?: boolean } | undefined)?.success
    if (ok && e.agentId === undefined) {
      await update($, todos, list =>
        e.status === 'deleted'
          ? list.filter(t => t.id !== e.taskId)
          : list.map(t => t.id !== e.taskId ? t : {
            ...t,
            subject: e.subject ?? t.subject,
            activeForm: e.activeForm ?? t.activeForm,
            status: isStatus(e.status) ? e.status : t.status,
          }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---------- sub-agents ----------

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (!ran.agentId) return ran
    const list = await read($, agents)
    // A resumed agent picks up its card; one whose card was already dropped gets a fresh one.
    if (e.resume && list.some(a => a.id === ran.agentId)) {
      await patchAgent($, ran.agentId, a => ({ ...a, state: 'running', endedAt: null }))
      await ensureTicking($)
      return ran
    }
    const t = await $.clock.now()
    const agent: Agent = {
      id: ran.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      model: modelName(ran.model || e.model || e.parentModel),
      slot: list.length ? Math.max(...list.map(a => a.slot)) + 1 : 0,
      startedAt: t,
      endedAt: null,
      updatedAt: t,
      state: 'running',
      steps: 0,
      tokens: 0,
      activity: [],
    }
    await update($, agents, l => keepAgents([...l, agent]))
    await update($, tick, () => t)
    await ensureTicking($)
    void $.ui.open({ id: PANE, title: PANE_TITLE })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const act = activityOf(e.tool, e as unknown as Record<string, unknown>)
      await reviveIfSilent($, id)
      await patchAgent($, id, a => ({ ...a, steps: a.steps + 1, activity: [...a.activity, act].slice(-KEEP_LINES) }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each model request reports the agent's context so far: its size is the card's token count.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (e.agentId !== undefined && u) {
      const used = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await reviveIfSilent($, e.agentId)
      await patchAgent($, e.agentId, a => ({ ...a, tokens: used }))
    }
    return r
  }).catch(async function* ($, e, next) { return yield* next(e) })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const t = await $.clock.now()
      const failed = e.reason === 'error' || e.reason === 'refusal' || e.isAborted
      await patchAgent($, e.agentId!, a => ({ ...a, state: failed ? 'failed' : 'done', endedAt: t, isSilent: false }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------- the band: the to-do bar ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, todos)
    if (e.props.hasSurvey || !list.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const done = list.filter(t => t.status === 'completed').length
    const pct = Math.round((done / list.length) * 100)
    const cur = list.find(t => t.status === 'in_progress')
    const name = (await read($, title)) || 'Tasks'
    const now = done === list.length ? 'All done' : cur ? `Now: ${cur.activeForm}` : `Next: ${list.find(t => t.status === 'pending')?.subject ?? ''}`
    const below = await next(e)

    if (e.surface === 'terminal') {
      const cells = Math.max(10, Math.min(40, e.props.bodyColumns - name.length - 24))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color="#3b7dd8">●</Text>
            <Text bold>{name}</Text>
            <Text color="#3b7dd8">{barText(done / list.length, cells)}</Text>
            <Text bold>{`Tasks ${done}/${list.length}`}</Text>
            <Text dimColor>{`${pct}%`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${now}`}</Text>
          {below}
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={2}>
            <Text color="#3b7dd8">●</Text>
            <Text bold>{name}</Text>
            <Svg source={taskBarSvg(done, list.length)} alt={`Tasks ${done} of ${list.length}`} width={BAR.width} height={BAR.height} />
            <Text>{`${pct}%`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{now}</Text>
        </Box>
        {below}
      </Box>
    )
  })

  // ---------- the pane: one creature per sub-agent ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const t = await read($, tick)
    const frame = Math.floor(t / TICK_MS)
    const running = list.filter(a => a.state === 'running')
    const finished = list.filter(a => a.state !== 'running').reverse()
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg
    const elapsed = (a: Agent) => mmss((a.endedAt ?? t) - a.startedAt)
    const total = list.reduce((n, a) => n + a.tokens, 0)
    const first = list.length ? Math.min(...list.map(a => a.startedAt)) : t
    const last = running.length ? t : Math.max(first, ...list.map(a => a.endedAt ?? first))

    const card = (a: Agent) => {
      const color = a.state === 'failed' ? '#8b8fa3' : colorOf(a.slot)
      const head = a.activity[a.activity.length - 1]
      const status = a.state === 'running'
        ? `Step ${a.steps} · ${head?.now ?? 'Starting'}`
        : a.state === 'done' ? `Done · ${a.steps} steps` : `Stopped · ${a.steps} steps`
      const lines = (a.state === 'running' ? a.activity.slice(0, -1) : a.activity).map(x => (a.state === 'running' ? x.now : x.past))
      return (
        <Box key={a.id} flexDirection="row" gap={2} borderStyle="round" borderColor={a.state === 'running' ? color : undefined} paddingX={1}>
          {Svg
            ? <Svg source={creatureSvg(a.slot, a.state, frame)} alt={`${a.description}: ${a.state}`} width={CREATURE.width} height={CREATURE.height} />
            : <Text color={color}>{creatureText(a.state, frame)}</Text>}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold wrap="truncate-end">{a.description}</Text>
              <Text color={a.state === 'failed' ? '#e0533d' : color}>{a.state === 'running' ? '●' : a.state === 'done' ? '✓' : '✕'}</Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text dimColor wrap="truncate-end">{`${a.type} · ${a.model}`}</Text>
              <Text dimColor>{`${tok(a.tokens)} tokens · ${elapsed(a)}`}</Text>
            </Box>
            <Text color={a.state === 'running' ? undefined : color} bold={a.state !== 'running'} wrap="truncate-end">{status}</Text>
            {lines.map((l, i) => <Text key={`${a.id}-${i}`} dimColor wrap="truncate-end">{`  ${l}`}</Text>)}
            {Svg
              ? <Svg source={progressLineSvg(progressOf(a), color)} alt={`${Math.round(progressOf(a) * 100)}%`} width={LINE.width} height={LINE.height} />
              : <Text color={color}>{barText(progressOf(a), 20)}</Text>}
          </Box>
        </Box>
      )
    }

    if (!list.length) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No sub-agents yet. When Claude sends some out, each shows up here.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text>{`${list.length} sub-agent${list.length === 1 ? '' : 's'}`}</Text>
          <Text dimColor>{`${tok(total)} tokens`}</Text>
          <Text dimColor>{mmss(last - first)}</Text>
        </Box>
        {running.length ? (
          <Box flexDirection="column">
            <Text bold color="#1f9d6b">{`▾ Running · ${running.length}`}</Text>
            {running.map(card)}
          </Box>
        ) : null}
        {finished.length ? (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={2}>
              <Text bold color="#c9a227">{`▾ Finished · ${finished.length}`}</Text>
              <Button key="clear" label="Clear" plain onPress={() => update($, agents, l => l.filter(a => a.state === 'running'))} />
            </Box>
            {finished.map(card)}
          </Box>
        ) : null}
      </Box>
    )
  })
}
