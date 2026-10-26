import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Asking, Goal, Pace, Priority, Side, Task, TaskStatus } from '../types'
import { TRACK_SIZE, trackSvg, trackText } from './art'
import type { Pose } from './art'
import { FACTORY_PLAN_APPROVED_ARG, FACTORY_SOURCE, GOAL_REACHED, goalClosedNote, goalPrompt, goalReachedToast, parseDoneResult, parseStartPrompt, PLAN_APPROVED_FOR_FACTORY, PLAN_KEPT_FOR_FACTORY, PLAN_WAITING_FOR_FACTORY, planChangesForFactory, projectFrom, toolText } from './texts'
// The goal-run tests import the start-prompt parser from here, as before it was shared.
export { parseStartPrompt }

// ---------- state ----------

const goal = atom({ plugin: 'goal-run', key: 'goal' } as const, null as Goal | null)
// When the goal this session last loaded or saved was set: a newer one saved by another session wins.
const heldAt = atom({ plugin: 'goal-run', key: 'heldAt' } as const, 0)
// Set once this session was told its goal is no longer the one saved.
const superseded = atom({ plugin: 'goal-run', key: 'superseded' } as const, false)
const asking = atom({ plugin: 'goal-run', key: 'asking' } as const, null as Asking)
const tick = atom({ plugin: 'goal-run', key: 'tick' } as const, 0)
const side = atom({ plugin: 'goal-run', key: 'side' } as const, null as Side | null)

const PANE = 'goal-run'
const PANE_TITLE = 'Goal'
const PLAN_TOOL = 'mcp__goal-run__plan'
const UPDATE_TOOL = 'mcp__goal-run__update'
const ADD_TOOL = 'mcp__goal-run__add'
// The followups mod: its to-do Start submits a prompt under its name, and its done tool closes an item.
const TODO_PLUGIN = 'followups'
const TODO_DONE_TOOL = 'mcp__followups__done'
// The runner's stride: four frames a second while a task is in progress.
const FRAME_MS = 250
const MAX_TASKS = 12

const APPROVE_RUN = 'Approve, run through'
const APPROVE_ASK = 'Approve, ask between tasks'
const APPROVE_BUILD = 'Approve, start building'
const CHANGE = 'Change it'
const ADD_IT = 'Add it'
const NOT_NOW = 'Not now'
const GO_ON = 'Continue'
const STOP_HERE = 'Stop here'
export const paceOf = (g: Goal): Pace => g.pace ?? 'run'
const PACE_TEXT: Record<Pace, string> = { run: 'runs through', ask: 'asks between tasks' }

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
// ---------- priorities ----------

const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
const PRIORITY_MARK: Record<Priority, string> = { high: '▲ high', medium: '■ med', low: '▼ low' }
const PRIORITY_COLOR: Record<Priority, string> = { high: '#e5484d', medium: '#c9a227', low: '#8b8fa3' }
export const priorityOf = (t: Task): Priority => t.priority ?? 'medium'
const isPriority = (p: unknown): p is Priority => p === 'high' || p === 'medium' || p === 'low'

export type PlanItem = { title: string; priority: Priority; dependsOn: number[] }

// The plan as the tool was given it: titles alone (medium), or { title, priority, dependsOn } with
// dependsOn the 1-based places of other tasks in the same list.
export function planItems(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_TASKS).map(r => {
    const o = (r && typeof r === 'object' ? r : { title: r }) as { title?: unknown; priority?: unknown; dependsOn?: unknown }
    return {
      title: clip(String(o.title ?? '').trim(), 120),
      priority: isPriority(o.priority) ? o.priority : 'medium',
      dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map(Number).filter(n => Number.isInteger(n)) : [],
    }
  }).filter(it => it.title)
}

