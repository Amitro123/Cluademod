import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Asking, Goal, Task, TaskStatus } from '../types'
import { TRACK_SIZE, trackSvg, trackText } from './art'
import type { Pose } from './art'

// ---------- state ----------

const goal = atom({ plugin: 'goal-run', key: 'goal' } as const, null as Goal | null)
const asking = atom({ plugin: 'goal-run', key: 'asking' } as const, null as Asking)
const tick = atom({ plugin: 'goal-run', key: 'tick' } as const, 0)

const PANE = 'goal-run'
const PANE_TITLE = 'Goal'
const PLAN_TOOL = 'mcp__goal-run__plan'
const UPDATE_TOOL = 'mcp__goal-run__update'
// The runner's stride: four frames a second while a task is in progress.
const FRAME_MS = 250
const MAX_TASKS = 12

const APPROVE = 'Approve'
const CHANGE = 'Change it'

const timers: { cancel: () => void }[] = []

// ---------- text ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const MARK: Record<TaskStatus, string> = { pending: '○', in_progress: '◐', done: '✓' }
const COLOR: Record<TaskStatus, string> = { pending: '#8b8fa3', in_progress: '#d97757', done: '#1f9d6b' }

export const fractionOf = (g: Goal) => (g.tasks.length ? g.tasks.filter(t => t.status === 'done').length / g.tasks.length : 0)
export const percentOf = (g: Goal) => Math.round(fractionOf(g) * 100)
const tokensOf = (g: Goal) => g.tasks.reduce((n, t) => n + t.tokens, g.other)

export function poseOf(g: Goal | null): Pose {
  if (!g) return 'stand'
  if (g.status === 'done') return 'cheer'
  return g.status === 'active' && g.tasks.some(t => t.status === 'in_progress') ? 'run' : 'stand'
}

// The plan as the person reads it in the approval dialog.
export function planText(g: Goal): string {
  return [`Goal: ${g.text}`, ...g.tasks.map((t, i) => `${i + 1}. ${t.title}`)].join('\n')
}

// What the model reads beside each prompt while a goal is being worked: where it stands, and how to move it.
export function reminder(g: Goal): string {
  const done = g.tasks.filter(t => t.status === 'done').length
  return [
    `Session goal: ${g.text}. ${done}/${g.tasks.length} tasks done (${percentOf(g)}%).`,
    ...g.tasks.map(t => `- [${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending'}] ${t.id}: ${t.title}`),
    `When you start a task call ${UPDATE_TOOL} with its id and status "in_progress"; when it is finished, status "done". Work the tasks in order unless the person says otherwise.`,
  ].join('\n')
}

// ---------- updates ----------

const storeKey = async ($: EngineInterface) => `goal:${await $.session.root()}`

async function save($: EngineInterface) {
  await $.store.set(await storeKey($), await read($, goal))
}

async function setGoal($: EngineInterface, fn: (g: Goal | null) => Goal | null) {
  await update($, goal, fn)
  await save($)
  await syncTicking($)
}

// The runner moves only while a task is in progress: the timer runs then, and stops otherwise.
async function syncTicking($: EngineInterface) {
  const isRunning = poseOf(await read($, goal)) === 'run'
  if (isRunning && !timers.length) {
    timers.push($.clock.every(FRAME_MS, async () => {
      const t = await $.clock.now()
      await update($, tick, () => t)
    }))
  }
  if (!isRunning) for (const timer of timers.splice(0)) timer.cancel()
}

// A goal typed by the person: Claude is asked for a plan, which waits for approval before any work.
async function startGoal($: EngineInterface, text: string) {
  const g: Goal = { text: clip(text.trim(), 200), status: 'planning', tasks: [], activeId: null, other: 0 }
  await update($, asking, () => null)
  await setGoal($, () => g)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
  void $.prompt.submit({
    text: `My goal for this session: ${g.text}\n\nBreak it into 3 to 8 concrete tasks and propose them with ${PLAN_TOOL}. Don't start the work until I approve the plan.`,
  }).catch(() => {})
}

async function approve($: EngineInterface) {
  await setGoal($, g => (g ? { ...g, status: 'active' } : g))
  void $.prompt.submit({ text: 'The plan is approved. Start with the first task.' }).catch(() => {})
}

const isTaskStatus = (s: unknown): s is TaskStatus => s === 'pending' || s === 'in_progress' || s === 'done'

