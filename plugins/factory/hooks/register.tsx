import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Blocked, Check, Finding, Phase, Reviewer, Role, Run } from '../types'
import { buildRound, DIAGRAM, diagramSvg, pipelineLines } from './art'
import type { Theme } from './art'
import {
  approvePrompt,
  buildPrompt,
  cleanFeature,
  detectChecks,
  detectSetup,
  isLive,
  neverCommit,
  newRun,
  openFindings,
  parseDecision,
  parseTasks,
  parseVerdict,
  planPrompt,
  prPrompt,
  reviewPrompt,
  ROLE_PROMPTS,
  ROLES,
  slugOf,
  titleOf,
  specPrompt,
  splitChecks,
  tailOf,
  takeOverNote,
  tok,
  tokensOf,
  untrackedOf,
  leftOut,
  waitsOnPerson,
  modelOf,
  modelsFor,
  parseSize,
  parseSkills,
  skillsLine,
  builtinSkill,
  lastLines,
  isLimitError,
  progressNote,
  resumePrompt,
} from './flow'
import { FACTORY_PLAN_APPROVED_ARG, FACTORY_START_TOOL, factoryArgs, parseFactoryArgs, parseGoalPrompt, parsePlanOutcome, parseStartPrompt, toolText } from './texts'

const run = atom({ plugin: 'factory', key: 'run' } as const, null as Run | null)
const frame = atom({ plugin: 'factory', key: 'frame' } as const, 0)
const theme = atom({ plugin: 'factory', key: 'theme' } as const, 'dark' as Theme)
// The agents of runs that were stopped, newest last: their tool calls stay refused after a new run starts.
const stoppedAgents = atom({ plugin: 'factory', key: 'stoppedAgents' } as const, [] as string[])
const MAX_STOPPED = 50

const PANE = 'factory'
const PANE_TITLE = 'Factory'
const PLAN_TOOL = 'mcp__goal-run__plan'
const MAX_CHECK_ROUNDS = 2
const MAX_SLUG_TRIES = 5
const CHECK_TIMEOUT_MS = 600_000
const FRAME_MS = 700
const ACCENT = '#2563eb'
const START_TOOL = FACTORY_START_TOOL
const FROM_CONVERSATION = `Start a factory run on the work this conversation is about: call ${START_TOOL} with the feature (what to build, in a short paragraph, naming the file, issue or to-do item it comes from; a to-do item's id as followupId). If there is no such work yet, ask me what the factory should build. Don't do the work yourself.`
const STARTED_NOTE = "The factory does the work from here: don't start it yourself or propose a plan. Tell the person in one line, and that its plan comes up for their approval."
const STOPPED_DENY = 'The factory run was stopped. Stop now and answer with one line.'

// Set from the options when the module registers.
let maxRounds = 2
let checksOption = ''
let setupOption = ''
let autoPr = false
// A goal set in goal-run, or a to-do item started in followups, becomes a factory run.
let takeOver = true
let modelsOption: 'auto' | 'fixed' = 'auto'
let skillsOption: Partial<Record<Role, string[]>> = {}
// A role's skills: the option's for it, else the factory's own.
const skillsOf = (role: Role) => skillsOption[role] ?? [builtinSkill(role)]
// Transitions run one at a time: two reviewers finishing together must not both start the approver.
// Every spawn and every agent's completion goes through this queue, so a completion is handled only
// after the job that spawned its agent has recorded the agent's id.
let queue: Promise<void> = Promise.resolve()
const timers: { cancel: () => void }[] = []

function serial(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job, job).catch(() => {})
  return queue
}

async function patch($: EngineInterface, fn: (r: Run) => Run): Promise<Run | null> {
  return update($, run, cur => (cur ? fn(cur) : cur))
}

// A move to a phase the run works in clears what it was blocked on.
const moveTo = (r: Run, phase: Phase, note: string): Run => ({ ...r, phase, note, blocked: null })

async function block($: EngineInterface, blocked: Blocked, note: string, fn: (r: Run) => Run = r => r) {
  // A run stopped meanwhile stays stopped.
  await patch($, r => (isLive(r.phase) ? { ...fn(r), phase: 'needs-human', blocked, note } : r))
}