// The order the work runs in: the highest priority whose dependencies are done goes next, ties in
// the order given. Dependencies a cycle makes impossible are dropped, and those tasks keep their place.
export function orderPlan(items: PlanItem[]): Task[] {
  const deps = items.map((it, i) => new Set(it.dependsOn.map(n => n - 1).filter(j => j >= 0 && j < items.length && j !== i)))
  const placed: number[] = []
  const left = new Set(items.map((_, i) => i))
  while (left.size) {
    const ready = [...left].filter(i => [...deps[i]!].every(j => !left.has(j)))
    const pool = ready.length ? ready : [Math.min(...left)]
    const next = pool.sort((a, b) => RANK[items[a]!.priority] - RANK[items[b]!.priority] || a - b)[0]!
    placed.push(next)
    left.delete(next)
  }
  const idOf = new Map(placed.map((orig, k) => [orig, `t${k + 1}`]))
  return placed.map((orig, k) => {
    const it = items[orig]!
    const needs = [...deps[orig]!].filter(j => placed.indexOf(j) < k).map(j => idOf.get(j)!)
    return { id: `t${k + 1}`, title: it.title, status: 'pending', tokens: 0, priority: it.priority, ...(needs.length ? { needs } : {}) }
  })
}

// What a request added: its output, the input it wrote to the cache, and uncached input. Cache reads
// are the context earlier requests already counted; adding them would count it again on every step.
export function stepTokens(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number {
  return u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
}

// Everything a task needs, directly or through another task.
function needsOf(g: Goal, id: string, seen = new Set<string>()): Set<string> {
  for (const n of g.tasks.find(t => t.id === id)?.needs ?? []) {
    if (!seen.has(n)) {
      seen.add(n)
      needsOf(g, n, seen)
    }
  }
  return seen
}

// Moves a pending task one place up or down among the pending tasks; the person's order then stands.
// Dependencies stay first: ↑ carries along the tasks it needs, ↓ the tasks that need it.
export function movePending(g: Goal, id: string, by: -1 | 1): Goal {
  const slots = g.tasks.map((t, i) => (t.status === 'pending' ? i : -1)).filter(i => i >= 0)
  const order = slots.map(i => g.tasks[i]!)
  let lo = order.findIndex(t => t.id === id)
  if (lo < 0) return g
  let hi = lo
  const before = (a: Task, b: Task) => needsOf(g, b.id).has(a.id)
  for (;;) {
    const passed = order[by < 0 ? lo - 1 : hi + 1]
    if (!passed) return g
    const group = order.slice(lo, hi + 1)
    if (!group.some(t => (by < 0 ? before(passed, t) : before(t, passed)))) break
    if (by < 0) lo--
    else hi++
  }
  const group = order.slice(lo, hi + 1)
  const moved = by < 0
    ? [...order.slice(0, lo - 1), ...group, order[lo - 1]!, ...order.slice(hi + 1)]
    : [...order.slice(0, lo), order[hi + 1]!, ...group, ...order.slice(hi + 2)]
  const tasks = [...g.tasks]
  slots.forEach((s, k) => { tasks[s] = moved[k]! })
  return { ...g, tasks }
}

// Where a new task goes: before the first pending task of lower priority, but never ahead of a task it
// needs. Done and in-progress tasks keep their places.
export function insertTask(g: Goal, item: { title: string; priority: Priority; needs: string[] }): { goal: Goal; task: Task; at: number } {
  const id = `t${g.tasks.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0) + 1}`
  const needs = item.needs.filter(n => g.tasks.some(t => t.id === n))
  const task: Task = { id, title: item.title, status: 'pending', tokens: 0, priority: item.priority, ...(needs.length ? { needs } : {}) }
  const floor = Math.max(-1, ...needs.map(n => g.tasks.findIndex(t => t.id === n))) + 1
  let at = g.tasks.findIndex((t, i) => i >= floor && t.status === 'pending' && RANK[priorityOf(t)] > RANK[item.priority])
  if (at < 0) at = g.tasks.length
  const tasks = [...g.tasks.slice(0, at), task, ...g.tasks.slice(at)]
  return { goal: { ...g, tasks, status: g.status === 'done' ? 'active' : g.status }, task, at }
}

// A new plan for a goal already under way keeps the done tasks (their tokens too) ahead of it; the
// tokens of tasks it drops move to "planning and between tasks", so the total stays right.
export function replan(before: Goal | null, text: string, tasks: Task[]): Goal {
  const kept = before && before.status !== 'planning' ? before.tasks.filter(t => t.status === 'done') : []
  const dropped = before ? before.tasks.filter(t => !kept.includes(t)).reduce((n, t) => n + t.tokens, 0) : 0
  const shift = kept.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0)
  const renamed = tasks.map(t => ({ ...t, id: `t${Number(t.id.slice(1)) + shift}`, ...(t.needs ? { needs: t.needs.map(n => `t${Number(n.slice(1)) + shift}`) } : {}) }))
  return {
    text,
    status: 'proposed',
    tasks: [...kept, ...renamed],
    activeId: null,
    other: (before?.other ?? 0) + dropped,
    ...(before?.outside ? { outside: before.outside } : {}),
    ...(before?.pace ? { pace: before.pace } : {}),
    ...(before?.setAt ? { setAt: before.setAt } : {}),
  }
}