export const register: Register = (on, options) => {
  const askOnStart = String(options.askOnStart ?? 'on') !== 'off'

  on('session.start', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    await $.tool.register({
      name: 'plan',
      description: `Propose the plan for the person's session goal: 3 to 8 concrete tasks, in the order you will do them. The person is asked to approve it; the result says whether they did or what to change. Call it when they set a goal (or ask to re-plan); don't start the work before it is approved.`,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal, as the person put it (or a short restatement)' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Task titles, short and imperative, in order' },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update',
      description: `Mark progress on the approved goal plan: status "in_progress" when you start a task, "done" when it is finished. Use the task id from the plan (t1, t2, ...). The goal's progress bar and runner follow it.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The task id, e.g. t2' },
          status: { type: 'string', enum: ['in_progress', 'done', 'pending'] },
        },
        required: ['id', 'status'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'session-goal', description: 'Set a session goal, or show it', argumentHint: '[goal | clear]' })

    // A goal kept for this project from an earlier session: offered to continue, or a new one asked for.
    if (!(await read($, goal))) {
      const saved = await $.store.get(await storeKey($))
      if (saved && typeof saved === 'object') await update($, goal, () => saved as Goal)
    }
    const g = await read($, goal)
    if (g && g.status !== 'done') {
      if (askOnStart) await update($, asking, () => 'resume')
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    } else if (askOnStart) {
      await update($, asking, () => 'new')
    }
    await syncTicking($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const timer of timers.splice(0)) timer.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'session-goal' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await setGoal($, () => null)
      return { text: 'Goal cleared.' }
    }
    if (arg) {
      await startGoal($, arg)
      return { text: `Goal set: ${arg}. Claude will propose a plan.` }
    }
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    const g = await read($, goal)
    return { text: g ? `Goal: ${g.text} (${percentOf(g)}%)` : 'No goal yet. /session-goal <what you want to get done> sets one.' }
  })

  // The plan, put to the person: approved, sent back with their words, or left waiting in the pane.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const input = e as unknown as { goal?: unknown; tasks?: unknown }
    const titles = (Array.isArray(input.tasks) ? input.tasks : []).map(t => clip(String(t ?? '').trim(), 120)).filter(Boolean).slice(0, MAX_TASKS)
    if (!titles.length) return { deny: 'A plan needs at least one task.' }
    const before = await read($, goal)
    const text = clip(String(input.goal ?? '').trim() || before?.text || 'Session goal', 200)
    const tasks: Task[] = titles.map((title, i) => ({ id: `t${i + 1}`, title, status: 'pending', tokens: 0 }))
    const proposed: Goal = { text, status: 'proposed', tasks, activeId: null, other: before?.other ?? 0 }
    await update($, asking, () => null)
    await setGoal($, () => proposed)
    void $.ui.open({ id: PANE, title: PANE_TITLE })

    let answer = ''
    try {
      answer = await $.ui.ask(`${planText(proposed)}\n\nApprove this plan?`, { header: 'Goal plan', options: [APPROVE, CHANGE] })
    } catch {
      answer = ''
    }
    if (answer === APPROVE) {
      await setGoal($, g => (g ? { ...g, status: 'active' } : g))
      return { result: `Approved. ${reminder({ ...proposed, status: 'active' })}` }
    }
    if (!answer.trim()) return { result: "The person hasn't answered; the plan waits for approval in the Goal pane. Don't start the work yet." }
    if (answer === CHANGE) return { result: 'The person wants changes to the plan. Ask what to change, then propose it again with this tool.' }
    return { result: `The person wants changes: ${answer}\nPropose the revised plan with this tool.` }
  })

  on('tool.call', { tool: UPDATE_TOOL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; status?: unknown }
    const g = await read($, goal)
    if (!g || g.status === 'planning' || g.status === 'proposed') return { deny: 'There is no approved plan to update yet.' }
    const id = String(input.id ?? '').trim()
    if (!g.tasks.some(t => t.id === id)) return { deny: `No task "${id}" in the plan; its ids are ${g.tasks.map(t => t.id).join(', ')}.` }
    if (!isTaskStatus(input.status)) return { deny: 'status is "in_progress", "done" or "pending".' }
    const status = input.status
    await setGoal($, cur => {
      if (!cur) return cur
      const tasks = cur.tasks.map(t => (t.id === id ? { ...t, status } : t))
      const activeId = status === 'in_progress' ? id : cur.activeId === id ? null : cur.activeId
      const isDone = tasks.every(t => t.status === 'done')
      return { ...cur, tasks, activeId, status: isDone ? 'done' : 'active' }
    })
    const now = (await read($, goal))!
    if (now.status === 'done') $.ui.toast(`Goal reached: ${now.text}`)
    return { result: `${id} is ${status.replace('_', ' ')}. ${now.tasks.filter(t => t.status === 'done').length}/${now.tasks.length} tasks done (${percentOf(now)}%).${now.status === 'done' ? ' The goal is reached.' : ''}` }
  })

  // Every request's tokens, the sub-agents' too, are counted against the task in progress (else "other").
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    const g = await read($, goal)
    if (u && g && g.status !== 'done') {
      const used = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await setGoal($, cur => {
        if (!cur) return cur
        const active = cur.tasks.find(t => t.id === cur.activeId && t.status === 'in_progress')
        return active
          ? { ...cur, tasks: cur.tasks.map(t => (t.id === active.id ? { ...t, tokens: t.tokens + used } : t)) }
          : { ...cur, other: cur.other + used }
      })
    }
    return r
  }).catch(async function* ($, e, next) { return yield* next(e) })

  // While a goal is worked, each of the person's prompts carries where it stands.
  on('prompt.submit', async ($, e, next) => {
    const g = await read($, goal)
    if (e.command || !g || g.status !== 'active') return next(e)
    return next({ ...e, context: [...(e.context ?? []), reminder(g)] })
  }).catch(($, e, next) => next(e))

  // ---------- the band: the question at the start of a session ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ask = await read($, asking)
    if (e.props.hasSurvey || !ask) return next(e)
    const { Box, Button, Input, Text } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
    const g = await read($, goal)
    const below = await next(e)
    const dismiss = () => update($, asking, () => null)
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1}>
          {ask === 'resume' && g ? (
            <Box flexDirection="column">
              <Text bold color="#d97757">{`🎯 Keep going on your goal? ${g.text} (${percentOf(g)}%)`}</Text>
              <Box flexDirection="row" gap={1}>
                <Button key="resume" label="Continue" hotkey="c" variant="primary" onPress={async () => {
                  await dismiss()
                  await $.ui.open({ id: PANE, title: PANE_TITLE })
                }} />
                <Button key="new-goal" label="New goal" hotkey="n" onPress={async () => {
                  await setGoal($, () => null)
                  await update($, asking, () => 'new')
                }} />
                <Button key="not-now" label="Not now" onPress={dismiss} />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text bold color="#d97757">🎯 Is there a goal you want to work on this session?</Text>
              <Input key="goal" placeholder="e.g. ship the CSV export with tests" submitLabel="set goal" onSubmit={async v => {
                if (v.trim()) await startGoal($, v)
              }} />
              <Box flexDirection="row" gap={1}>
                <Button key="no-goal" label="No goal this time" onPress={dismiss} />
              </Box>
            </Box>
          )}
        </Box>
        {below}
      </Box>
    )
  })

  // ---------- the pane: the goal, the runner and the tasks ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const g = await read($, goal)
    const frame = Math.floor((await read($, tick)) / FRAME_MS)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg

    if (!g) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No goal yet. Type /session-goal and what you want to get done this session.</Text>
        </Box>
      )
    }
    const pose = poseOf(g)
    const done = g.tasks.filter(t => t.status === 'done').length
    const cells = Math.max(16, Math.min(48, e.props.bodyColumns - 4))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="#d97757" wrap="truncate-end">{`🎯 ${g.text}`}</Text>
        {Svg
          ? <Svg source={trackSvg(fractionOf(g), pose, frame)} alt={`${percentOf(g)}% of the way to the goal`} width={TRACK_SIZE.width} height={TRACK_SIZE.height} />
          : <Text color="#d97757">{trackText(fractionOf(g), pose, frame, cells)}</Text>}
        <Box flexDirection="row" gap={2}>
          <Text bold>{`${percentOf(g)}%`}</Text>
          <Text dimColor>{g.tasks.length ? `${done}/${g.tasks.length} tasks` : ''}</Text>
          <Text dimColor>{`${tok(tokensOf(g))} tokens`}</Text>
        </Box>
        {g.status === 'planning' ? <Text dimColor>Claude is drafting the plan…</Text> : null}
        {g.status === 'proposed' ? (
          <Box flexDirection="row" gap={1}>
            <Text color="#c9a227" bold>Proposed plan: approve it to start</Text>
            <Button key="approve" label="Approve plan" variant="primary" onPress={() => approve($)} />
          </Box>
        ) : null}
        {g.status === 'done' ? <Text color="#1f9d6b" bold>Goal reached!</Text> : null}
        {g.tasks.length ? (
          <Box flexDirection="column">
            {g.tasks.map(t => (
              <Box key={`row-${t.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
                <Box flexDirection="row" gap={1}>
                  <Text color={COLOR[t.status]}>{MARK[t.status]}</Text>
                  <Text color={t.status === 'pending' ? undefined : COLOR[t.status]} bold={t.status === 'in_progress'} dimColor={t.status === 'done'} wrap="truncate-end">{t.title}</Text>
                </Box>
                <Text dimColor>{t.tokens ? `${tok(t.tokens)} tokens` : '–'}</Text>
              </Box>
            ))}
            {g.other ? (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text dimColor>Planning and between tasks</Text>
                <Text dimColor>{`${tok(g.other)} tokens`}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1}>
          <Button key="clear" label="Clear goal" plain onPress={() => setGoal($, () => null)} />
        </Box>
      </Box>
    )
  })
}