async function git($: EngineInterface, args: string[], cwd?: string) {
  return $.process.run(['git', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
}

async function run$($: EngineInterface, argv: string[], cwd: string) {
  return $.process.run(argv, { cwd, timeoutMs: CHECK_TIMEOUT_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
}

const describe = (role: Role, r: Run) =>
  role === 'builder' ? `builder, round ${buildRound(r)}` : role === 'spec' ? 'spec-writer' : role === 'approver' ? 'approver' : `${ROLES[role].label} review`

const goalRunThere = async ($: EngineInterface) => (await $.command.list().catch(() => [])).some(c => c.name === 'session-goal')

// Starts one role's agent in the run's worktree. A role type the engine refused to register falls
// back to a general-purpose agent carrying the role's instructions in its prompt.
// Each agent's spawn, by id: what a retry needs (the reload of the module forgets them; the step
// then waits for Retry instead).
const spawns = new Map<string, { role: Role; prompt: string; hasModel: boolean; isRetry: boolean }>()

async function spawnRole($: EngineInterface, role: Role, prompt: string, { onSessionModel = false } = {}): Promise<boolean> {
  const r = await read($, run)
  if (!r || !isLive(r.phase)) return false
  const spec = ROLES[role]
  const job = prompt
  // A builder started on a worktree that already has work: told what is there, from git.
  if (role === 'builder') {
    const [log, status] = await Promise.all([git($, ['log', '--oneline', `${r.base}..HEAD`], r.worktree), git($, ['status', '--porcelain'], r.worktree)])
    const note = progressNote(log.exitCode === 0 ? log.stdout : '', status.exitCode === 0 ? status.stdout : '')
    if (note) prompt = `${note}\n\n${prompt}`
  }
  const skills = skillsOf(role)
  if (skills.length) prompt = `${skillsLine(skills)}\n\n${prompt}`
  const base = { prompt, description: `factory · ${describe(role, r)}`, ...(onSessionModel ? {} : { model: modelOf(r, role) }), cwd: r.worktree }
  let res = await $.agent.spawn({ ...base, subagentType: `factory:${spec.name}` }).catch(err => ({ deny: String(err) }) as { deny: string })
  if ('deny' in res && res.deny) {
    res = await $.agent.spawn({ ...base, subagentType: 'general-purpose', prompt: `${ROLE_PROMPTS[role]}\n\n${prompt}` }).catch(err => ({ deny: String(err) }) as { deny: string })
  }
  if ('deny' in res && res.deny) {
    await block($, { on: 'start', role }, `Could not start the ${describe(role, r)}: ${res.deny}`)
    return false
  }
  // Without an id in the answer, the agent is found in the session's list by its description.
  const id = (res as { agentId?: string }).agentId ?? (await $.agent.list().catch(() => [])).filter(a => a.description === base.description && !r.agents[a.id]).at(-1)?.id
  if (!id) {
    await block($, { on: 'start', role }, `Started the ${describe(role, r)}, but can't follow it: no agent id.`)
    return false
  }
  await patch($, cur => ({
    ...cur,
    agents: { ...cur.agents, [id]: role },
    ...(role === 'builder' ? { builderId: id } : {}),
    reviews: cur.reviews.map(x => (x.role === role ? { ...x, agentId: id } : x)),
  }))
  spawns.set(id, { role, prompt: job, hasModel: !onSessionModel, isRetry: onSessionModel })
  return true
}

// Why an agent's turn ended without its answer: what the step's note says, '' when it answered.
export function whyEnded(e: { reason: string; answer: string; refusal?: { explanation: string | null } }): string {
  if (e.reason === 'answer') return ''
  if (e.reason === 'aborted') return 'it was interrupted'
  if (e.reason === 'refusal') return `the model refused${e.refusal?.explanation ? `: ${e.refusal.explanation}` : ''}`
  const said = e.answer.trim()
  return `an API error ended it${said ? `: ${tailOf(said, 1)}` : ''}`
}

// What a goal prompt or a one-item Start prompt hands the factory: /factory's arguments, else null.
// Several items started together stay the main Claude's.
export function takeOverArgs(text: string): string | null {
  const goal = parseGoalPrompt(text)
  if (goal) return goal
  const items = parseStartPrompt(text)
  if (items.length !== 1) return null
  const it = items[0]!
  const line = new RegExp(`^- id ${it.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`, 'm').exec(text)?.[1] ?? it.title
  return factoryArgs(line.replace(/ \(bug\)/, '').replace(/ \[where: ([^\]]*)\]$/, ' ($1)'), it.id)
}

async function start($: EngineInterface, args: string): Promise<string> {
  const parsed = parseFactoryArgs(args)
  const feature = cleanFeature(parsed.feature)
  const followupId = parsed.followupId
  if (!feature) return 'What should the factory build? /factory <feature>'
  const cur = await read($, run)
  if (cur && isLive(cur.phase)) return `A factory run is already going: ${titleOf(cur.feature, 120)}. /factory stop ends it.`
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return 'The factory needs a git repository: it builds on a branch, in a worktree of its own.'
  const root = top.stdout.trim()
  const head = await git($, ['rev-parse', 'HEAD'], root)
  if (head.exitCode !== 0) return 'The repository has no commit yet to build from.'
  const at = await $.clock.now()
  const slug = slugOf(feature)
  let r: Run | null = null
  // A branch or folder name already taken gets a number; any other failure is reported as it is.
  for (let k = 1; k <= MAX_SLUG_TRIES && !r; k++) {
    const next = newRun(feature, at, head.stdout.trim(), root, k === 1 ? slug : `${slug}-${k}`)
    const added = await git($, ['worktree', 'add', '-b', next.branch, next.worktree, next.base], root)
    if (added.exitCode === 0) r = next
    else if (!/already exists/i.test(added.stderr)) return `Could not create a worktree for the run: ${tailOf(added.stderr, 3)}`
  }
  if (!r) return `Could not create a worktree for the run: the branches factory/${slug} to factory/${slug}-${MAX_SLUG_TRIES} are all taken.`
  const created: Run = { ...r, gate: (await goalRunThere($)) ? 'goal-run' : 'factory', ...(followupId ? { followupId } : {}) }
  await keepOutOfGit($, root)
  await readTheme($)
  await update($, run, () => created)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
  await serial(async () => void (await spawnRole($, 'spec', specPrompt(created))))
  return `Factory run started: ${titleOf(created.feature, 120)}. Branch ${created.branch}, worktree ${created.worktree}; the spec-writer is writing ${created.specFile}.`
}

// The worktrees live in .factory/ of the repository: listed in its exclude file, found through
// git (a .git that is a file, in a worktree or a submodule, has it elsewhere), never committed.
async function keepOutOfGit($: EngineInterface, root: string) {
  const found = await git($, ['rev-parse', '--git-path', 'info/exclude'], root)
  if (found.exitCode !== 0 || !found.stdout.trim()) return
  const rel = found.stdout.trim()
  const path = /^([a-zA-Z]:)?[\\/]/.test(rel) ? rel : `${root}/${rel}`
  const text = await $.fs.read(path).then(t => String(t), () => '')
  if (/^\.factory\/$/m.test(text)) return
  await $.fs.write(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.factory/\n`).catch(() => {})
}

// The diagram's palette follows the theme set in /config; dark when it can't be read.
async function readTheme($: EngineInterface) {
  const row = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')
  const value = String((row as { value?: unknown } | undefined)?.value ?? '')
  await update($, theme, () => (/light/i.test(value) ? 'light' : 'dark'))
}

async function onSpec($: EngineInterface, answer: string, why: string) {
  const tasks = why ? [] : parseTasks(answer)
  if (!tasks.length) {
    await block($, { on: 'spec' }, why ? `The spec-writer stopped: ${why}.` : 'The spec-writer gave no TASKS list.', r => ({ ...r, steps: { ...r.steps, spec: { ...r.steps.spec, state: 'fail' } } }))
    return
  }
  // goal-run is asked again: installed or removed since the run started, the plan goes where it can.
  const viaGoalRun = (await read($, run))?.gate === 'goal-run' && (await goalRunThere($))
  const size = parseSize(answer)
  const r = await patch($, cur => ({
    ...moveTo(cur, 'plan', 'waiting for you to approve the plan'),
    tasks,
    ...(size ? { size } : {}),
    models: { ...modelsFor(size, modelsOption), spec: modelOf(cur, 'spec') },
    gate: viaGoalRun ? 'goal-run' : 'factory',
    steps: { ...cur.steps, spec: { ...cur.steps.spec, state: 'pass' } },
  }))
  if (r && viaGoalRun) void $.prompt.submit({ text: planPrompt(r) }).catch(() => {})
  else if (r) void askPlan($)
}

// The PR, put to the person in the conversation once the approver approved or escalated: what was
// built and why, with Open (or Approve anyway), Not now, or what to change under Other (a rework).
const OPEN_PR = 'Open the PR'
const APPROVE_ANYWAY = 'Approve the PR anyway'
async function askPr($: EngineInterface) {
  const r = await read($, run)
  const escalated = r?.phase === 'needs-human' && r.blocked?.on === 'escalate'
  if (!r || (r.phase !== 'ready' && !escalated)) return
  const yes = escalated ? APPROVE_ANYWAY : OPEN_PR
  const lines = [
    `The factory's change for "${titleOf(r.feature, 120)}" ${escalated ? 'was escalated by the approver' : 'was approved'}: ${r.note}`,
    ...(r.stat || r.summary ? [`Changed: ${[r.stat, r.summary].filter(Boolean).join(' · ')}`] : []),
    `Branch ${r.branch}${r.recorded ? `; what each step said is in ${r.record}/` : ''}.`,
    '',
    `${escalated ? 'Approve it anyway' : 'Open the PR'}? To send it back to the builder, say what to change under Other.`,
  ]
  let answer = ''
  try {
    answer = await $.ui.ask(lines.join('\n'), { header: 'Factory PR', options: [yes, NOT_NOW] })
  } catch {
    return
  }
  const now = await read($, run)
  if (!now || now.phase !== r.phase) return
  if (answer === yes) return void (await approveNow($))
  if (answer && answer !== NOT_NOW) return void (await reworkNow($, answer))
}

// Without goal-run's dialog, the plan is put to the person in the engine's own: in the main
// conversation, not only in the band. "Other" carries what to change.
const APPROVE_PLAN = 'Approve and build'
const NOT_NOW = 'Not now'
async function askPlan($: EngineInterface) {
  const r = await read($, run)
  if (!r || r.phase !== 'plan' || r.gate !== 'factory') return
  const tasks = r.tasks.map((t, i) => `${i + 1}. [${t.priority}] ${t.title}`).join('\n')
  let answer = ''
  try {
    answer = await $.ui.ask(`The factory's plan for "${titleOf(r.feature, 120)}"${r.size ? ` (${r.size})` : ''}, spec in ${r.specFile}:\n${tasks}\n\nApprove it, and the builder starts? To change it, say what under Other.`, { header: 'Factory plan', options: [APPROVE_PLAN, NOT_NOW] })
  } catch {
    return
  }
  // Answered in the band meanwhile, or stopped: nothing left to decide here.
  if ((await read($, run))?.phase !== 'plan') return
  if (answer === APPROVE_PLAN) return void serial(() => onPlan($, { approved: true }))
  if (answer && answer !== NOT_NOW) return void serial(() => respec($, answer))
}

async function onPlan($: EngineInterface, outcome: { approved: true } | { changes: string } | { kept: true }) {
  const r = await read($, run)
  if (!r || r.phase !== 'plan') return
  if ('approved' in outcome) return startBuild($, [], [])
  // The person has a goal of their own in goal-run: the factory's band asks instead.
  if ('kept' in outcome) {
    await patch($, cur => ({ ...cur, gate: 'factory', note: 'waiting for you to approve the plan (here: goal-run keeps your own goal)' }))
    return void askPlan($)
  }
  await respec($, outcome.changes || 'The person asked for changes to the plan.')
}

async function respec($: EngineInterface, feedback = '') {
  const r = await patch($, cur => ({ ...moveTo(cur, 'spec', feedback ? 'revising the spec' : 'writing the spec'), steps: { ...cur.steps, spec: { ...cur.steps.spec, state: 'run' } } }))
  if (r) await spawnRole($, 'spec', specPrompt(r, feedback))
}

async function startBuild($: EngineInterface, findings: Finding[], failed: Check[], said = '', resume = '') {
  const note = resume ? 'the builder carries on' : said ? 'reworking it as you asked' : failed.length ? 'fixing the checks' : findings.length ? `fixing ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'building'
  const r = await patch($, cur => ({ ...moveTo(cur, 'build', note), steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'run' } } }))
  if (!r) return
  // A later round goes back to the builder that built it: it keeps what it read and why, and its
  // prompt cache. A message it can't take (gone, refused) starts a new builder with the whole job.
  if (r.builderId) {
    // A builder that stopped mid-job carries on; one that finished a round gets the next.
    const prompt = resume ? resumePrompt(resume) : buildPrompt(r, findings, failed, { again: true, note: said })
    const sent = await $.session.send({ to: { agentId: r.builderId }, text: prompt }).then(x => x.isDelivered, () => false)
    if (sent) {
      const before = spawns.get(r.builderId)
      spawns.set(r.builderId, { role: 'builder', prompt: buildPrompt(r, findings, failed, { note: said }), hasModel: before?.hasModel ?? true, isRetry: false })
      return
    }
  }
  await spawnRole($, 'builder', buildPrompt(r, findings, failed, { note: said }))
}

// What the builder left uncommitted is committed by the factory: reviewers and the PR see the same
// commits. Tracked changes all go in; a new file only when it isn't installed dependencies, build
// output or a credential (those are left out, and the run's note says so).
async function onBuilt($: EngineInterface) {
  const r = await read($, run)
  if (!r) return
  const status = await git($, ['status', '--porcelain', '-z', '-uall'], r.worktree)
  if (status.exitCode === 0 && status.stdout.trim()) {
    const untracked = untrackedOf(status.stdout)
    const skipped = leftOut(untracked.filter(neverCommit))
    const fresh = untracked.filter(p => !neverCommit(p))
    let out = await git($, ['add', '-u'], r.worktree)
    if (out.exitCode === 0 && fresh.length) out = await git($, ['add', '--', ...fresh], r.worktree)
    const staged = out.exitCode === 0 ? await git($, ['diff', '--cached', '--quiet'], r.worktree) : out
    if (out.exitCode === 0 && staged.exitCode !== 0) out = await git($, ['commit', '-m', `factory: ${titleOf(r.feature, 64)}`, ...(titleOf(r.feature, 64) !== r.feature.trim() ? ['-m', r.feature.trim()] : [])], r.worktree)
    if (out.exitCode !== 0) {
      await block($, { on: 'builder' }, `The builder's work could not be committed: ${tailOf(`${out.stdout}\n${out.stderr}`, 2)}`)
      return
    }
    if (skipped.length) await patch($, cur => ({ ...cur, skipped }))
  }
  const stat = await git($, ['diff', '--stat', r.base, 'HEAD'], r.worktree)
  if (stat.exitCode === 0 && stat.stdout.trim()) {
    await patch($, cur => ({ ...cur, stat: lastLines(stat.stdout, 1) }))
    await record($, `changes after builder round ${r.round + 1}`, stat.stdout)
  }
  await runChecks($)
}

async function namesIn($: EngineInterface, dir: string) {
  return (await $.fs.list(dir).catch(() => [])).map(f => f.name)
}

async function checkCommands($: EngineInterface, worktree: string, files: string[]): Promise<string[][]> {
  if (checksOption.trim()) return splitChecks(checksOption)
  const pkg = files.includes('package.json') ? await $.fs.read(`${worktree}/package.json`).then(t => String(t), () => null) : null
  return detectChecks(files, pkg)
}

// A fresh worktree has no dependencies installed: the `setup` option, or the lockfile's install, runs
// once a run before its first checks. Its failure is the person's to look at, not the builder's.
async function setUp($: EngineInterface, r: Run, files: string[]): Promise<boolean> {
  if (r.setupDone) return true
  const cmds = setupOption.trim() ? splitChecks(setupOption) : [detectSetup(files)].filter((c): c is string[] => c !== null)
  for (const argv of cmds) {
    if (!(await stillIn($, 'checks'))) return false
    await patch($, cur => ({ ...cur, note: `installing: ${argv.join(' ')}` }))
    const out = await run$($, argv, r.worktree)
    if (out.exitCode !== 0) {
      const check: Check = { cmd: argv.join(' '), ok: false, tail: tailOf(`${out.stdout}\n${out.stderr}`) }
      await block($, { on: 'setup' }, `The setup failed: ${check.cmd}. Fix it (or set the setup option), then Retry.`, cur => ({ ...cur, checks: [check], steps: { ...cur.steps, checks: { ...cur.steps.checks, state: 'fail' } } }))
      return false
    }
  }
  await patch($, cur => ({ ...cur, setupDone: true }))
  return true
}

// The files that decide what an auto-detected command does: its scripts, its install, its test hooks.
const CHECK_CONFIGS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'go.mod', 'Cargo.toml', ':(glob)**/conftest.py']
const RUN_THEM = 'Run them'