const needsText = (t: Task, g: Goal) => (t.needs?.length ? ` (needs ${t.needs.map(id => g.tasks.findIndex(x => x.id === id) + 1).join(', ')})` : '')

// The plan as the person reads it in the approval dialog: in order, each with its priority and what it waits on.
export function planText(g: Goal): string {
  return [
    `Goal: ${g.text}`,
    ...g.tasks.map((t, i) => `${i + 1}. [${priorityOf(t)}] ${t.title}${needsText(t, g)}`),
    'Ordered by priority, dependencies first.',
  ].join('\n')
}

// What the model reads beside each prompt while a goal is being worked: where it stands, and how to move it.
export function reminder(g: Goal): string {
  const done = g.tasks.filter(t => t.status === 'done').length
  return [
    `Session goal: ${g.text}. ${done}/${g.tasks.length} tasks done (${percentOf(g)}%).`,
    ...g.tasks.map(t => `- [${t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending'}] ${t.id} (${priorityOf(t)} priority): ${t.title}${t.needs?.length ? `, needs ${t.needs.join(', ')}` : ''}`),
    `The list is the order to work in: by priority, dependencies first, and as the person may have reordered it. Take the first pending task next, not by its id. When you start a task call ${UPDATE_TOOL} with its id and status "in_progress"; when it is finished, status "done". To add a task the person asks for, use ${ADD_TOOL}, not a new plan.`,
    paceOf(g) === 'run'
      ? 'The person chose to run through: after a task, go straight on to the next pending one. Stop only when you are blocked or need their decision.'
      : 'The person chose to be asked between tasks: marking a task done asks them whether to go on.',
  ].join('\n')
}

// ---------- updates ----------

// Per project: the main repository, so a goal carries over between sessions in different worktrees.
const projects = new Map<string, string>()
async function projectOf($: EngineInterface): Promise<string> {
  const root = await $.session.root()
  const known = projects.get(root)
  if (known) return known
  const out = await $.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: root, timeoutMs: 5_000 }).catch(() => null)
  const project = projectFrom(root, out && out.exitCode === 0 ? out.stdout : '')
  projects.set(root, project)
  return project
}

const storeKey = async ($: EngineInterface) => `goal:${await projectOf($)}`
// Where a goal was saved before the key was the repository: the session's own root.
const legacyKey = async ($: EngineInterface) => `goal:${await $.session.root()}`

async function save($: EngineInterface) {
  const key = await storeKey($)
  const g = await read($, goal)
  const saved = (await $.store.get(key)) as Goal | null | undefined
  // Another session in this project set a newer goal: it stays saved, and this session's copy stays its own.
  if (saved && typeof saved === 'object' && (saved.setAt ?? 0) > (g ? g.setAt ?? 0 : await read($, heldAt))) {
    if (!(await read($, superseded))) {
      await update($, superseded, () => true)
      $.ui.toast("A newer goal was set in another session; progress here isn't saved")
    }
    return
  }
  await $.store.set(key, g)
  await update($, heldAt, () => g?.setAt ?? 0)
  if (await read($, superseded)) await update($, superseded, () => false)
}

// Whether the factory mod is installed: the Goal pane offers to run the goal through it.
let hasFactory = false