// Commands the factory found itself run outside the session's permission prompts, in a worktree the
// builder just wrote: the person lets them run first, and again whenever the files that define them
// change. Commands set in the checks and setup options are the person's own and aren't asked about.
async function approveAuto($: EngineInterface, r: Run, cmds: string[][]): Promise<boolean> {
  const last = await git($, ['log', '-1', '--format=%H', 'HEAD', '--', ...CHECK_CONFIGS], r.worktree)
  const key = `${cmds.map(c => c.join(' ')).join('; ')} @ ${last.stdout.trim()}`
  if (r.autoApproved === key) return true
  const changed = await git($, ['diff', '--name-only', r.base, 'HEAD', '--', ...CHECK_CONFIGS], r.worktree)
  const touched = changed.exitCode === 0 ? changed.stdout.trim().split('\n').filter(Boolean) : []
  const question = [
    `Before the factory runs the checks it found in the project, in ${r.worktree}:`,
    ...cmds.map(c => `$ ${c.join(' ')}`),
    ...(touched.length ? ['', `The builder changed what these run: ${touched.join(', ')}. Look at that diff before you let them run.`] : []),
    '',
    'They run outside your permission prompts. Run them? (The checks and setup options set them for good.)',
  ].join('\n')
  let answer = ''
  try {
    answer = await $.ui.ask(question, { header: 'Factory checks', options: [RUN_THEM, NOT_NOW] })
  } catch {
    answer = ''
  }
  if (answer === RUN_THEM) {
    await patch($, cur => ({ ...cur, autoApproved: key }))
    return true
  }
  await block($, { on: 'checks' }, 'The checks wait for your OK to run the commands the factory found: Retry asks again, or set the checks and setup options.', cur => ({ ...cur, steps: { ...cur.steps, checks: { ...cur.steps.checks, state: 'wait' } } }))
  return false
}

async function stillIn($: EngineInterface, phase: Run['phase']) {
  return (await read($, run))?.phase === phase
}

async function runChecks($: EngineInterface) {
  const r = await patch($, cur => ({
    ...moveTo(cur, 'checks', 'running the checks'),
    steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'pass' }, checks: { ...cur.steps.checks, state: 'run' } },
    checkRound: cur.checkRound + 1,
  }))
  if (!r) return
  const files = await namesIn($, r.worktree)
  const auto = [
    ...(!r.setupDone && !setupOption.trim() ? [detectSetup(files)].filter((c): c is string[] => c !== null) : []),
    ...(!checksOption.trim() ? await checkCommands($, r.worktree, files) : []),
  ]
  if (auto.length && !(await approveAuto($, r, auto))) return
  if (!(await setUp($, r, files))) return
  const cmds = await checkCommands($, r.worktree, files)
  await patch($, cur => ({ ...cur, note: 'running the checks' }))
  const results: Check[] = []
  for (const argv of cmds) {
    // A Stop meanwhile ends the checks here: the rest don't run for nothing.
    if (!(await stillIn($, 'checks'))) return
    const out = await run$($, argv, r.worktree)
    results.push({ cmd: argv.join(' '), ok: out.exitCode === 0, tail: out.exitCode === 0 ? '' : tailOf(`${out.stdout}\n${out.stderr}`) })
  }
  const failed = results.filter(c => !c.ok)
  if (results.length) await record($, 'checks', results.map(c => `${c.ok ? '✓' : '✗'} ${c.cmd}${c.tail ? `\n${c.tail}` : ''}`).join('\n'))
  const after = await patch($, cur => ({ ...cur, checks: results, steps: { ...cur.steps, checks: { ...cur.steps.checks, state: !cmds.length ? 'skip' : failed.length ? 'fail' : 'pass' } } }))
  if (!after || after.phase !== 'checks') return
  if (!failed.length) return startReviews($)
  if (after.checkRound < MAX_CHECK_ROUNDS) return startBuild($, [], failed)
  await block($, { on: 'checks' }, `The checks still fail after ${after.checkRound} builder passes: ${failed.map(c => c.cmd).join(', ')}.`)
}