// The goal goes to the factory: marked as the factory's, so the spec's plan replaces it (instead of
// being kept apart as the person's own), then /factory runs with its text. A refused command puts
// the goal back as it was.
async function runAsFactory($: EngineInterface) {
  const g = await read($, goal)
  if (!g) return
  await setGoal($, cur => (cur ? { ...cur, source: FACTORY_SOURCE } : cur))
  void $.command.run({ command: 'factory', args: g.text }).catch(async () => {
    await setGoal($, cur => (cur ? { ...cur, source: g.source } : cur))
    $.ui.toast(`Could not start the factory; run /factory ${g.text}`)
  })
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
  const g: Goal = { text: clip(text.trim(), 200), status: 'planning', tasks: [], activeId: null, other: 0, setAt: await $.clock.now() }
  await update($, asking, () => null)
  await setGoal($, () => g)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
  void $.prompt.submit({
    text: `${goalPrompt(g.text)}\n\nBreak it into 3 to 8 concrete tasks and propose them with ${PLAN_TOOL}. Don't start the work until I approve the plan.`,
  }).catch(() => {})
}

async function approve($: EngineInterface, pace: Pace) {
  await setGoal($, g => (g ? { ...g, status: 'active', pace } : g))
  // A factory's plan: the factory starts its builder; the main loop is not asked to work.
  if ((await read($, goal))?.source === FACTORY_SOURCE) {
    void $.command.run({ command: 'factory', args: FACTORY_PLAN_APPROVED_ARG }).catch(() => {})
    return
  }
  void $.prompt.submit({ text: `The plan is approved (${PACE_TEXT[pace]}). Start with the first pending task.` }).catch(() => {})
}

// The to-do items a followups Start prompt names, from its lines "- id <id>: <title>[ (bug)][ — detail][ [where: …]]".

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// Closes the goal task a done to-do item became, and notes it for a side job still waiting to be
// added. Returns the goal's text when that closed the goal, else ''.
async function closeFromTodo($: EngineInterface, ref: string): Promise<string> {
  const g = await read($, goal)
  const task = g?.tasks.find(t => t.followupId && (t.followupId === ref || norm(t.title) === norm(ref)))
  let reached = ''
  if (g && task && task.status !== 'done') {
    await setGoal($, cur => (cur ? withStatus(cur, task.id, 'done') : cur))
    const now = await read($, goal)
    if (now?.status === 'done') {
      $.ui.toast(goalReachedToast(now.text))
      reached = now.text
    }
  }
  await update($, side, cur => {
    if (!cur) return cur
    const item = cur.items.find(it => it.id === ref || norm(it.title) === norm(ref))
    return item && !cur.doneIds.includes(item.id) ? { ...cur, doneIds: [...cur.doneIds, item.id] } : cur
  })
  return reached
}

// One task moved to a status, the goal's active task and done-ness kept in step.
export function withStatus(g: Goal, id: string, status: TaskStatus): Goal {
  const tasks = g.tasks.map(t => (t.id === id ? { ...t, status } : t))
  const activeId = status === 'in_progress' ? id : g.activeId === id ? null : g.activeId
  return { ...g, tasks, activeId, status: tasks.every(t => t.status === 'done') ? 'done' : 'active' }
}

// The side job's items as new tasks at the end of the plan: in progress (or done, if followups closed
// them already), carrying the tokens they used so far, split evenly.
export function addSide(g: Goal, sj: Side): { goal: Goal; taskIds: string[] } {
  const next = g.tasks.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0) + 1
  const share = Math.floor(sj.tokens / Math.max(1, sj.items.length))
  const added: Task[] = sj.items.map((it, i) => ({
    id: `t${next + i}`,
    title: it.title,
    status: sj.doneIds.includes(it.id) ? 'done' : 'in_progress',
    tokens: share + (i === 0 ? sj.tokens - share * sj.items.length : 0),
    priority: it.isBug ? 'high' : 'medium',
    followupId: it.id,
  }))
  const tasks = [...g.tasks, ...added]
  const firstOpen = added.find(t => t.status === 'in_progress')
  return {
    goal: {
      ...g,
      tasks,
      activeId: firstOpen ? firstOpen.id : g.activeId,
      outside: Math.max(0, (g.outside ?? 0) - sj.tokens),
      status: tasks.every(t => t.status === 'done') ? 'done' : 'active',
    },
    taskIds: added.map(t => t.id),
  }
}

async function addSideToGoal($: EngineInterface) {
  const sj = await read($, side)
  const g = await read($, goal)
  if (!sj || !g) return
  const { goal: grown, taskIds } = addSide(g, sj)
  await setGoal($, () => grown)
  await update($, side, cur => (!cur ? cur : cur.isLive ? { ...cur, isAsking: false, taskIds } : null))
}