// Every reviewer looks at every round: a fix for one reviewer is new code for the others too.
async function startReviews($: EngineInterface) {
  const r = await patch($, cur => {
    const round = cur.round + 1
    return {
      ...moveTo(cur, 'review', `reviewing, round ${round}`),
      round,
      checkRound: 0,
      reviews: cur.reviews.map(x => ({ ...x, state: 'run', findings: [], round, agentId: null })),
    }
  })
  if (r) await spawnReviewers($, r)
}

// The reviewers of this round not started yet (all of them, or those a failed start left).
async function spawnReviewers($: EngineInterface, r: Run) {
  const stat = await git($, ['diff', '--stat', r.base, 'HEAD'], r.worktree)
  for (const x of r.reviews.filter(v => v.round === r.round && v.state === 'run' && !v.agentId)) {
    if (!(await spawnRole($, x.role, reviewPrompt(r, x.role, stat.exitCode === 0 ? stat.stdout.trim() : '')))) return
  }
}

async function onReview($: EngineInterface, role: Reviewer, agentId: string, answer: string, why: string) {
  const verdict = !why ? parseVerdict(answer) : { state: 'fail' as const, findings: [{ severity: 'major' as const, where: '-', text: `The reviewer stopped: ${why}.` }] }
  const r = await patch($, cur => ({ ...cur, reviews: cur.reviews.map(x => (x.role === role && x.agentId === agentId ? { ...x, state: verdict.state, findings: verdict.findings } : x)) }))
  if (!r || r.phase !== 'review') return
  const mine = r.reviews.filter(x => x.round === r.round)
  if (mine.some(x => x.state === 'run')) return
  // A reviewer that ended without a verdict (an API error, say) didn't review: the run waits for a
  // Retry rather than sending the builder after a "finding" that isn't one, or the approver ahead.
  const failed = mine.find(x => x.state === 'fail')
  if (failed) return block($, { on: 'start', role: failed.role }, `${failed.findings[0]?.text ?? 'The reviewer stopped.'} The ${failed.role} review didn't run; Retry runs it again.`)
  const changes = mine.filter(x => x.state === 'changes')
  if (changes.length && r.round < maxRounds) return startBuild($, openFindings(changes), [])
  await startApprover($)
}

async function startApprover($: EngineInterface) {
  const r = await patch($, cur => ({ ...moveTo(cur, 'approve', 'the approver is deciding'), steps: { ...cur.steps, approver: { ...cur.steps.approver, state: 'run' } } }))
  if (r) await spawnRole($, 'approver', approvePrompt(r))
}

async function onApprover($: EngineInterface, answer: string, why: string) {
  // An approver that ended without a decision decided nothing: Retry, not an escalation to approve past.
  if (why) return block($, { on: 'start', role: 'approver' }, `The approver stopped before deciding: ${why}. Retry runs it again.`, r => ({ ...r, steps: { ...r.steps, approver: { ...r.steps.approver, state: 'fail' } } }))
  const { decision, reason } = parseDecision(answer)
  if (decision === 'ESCALATE') {
    await block($, { on: 'escalate' }, reason, r => ({ ...r, steps: { ...r.steps, approver: { ...r.steps.approver, state: 'changes' } } }))
    $.ui.toast('The factory needs you: Approve PR, /factory rework <what to change>, or /factory stop')
    void askPr($)
    return
  }
  // The approver is an agent: the PR, outward-facing, waits for the person unless autoPr is on.
  if (autoPr) return finish($, reason)
  await patch($, r => ({ ...moveTo(r, 'ready', `approved${reason ? `: ${reason}` : ''}. Open the PR when you're ready`), steps: { ...r.steps, approver: { ...r.steps.approver, state: 'pass' } } }))
  $.ui.toast('The approver approved the change: Open PR in the factory band, /factory approve, or /factory rework <what to change>')
  void askPr($)
}

// Approved by the person (or by the approver, with autoPr on): the main Claude opens the PR.
async function finish($: EngineInterface, reason: string) {
  const r = await patch($, cur => ({ ...moveTo(cur, 'done', reason || 'approved'), steps: { ...cur.steps, approver: { ...cur.steps.approver, state: 'pass' } } }))
  if (!r) return
  void $.prompt.submit({ text: prPrompt(r, reason) }).catch(() => {
    $.ui.toast(`Approved. Open a PR from ${r.branch} yourself; the prompt could not be sent.`)
  })
}

// The run's record: each step's own words in a numbered file, beside the worktree and out of git,
// so what the factory did can be read after the fact. A run from before the record keeps none.
async function record($: EngineInterface, label: string, body: string) {
  const r = await patch($, cur => (cur.record ? { ...cur, recorded: (cur.recorded ?? 0) + 1 } : cur))
  if (!r?.record || !body.trim()) return
  const name = `${String(r.recorded ?? 1).padStart(2, '0')}-${slugOf(label)}.md`
  await $.fs.write(`${r.record}/${name}`, `# ${label}\n\n${body.trim()}\n`).catch(() => {})
}

async function onAgentDone($: EngineInterface, agentId: string, answer: string, why: string, isApiError: boolean) {
  const r = await read($, run)
  const role = r?.agents[agentId]
  if (!r || !role || !isLive(r.phase)) return
  // An API error on the role's own model (one the account can't use, say): once, the same agent
  // again on the session's model.
  const spawn = spawns.get(agentId)
  if (isApiError && spawn && spawn.hasModel && !spawn.isRetry && !isLimitError(why)) {
    await patch($, cur => ({ ...cur, note: `the ${describe(role, cur)} failed on ${modelOf(cur, role)} (${why}); trying the session's model` }))
    if (await spawnRole($, role, spawn.prompt, { onSessionModel: true })) return
  }
  await record($, describe(role, r), why ? `Stopped: ${why}.${answer.trim() ? `\n\n${answer}` : ''}` : answer)
  if (role === 'spec') return r.phase === 'spec' ? onSpec($, answer, why) : undefined
  if (role === 'builder') {
    if (r.phase !== 'build') return
    if (!why && answer.trim()) await patch($, cur => ({ ...cur, summary: lastLines(answer, 2) }))
    if (why) return block($, { on: 'builder', why }, `The builder stopped: ${why}.${isLimitError(why) ? ' Retry once the limit is lifted: the same builder carries on.' : ''}`, cur => ({ ...cur, steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'fail' } } }))
    return onBuilt($)
  }
  if (role === 'approver') return r.phase === 'approve' ? onApprover($, answer, why) : undefined
  return onReview($, role, agentId, answer, why)
}

async function addTokens($: EngineInterface, agentId: string, n: number) {
  await patch($, r => {
    const role = r.agents[agentId]
    if (!role || !n) return r
    if (role === 'security' || role === 'code') return { ...r, reviews: r.reviews.map(x => (x.role === role ? { ...x, tokens: x.tokens + n } : x)) }
    const key = role === 'spec' ? 'spec' : role === 'builder' ? 'builder' : 'approver'
    return { ...r, steps: { ...r.steps, [key]: { ...r.steps[key], tokens: r.steps[key].tokens + n } } }
  })
}