async function keepSideApart($: EngineInterface) {
  await update($, side, cur => (!cur ? cur : cur.isLive ? { ...cur, isAsking: false } : null))
}

const isTaskStatus = (s: unknown): s is TaskStatus => s === 'pending' || s === 'in_progress' || s === 'done'

export const register: Register = (on, options) => {
  const askOnStart = String(options.askOnStart ?? 'on') !== 'off'
  // Per turn: a person is at the prompt (so a stop can be sent back), and the run-through nudge was used.
  let isInteractive = false
  let isNudged = false

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    for (const timer of timers.splice(0)) timer.cancel()
    await update($, side, () => null)
    await $.tool.register({
      name: 'plan',
      description: `Propose the plan for the person's session goal: 3 to 8 concrete tasks, each with a priority (how much it matters to the goal: high, medium or low) and the tasks it depends on (dependsOn: their 1-based places in this list). The plan is ordered by priority, dependencies first, and the person sees it that way. The person is asked to approve it; the result says whether they did or what to change. Call it when they set a goal (or ask to re-plan); don't start the work before it is approved.`,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal, as the person put it (or a short restatement)' },
          source: { type: 'string', enum: [FACTORY_SOURCE], description: 'Only "factory", when a /factory run asks you to submit its spec\'s tasks: the factory\'s builder then does the work' },
          tasks: {
            type: 'array',
            description: 'The tasks, in any order: the plan orders them',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short and imperative' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                dependsOn: { type: 'array', items: { type: 'integer' }, description: '1-based places in this list of the tasks it needs done first' },
              },
              required: ['title', 'priority'],
            },
          },
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
    await $.tool.register({
      name: 'add',
      description: `Add one task to the approved goal plan, when the person asks for more work during the goal: give it a priority (high, medium or low) and the ids of tasks it needs first. It goes in among the pending tasks by priority, after what it needs, and the person confirms. Use it instead of proposing a new plan; done and in-progress tasks are untouched.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short and imperative' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          needs: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks it needs done first, e.g. ["t2"]' },
        },
        required: ['title', 'priority'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'session-goal', description: 'Set a session goal, or show it', argumentHint: '[goal | clear]' })
    hasFactory = (await $.command.list().catch(() => [])).some(c => c.name === 'factory')

    // A goal kept for this project from an earlier session: offered to continue, or a new one asked for.
    if (!(await read($, goal))) {
      const key = await storeKey($)
      let saved = await $.store.get(key)
      const legacy = await legacyKey($)
      if (!saved && legacy !== key) {
        saved = await $.store.get(legacy)
        if (saved && typeof saved === 'object') await $.store.set(key, saved)
      }
      if (saved && typeof saved === 'object') {
        await update($, goal, () => saved as Goal)
        await update($, heldAt, () => (saved as Goal).setAt ?? 0)
      }
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
    const input = e as unknown as { goal?: unknown; tasks?: unknown; source?: unknown }
    const isFactory = input.source === FACTORY_SOURCE
    const items = planItems(input.tasks)
    if (!items.length) return { deny: 'A plan needs at least one task.' }
    const before = await read($, goal)
    // A factory plan never takes over the person's own goal, and doesn't inherit its done tasks.
    if (isFactory && before && before.source !== FACTORY_SOURCE && before.status !== 'done') return { result: PLAN_KEPT_FOR_FACTORY }
    const text = clip(String(input.goal ?? '').trim() || before?.text || 'Session goal', 200)
    // A plan with no goal set before it is a new goal, set now.
    const proposed = { setAt: await $.clock.now(), ...replan(isFactory ? null : before, text, orderPlan(items)), ...(isFactory ? { source: FACTORY_SOURCE } : {}) }
    await update($, asking, () => null)
    await setGoal($, () => proposed)
    void $.ui.open({ id: PANE, title: PANE_TITLE })

    let answer = ''
    try {
      answer = isFactory
        ? await $.ui.ask(`${planText(proposed)}\n\nThe factory's spec for this goal. Approve it, and the builder starts?`, { header: 'Factory plan', options: [APPROVE_BUILD, CHANGE] })
        : await $.ui.ask(`${planText(proposed)}\n\nApprove this plan? Run straight through the tasks, or be asked before each next one.`, { header: 'Goal plan', options: [APPROVE_RUN, APPROVE_ASK, CHANGE] })
    } catch {
      answer = ''
    }
    if (isFactory) {
      if (answer === APPROVE_BUILD) {
        await setGoal($, g => (g ? { ...g, status: 'active', pace: 'run' } : g))
        return { result: PLAN_APPROVED_FOR_FACTORY }
      }
      if (!answer.trim()) return { result: PLAN_WAITING_FOR_FACTORY }
      return { result: planChangesForFactory(answer === CHANGE ? '' : answer) }
    }
    if (answer === APPROVE_RUN || answer === APPROVE_ASK) {
      const pace: Pace = answer === APPROVE_RUN ? 'run' : 'ask'
      await setGoal($, g => (g ? { ...g, status: 'active', pace } : g))
      return { result: `Approved. ${reminder({ ...proposed, status: 'active', pace })}` }
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
    await setGoal($, cur => (cur ? withStatus(cur, id, status) : cur))
    const now = (await read($, goal))!
    if (now.status === 'done') $.ui.toast(goalReachedToast(now.text))
    const where = `${id} is ${status.replace('_', ' ')}. ${now.tasks.filter(t => t.status === 'done').length}/${now.tasks.length} tasks done (${percentOf(now)}%).`
    const next = now.tasks.find(t => t.status === 'pending')
    if (now.status === 'done') return { result: `${where} ${GOAL_REACHED}` }
    // In a factory run the builder works through the tasks on its own: nothing to ask, nowhere to send it.
    if (status !== 'done' || !next || now.source === FACTORY_SOURCE) return { result: where }
    if (paceOf(now) === 'run') return { result: `${where} Go straight on to ${next.id}: ${next.title}.` }
    // Asked between tasks: the person decides whether the next one starts now.
    const done = now.tasks.find(t => t.id === id)!
    let answer = ''
    try {
      answer = await $.ui.ask(`"${done.title}" is done (${percentOf(now)}%). Go on to "${next.title}"?`, { header: 'Goal', options: [GO_ON, STOP_HERE] })
    } catch {
      answer = ''
    }
    if (answer === GO_ON) return { result: `${where} The person says go on: start ${next.id}: ${next.title}.` }
    if (answer && answer !== STOP_HERE) return { result: `${where} The person says: ${answer}` }
    return { result: `${where} The person wants to stop here. Don't start ${next.id}; sum up where the goal stands and wait for them.` }
  })

  // A task the person asks for mid-goal: put in by its priority among the pending tasks, with their OK.
  on('tool.call', { tool: ADD_TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; priority?: unknown; needs?: unknown }
    const g = await read($, goal)
    if (!g || g.status === 'planning' || g.status === 'proposed') return { deny: `There is no approved plan to add to; propose one with ${PLAN_TOOL}.` }
    const title = clip(String(input.title ?? '').trim(), 120)
    if (!title) return { deny: 'A task needs a title.' }
    const priority: Priority = isPriority(input.priority) ? input.priority : 'medium'
    const needs = Array.isArray(input.needs) ? input.needs.map(n => String(n).trim()) : []
    const { goal: grown, task, at } = insertTask(g, { title, priority, needs })
    const before = grown.tasks[at + 1]
    const place = `#${at + 1}${before ? `, before "${before.title}"` : ', last'}`
    let answer = ''
    try {
      answer = await $.ui.ask(`Add to the goal: [${priority}] ${title}${task.needs ? ` (needs ${task.needs.join(', ')})` : ''}. It goes in as ${place}. Progress ${percentOf(g)}% → ${percentOf(grown)}%.`, { header: 'Goal', options: [ADD_IT, NOT_NOW] })
    } catch {
      answer = ''
    }
    if (answer === ADD_IT) {
      await setGoal($, () => grown)
      return { result: `Added ${task.id} (${priority} priority) as ${place}. ${reminder(grown)}` }
    }
    if (answer && answer !== NOT_NOW) return { result: `Not added yet. The person says: ${answer}` }
    return { result: answer ? 'The person chose not to add it.' : "The person hasn't answered; it wasn't added." }
  })

  // Every request's new tokens, the sub-agents' too, are counted against the task in progress (else "other").
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    const g = await read($, goal)
    const sj = await read($, side)
    if (u && g && sj?.isLive) {
      // Work started from the to-do list: its tasks' once added to the goal, else counted outside it.
      const used = stepTokens(u)
      const into = g.tasks.find(t => sj.taskIds.includes(t.id) && t.status === 'in_progress')
      if (into) {
        await setGoal($, cur => (cur ? { ...cur, tasks: cur.tasks.map(t => (t.id === into.id ? { ...t, tokens: t.tokens + used } : t)) } : cur))
      } else {
        await update($, side, cur => (cur ? { ...cur, tokens: cur.tokens + used } : cur))
        await setGoal($, cur => (cur ? { ...cur, outside: (cur.outside ?? 0) + used } : cur))
      }
    } else if (u && g && g.status !== 'done') {
      const used = stepTokens(u)
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
  // A followups Start is a side job: no goal reminder beside it, its tokens counted apart, and the
  // person asked (in the band) whether its items join the goal. The person's own next prompt ends it.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const g = await read($, goal)
    if (e.origin.kind === 'plugin' && e.origin.name === TODO_PLUGIN) {
      const items = parseStartPrompt(e.text)
      if (g && items.length) {
        await update($, side, () => ({ items, tokens: 0, isAsking: g.status === 'active', taskIds: [], doneIds: [], isLive: true }))
      }
      return next(e)
    }
    if (e.origin.kind === 'composer') isNudged = false
    if (e.origin.kind === 'composer') await update($, side, cur => (!cur ? cur : cur.isAsking ? { ...cur, isLive: false } : null))
    if (!g || g.status !== 'active' || g.source === FACTORY_SOURCE) return next(e)
    return next({ ...e, context: [...(e.context ?? []), reminder(g)] })
  }).catch(($, e, next) => next(e))

  // A to-do item followups marks done closes the goal task it became (or will become, if added later).
  // This hook runs only while goal-run sits above followups, whose own hook answers the tool; the
  // PostToolUse hook below sees the call whatever the order. Closing twice changes nothing.
  on('tool.call', { tool: TODO_DONE_TOOL }, async ($, e, next) => {
    const r = await next(e)
    if (('deny' in r && r.deny) || !parseDoneResult(String(r.result ?? ''))) return r
    const reached = await closeFromTodo($, String((e as unknown as { id?: unknown }).id ?? '').trim())
    // Claude (and brain-hud) learn the goal is reached on this path too.
    if (!reached || 'deny' in r) return r
    return { ...r, context: [...(r.context ?? []), goalClosedNote(reached)] }
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    if (e.tool_name === TODO_DONE_TOOL && parseDoneResult(toolText(e.tool_response))) {
      await closeFromTodo($, String((e.tool_input as { id?: unknown } | null)?.id ?? '').trim())
    }
    return r
  }).catch(($, e, next) => next(e))

  // Running through: a turn that ends with pending tasks left is sent on once, to the next one. Claude
  // may still stop when it is blocked or needs the person; the second stop of a turn always passes.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    const g = await read($, goal)
    const next1 = g?.tasks.find(t => t.status === 'pending')
    if (!isInteractive || isNudged || e.stop_hook_active || r.block || !g || g.status !== 'active' || g.source === FACTORY_SOURCE || paceOf(g) !== 'run' || !next1) return r
    if ((await read($, side))?.isLive) return r
    isNudged = true
    const left = g.tasks.filter(t => t.status !== 'done').length
    return { ...r, block: `The goal still has ${left} task${left === 1 ? '' : 's'} to do, and the person chose to run through. Go on with ${next1.id}: ${next1.title}. If you are blocked or need their decision, say so plainly and stop.` }
  }).catch(($, e, next) => (next.called ? next(e) : {}))

  // ---------- the band: the question at the start of a session ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ask = await read($, asking)
    const sj = await read($, side)
    const g = await read($, goal)
    if (e.props.hasSurvey || (!ask && !(sj?.isAsking && g))) return next(e)
    const { Box, Button, Input: Field, Text } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
    // The mobile app draws no field yet (should the band reach it): there the question points at the command.
    const surface: string = e.surface
    const Input = surface === 'mobile' ? null : Field
    const below = await next(e)
    if (sj?.isAsking && g) {
      const grown = addSide(g, sj).goal
      const names = sj.items.map(it => `"${it.title}"`).join(', ')
      return (
        <Box flexDirection="column">
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="#d97757" wrap="truncate-end">{`➕ Add to your goal? ${names}`}</Text>
            <Text dimColor wrap="truncate-end">{`The plan grows to ${grown.tasks.length} tasks: ${percentOf(g)}% → ${percentOf(grown)}%. Kept apart, its tokens show as outside the goal.`}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="side-add" label="Add to goal" hotkey="g" variant="primary" onPress={() => addSideToGoal($)} />
              <Button key="side-apart" label="Keep it separate" hotkey="k" onPress={() => keepSideApart($)} />
            </Box>
          </Box>
          {below}
        </Box>
      )
    }
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
              {Input ? (
                <Input key="goal" placeholder="e.g. ship the CSV export with tests" submitLabel="set goal" onSubmit={async v => {
                  if (v.trim()) await startGoal($, v)
                }} />
              ) : (
                <Text dimColor>Type /session-goal and your goal to set one.</Text>
              )}
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
    // The track scales down to a narrow pane (about 7 px a cell) rather than running past its edge.
    const trackWidth = Math.min(TRACK_SIZE.width, Math.max(180, e.props.bodyColumns * 7))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="#d97757" wrap="truncate-end">{`🎯 ${g.text}`}</Text>
        {Svg
          ? <Svg source={trackSvg(fractionOf(g), pose, frame)} alt={`${percentOf(g)}% of the way to the goal`} width={trackWidth} height={Math.round((trackWidth * TRACK_SIZE.height) / TRACK_SIZE.width)} />
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
            <Button key="approve" label="Approve, run through" variant="primary" onPress={() => approve($, 'run')} />
            <Button key="approve-ask" label="Approve, ask between" onPress={() => approve($, 'ask')} />
          </Box>
        ) : null}
        {g.status === 'done' ? <Text color="#1f9d6b" bold>Goal reached!</Text> : null}
        {g.tasks.length ? (
          <Box flexDirection="column">
            {g.tasks.map(t => (
              <Box key={`row-${t.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexDirection="row" gap={1}>
                    <Text color={COLOR[t.status]}>{MARK[t.status]}</Text>
                    <Text color={PRIORITY_COLOR[priorityOf(t)]}>{PRIORITY_MARK[priorityOf(t)]}</Text>
                    <Text color={t.status === 'pending' ? undefined : COLOR[t.status]} bold={t.status === 'in_progress'} dimColor={t.status === 'done'} wrap="truncate-end">{t.title}</Text>
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    {t.status === 'pending' ? <Button key={`up-${t.id}`} label="↑" plain onPress={() => setGoal($, cur => (cur ? movePending(cur, t.id, -1) : cur))} /> : null}
                    {t.status === 'pending' ? <Button key={`down-${t.id}`} label="↓" plain onPress={() => setGoal($, cur => (cur ? movePending(cur, t.id, 1) : cur))} /> : null}
                    <Text dimColor>{t.tokens ? `${tok(t.tokens)} tokens` : '–'}</Text>
                  </Box>
                </Box>
                {t.needs?.length && t.status !== 'done' ? <Text dimColor wrap="truncate-end">{`   ${needsText(t, g).trim()}`}</Text> : null}
              </Box>
            ))}
            {g.other ? (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text dimColor>Planning and between tasks</Text>
                <Text dimColor>{`${tok(g.other)} tokens`}</Text>
              </Box>
            ) : null}
            {g.outside ? (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text dimColor>Outside the goal (from the to-do list)</Text>
                <Text dimColor>{`${tok(g.outside)} tokens`}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1}>
          {g.status === 'active' ? (
            <Button key="pace" label={paceOf(g) === 'run' ? '⏩ Runs through · ask between' : '⏸ Asks between · run through'} plain onPress={() => setGoal($, cur => (cur ? { ...cur, pace: paceOf(cur) === 'run' ? 'ask' : 'run' } : cur))} />
          ) : null}
          {hasFactory && g.status !== 'done' && g.source !== FACTORY_SOURCE ? (
            <Button key="factory" label="🏭 Run as factory" plain onPress={() => runAsFactory($)} />
          ) : null}
          <Button key="clear" label="Clear goal" plain onPress={() => setGoal($, () => null)} />
        </Box>
      </Box>
    )
  })
}