// Approve: the plan, the PR the approver approved, or a change the approver escalated. Anything else
// that stopped the run isn't approved past: it's retried or the run is stopped.
async function approveNow($: EngineInterface): Promise<string> {
  const r = await read($, run)
  if (!r) return 'No factory run.'
  // Queued, not awaited: a prompt submitted while the command's hook still runs is refused.
  if (r.phase === 'plan') {
    void serial(() => onPlan($, { approved: true }))
    return 'Plan approved: the builder starts.'
  }
  if (r.phase === 'ready' || (r.phase === 'needs-human' && r.blocked?.on === 'escalate')) {
    void serial(() => finish($, r.phase === 'ready' ? r.note.replace(/\. Open the PR when you're ready$/, '') : 'approved by the person over the approver'))
    return 'Approved: Claude opens the PR.'
  }
  if (r.phase === 'needs-human') return `Nothing to approve: ${r.note} /factory retry runs that step again; /factory stop ends the run.`
  return `Nothing waits for approval: the run is ${r.note}.`
}

// Retry: the step that stopped the run, again.
async function retryNow($: EngineInterface): Promise<string> {
  const r = await read($, run)
  if (!r || r.phase !== 'needs-human' || !r.blocked) return 'Nothing to retry.'
  if (r.blocked.on === 'escalate') return 'The approver escalated: /factory approve opens the PR anyway, /factory stop ends the run.'
  const b = r.blocked
  void serial(async () => {
    if (b.on === 'spec') return respec($)
    if (b.on === 'builder') return startBuild($, openFindings(r.reviews.filter(x => x.round === r.round)), r.checks.filter(c => !c.ok), '', b.why ?? '')
    if (b.on === 'checks' || b.on === 'setup') {
      await patch($, cur => ({ ...cur, checkRound: 0 }))
      return runChecks($)
    }
    if (b.role === 'spec') return respec($)
    if (b.role === 'builder') return startBuild($, openFindings(r.reviews.filter(x => x.round === r.round)), r.checks.filter(c => !c.ok))
    if (b.role === 'approver') return startApprover($)
    const now = await patch($, cur => ({
      ...moveTo(cur, 'review', `reviewing, round ${cur.round}`),
      reviews: cur.reviews.map(x => (x.round === cur.round && x.state === 'fail' ? { ...x, state: 'run', agentId: null, findings: [] } : x)),
    }))
    if (now) await spawnReviewers($, now)
  })
  return `Retrying: ${b.on === 'start' ? `starting the ${describe(b.role, r)}` : b.on === 'setup' ? 'the setup and the checks' : b.on === 'checks' ? 'the checks' : `the ${b.on === 'spec' ? 'spec-writer' : 'builder'}`}.`
}

// The person sends the change back to the builder with their own words: once the run waits for
// them (the PR ready, an escalation, a step that stopped after the build).
async function reworkNow($: EngineInterface, said: string): Promise<string> {
  const r = await read($, run)
  if (!r || !isLive(r.phase)) return 'No factory run to rework.'
  if (!said) return 'Say what to change: /factory rework <what to change>'
  if (r.phase !== 'ready' && r.phase !== 'needs-human') return `Not now: the run is ${r.note}. /factory rework sends it back once it waits for you.`
  if (r.steps.builder.state === 'wait') return 'Nothing is built yet: /factory retry runs the step that stopped.'
  void serial(() => startBuild($, [], [], said))
  return `Sent back to the builder: ${said}`
}

async function stopNow($: EngineInterface): Promise<string> {
  const r = await patch($, cur => (isLive(cur.phase) ? moveTo(cur, 'stopped', 'stopped by the person') : cur))
  if (r) await update($, stoppedAgents, ids => [...ids.filter(id => !r.agents[id]), ...Object.keys(r.agents)].slice(-MAX_STOPPED))
  return r ? `Stopped. The branch ${r.branch} and its worktree ${r.worktree} stay; remove them with git worktree remove when done.` : 'No factory run.'
}

// What the person can do when the run waits on them: open the approved PR, approve past an
// escalation, or retry the step that stopped the run.
function actions($: EngineInterface, r: Run): { key: string; label: string; press: () => unknown }[] {
  if (r.phase === 'ready') return [{ key: 'pr', label: 'Open PR', press: () => approveNow($) }]
  if (r.phase !== 'needs-human') return []
  if (r.blocked?.on === 'escalate') return [{ key: 'pr', label: 'Approve PR', press: () => approveNow($) }]
  return [{ key: 'retry', label: 'Retry', press: () => retryNow($) }]
}

async function tick($: EngineInterface) {
  const r = await read($, run)
  if (r && isLive(r.phase) && !waitsOnPerson(r.phase)) await update($, frame, f => f + 1)
}

export const register: Register = (on, options) => {
  maxRounds = Math.max(1, Math.min(3, Number(options.maxRounds ?? 2) || 2))
  checksOption = String(options.checks ?? '')
  setupOption = String(options.setup ?? '')
  autoPr = String(options.autoPr ?? 'off') === 'on'
  takeOver = String(options.takeOver ?? 'on') !== 'off'
  modelsOption = String(options.models ?? 'auto') === 'fixed' ? 'fixed' : 'auto'
  skillsOption = parseSkills(String(options.skills ?? ''))

  on('session.start', async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    await $.command.register({ name: 'factory', description: 'Run a feature through the software factory: spec, plan, build, checks, reviews, approval', argumentHint: '<feature> | approve | retry | rework <note> | stop' })
    for (const role of Object.keys(ROLES) as Role[]) {
      const spec = ROLES[role]
      await $.agent
        .register({ name: spec.name, description: `The factory's ${spec.label}: started by /factory runs only.`, prompt: ROLE_PROMPTS[role], model: spec.model, ...(spec.tools ? { tools: skillsOf(role).length ? [...spec.tools, 'Skill'] : spec.tools } : {}) })
        .catch(() => {})
    }
    // Last, and allowed to fail: the rest of the start must not depend on it.
    await $.tool
      .register({
      name: 'start',
      description: "Start a factory run: its spec-writer writes a spec, you approve its plan, its builder builds it on a branch of its own, the checks and reviewers check it, and an approver decides on the PR. Call it when the person asks for the factory (\"run it in the factory\", /factory), with the feature in their words plus where its details are; then don't do the work yourself.",
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'What to build, in a sentence or a short paragraph, naming the file, issue or to-do item it comes from' },
          followupId: { type: 'string', description: 'Optional: the id of the to-do item this is, from the followups start message' },
        },
        required: ['feature'],
      },
      isDeferred: false,
    })
      .catch(() => {})
    timers.push($.clock.every(FRAME_MS, () => tick($)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))

  // The roles are the factory's: the model doesn't dispatch them itself.
  on('agent.offer', async ($, e, next) => (e.agent.startsWith('factory:') ? { isOffered: false } : next(e)))

  // The goal prompt goal-run sends, and the Start prompt of one to-do item from followups, start a
  // run instead of the main Claude doing the work; the prompt that goes on tells it so.
  on('prompt.submit', async ($, e, next) => {
    if (!takeOver) return next(e)
    const args = takeOverArgs(e.text)
    if (!args) return next(e)
    const cur = await read($, run)
    if (cur && isLive(cur.phase)) return next(e)
    void start($, args).then(msg => $.ui.toast(msg)).catch(() => {})
    return next({ ...e, text: takeOverNote(parseFactoryArgs(args).feature) })
  }).catch(($, e, next) => next(e))

  // A stopped run's agents can't be aborted, so their every tool call is refused: they stop editing
  // and spending. Only the run's own agents; the main loop and other agents go on.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const r = await read($, run)
      if ((r?.agents[e.agentId] && !isLive(r.phase)) || (await read($, stoppedAgents)).includes(e.agentId)) return { deny: STOPPED_DENY }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Claude starts a run itself when the person asks for the factory in words, or after /factory.
  on('tool.call', { tool: START_TOOL }, async ($, e) => {
    if ((e as { agentId?: string }).agentId !== undefined) return { deny: 'Only the main conversation starts a factory run.' }
    const input = e as unknown as { feature?: unknown; followupId?: unknown }
    const feature = String(input.feature ?? '').trim()
    if (!feature) return { deny: 'Name the feature: what to build, and where its details are (a file, an issue, the to-do item).' }
    const id = String(input.followupId ?? '').trim()
    const said = await start($, factoryArgs(feature, id || undefined))
    return { result: /^Factory run started/.test(said) ? `${said}\n${STARTED_NOTE}` : said }
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'approve' || arg === FACTORY_PLAN_APPROVED_ARG) return { text: await approveNow($) }
    if (arg === 'retry') return { text: await retryNow($) }
    if (arg === 'stop') return { text: await stopNow($) }
    if (arg === 'rework' || arg.startsWith('rework ')) return { text: await reworkNow($, arg.slice(6).trim()) }
    if (!arg) {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      const r = await read($, run)
      if (r && isLive(r.phase)) return { text: `${titleOf(r.feature, 120)}: ${r.note}.` }
      // Nothing running: Claude names the work from the conversation and starts it with the tool.
      // From a timer: a prompt submitted while the command's own hook still runs is refused.
      $.clock.after(1, () => void $.prompt.submit({ text: FROM_CONVERSATION }).catch(() => $.ui.toast('/factory <feature> starts a run')))
      return { text: 'Asked Claude to start a run from what this conversation is working on.' }
    }
    return { text: await start($, arg) }
  })

  // Each agent's answer moves the run on, in the queue (see serial).
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      const why = whyEnded(e)
      void serial(() => onAgentDone($, id, e.answer, why, e.reason === 'error'))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (e.agentId !== undefined && u && (await read($, run))?.agents[e.agentId]) await addTokens($, e.agentId, u.input_tokens + u.output_tokens + u.cache_creation_input_tokens)
    return r
  }).catch(async function* ($, e, next) { return yield* next(e) })

  // goal-run's plan dialog answers for the spec's tasks: approved, changes for the spec-writer, or
  // kept (the person's own goal stays; the factory asks). Read from the tool call and from
  // PostToolUse, whichever reaches the factory (the mods' order).
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const r = await next(e)
    const outcome = parsePlanOutcome(String(r.result ?? ''))
    if (outcome) void serial(() => onPlan($, outcome))
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    if (e.tool_name === PLAN_TOOL) {
      const outcome = parsePlanOutcome(toolText(e.tool_response))
      if (outcome) void serial(() => onPlan($, outcome))
    }
    return r
  }).catch(($, e, next) => next(e))

  // ---------- the band ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (e.props.hasSurvey || !r || !isLive(r.phase)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} paddingX={1} alignItems="center">
          <Text bold color={waitsOnPerson(r.phase) ? '#d97706' : ACCENT} wrap="truncate-end">{`🏭 ${titleOf(r.feature)}`}</Text>
          <Text dimColor wrap="truncate-end">{`· ${r.note} · ${tok(tokensOf(r))} tokens`}</Text>
          {r.phase === 'plan' && r.gate === 'factory' ? <Button key="f-approve-plan" label="Approve plan" variant="primary" onPress={() => approveNow($)} /> : null}
          {actions($, r).map(a => <Button key={`f-${a.key}`} label={a.label} variant="primary" onPress={a.press} />)}
          <Button key="f-open" label="Open" onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })} />
          <Button key="f-stop" label="Stop" onPress={() => stopNow($)} />
        </Box>
        {below}
      </Box>
    )
  })

  // ---------- the pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e as typeof e & { surface: 'desktop' }).Svg
    const r = await read($, run)
    if (!r) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color={ACCENT}>🏭 Factory</Text>
          <Text dimColor>No run yet. /factory &lt;feature&gt; writes a spec, has you approve its plan, builds it on a branch, runs the checks and the reviews, and asks the approver. You open the PR.</Text>
        </Box>
      )
    }
    const f = await read($, frame)
    const findings = r.reviews.filter(x => x.round === r.round && x.findings.length)
    const failed = r.checks.filter(c => !c.ok)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={ACCENT} wrap="truncate-end">{`🏭 ${titleOf(r.feature)}`}</Text>
          {titleOf(r.feature) !== r.feature.trim() ? <Text dimColor wrap="wrap">{r.feature.trim()}</Text> : null}
          <Text dimColor wrap="truncate-end">{`${r.note} · ${tok(tokensOf(r))} tokens · spec ${r.specFile}`}</Text>
          {r.stat || r.summary ? <Text wrap="wrap">{`Changed: ${[r.stat, r.summary].filter(Boolean).join(' · ')}`}</Text> : null}
          {r.recorded ? <Text dimColor wrap="truncate-end">{`What each step said: ${r.record}/`}</Text> : null}
        </Box>
        {Svg ? (
          <Svg source={diagramSvg(r, f, await read($, theme))} alt={pipelineLines(r).join('; ')} width={DIAGRAM.width} height={DIAGRAM.height} />
        ) : (
          <Box flexDirection="column">{pipelineLines(r).map((l, i) => <Text key={`p-${i}`}>{l}</Text>)}</Box>
        )}
        {findings.length ? (
          <Box flexDirection="column">
            <Text bold>{`Round ${r.round} findings`}</Text>
            {findings.flatMap(x => x.findings.map((g, i) => (
              <Text key={`f-${x.role}-${i}`} wrap="truncate-end">{`${x.role} · [${g.severity}] ${g.where} ${g.text}`}</Text>
            )))}
          </Box>
        ) : null}
        {r.skipped?.length ? (
          <Text dimColor wrap="truncate-end">{`Left out of the commits: ${r.skipped.join(', ')}`}</Text>
        ) : null}
        {failed.length ? (
          <Box flexDirection="column">
            <Text bold color="#dc2626">Failing checks</Text>
            {failed.map((c, i) => <Text key={`c-${i}`} dimColor wrap="truncate-end">{`$ ${c.cmd}: ${c.tail.split('\n').slice(-1)[0] ?? ''}`}</Text>)}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1}>
          {r.phase === 'plan' ? <Button key="p-approve-plan" label="Approve plan" variant="primary" onPress={() => approveNow($)} /> : null}
          {actions($, r).map(a => <Button key={`p-${a.key}`} label={a.label} variant="primary" onPress={a.press} />)}
          {isLive(r.phase) ? <Button key="p-stop" label="Stop" onPress={() => stopNow($)} /> : null}
        </Box>
      </Box>
    )
  })
}
