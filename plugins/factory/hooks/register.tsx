import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Finding, Reviewer, Role, Run } from '../types'
import { buildRound, DIAGRAM, diagramSvg, pipelineLines } from './art'
import type { Theme } from './art'
import {
  approvePrompt,
  buildPrompt,
  detectChecks,
  isLive,
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
  specPrompt,
  splitChecks,
  tailOf,
  tok,
  tokensOf,
} from './flow'
import { FACTORY_PLAN_APPROVED_ARG, parsePlanOutcome, toolText } from './texts'

const run = atom({ plugin: 'factory', key: 'run' } as const, null as Run | null)
const frame = atom({ plugin: 'factory', key: 'frame' } as const, 0)
const theme = atom({ plugin: 'factory', key: 'theme' } as const, 'dark' as Theme)

const PANE = 'factory'
const PANE_TITLE = 'Factory'
const PLAN_TOOL = 'mcp__goal-run__plan'
const MAX_CHECK_ROUNDS = 2
const CHECK_TIMEOUT_MS = 600_000
const FRAME_MS = 700
const ACCENT = '#2563eb'

// Set from the options when the module registers.
let maxRounds = 2
let checksOption = ''
// Whether goal-run is there to put the spec's tasks in a plan and ask the person; else the factory asks.
let hasGoalRun = false
// Transitions run one at a time: two reviewers finishing together must not both start the approver.
let queue: Promise<void> = Promise.resolve()
const timers: { cancel: () => void }[] = []

function serial(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job, job).catch(() => {})
  return queue
}

async function patch($: EngineInterface, fn: (r: Run) => Run): Promise<Run | null> {
  return update($, run, cur => (cur ? fn(cur) : cur))
}

async function git($: EngineInterface, args: string[], cwd?: string) {
  return $.process.run(['git', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
}

const describe = (role: Role, r: Run) =>
  role === 'builder' ? `builder, round ${buildRound(r)}` : role === 'spec' ? 'spec-writer' : role === 'approver' ? 'approver' : `${ROLES[role].label} review`

// Starts one role's agent in the run's worktree. A role type the engine refused to register falls
// back to a general-purpose agent carrying the role's instructions in its prompt.
async function spawnRole($: EngineInterface, role: Role, prompt: string): Promise<boolean> {
  const r = await read($, run)
  if (!r) return false
  const spec = ROLES[role]
  const base = { prompt, description: `factory · ${describe(role, r)}`, model: spec.model, cwd: r.worktree }
  let res = await $.agent.spawn({ ...base, subagentType: `factory:${spec.name}` }).catch(err => ({ deny: String(err) }) as { deny: string })
  if ('deny' in res && res.deny) {
    res = await $.agent.spawn({ ...base, subagentType: 'general-purpose', prompt: `${ROLE_PROMPTS[role]}\n\n${prompt}` }).catch(err => ({ deny: String(err) }) as { deny: string })
  }
  if ('deny' in res && res.deny) {
    await patch($, cur => ({ ...cur, phase: 'needs-human', note: `Could not start the ${describe(role, cur)}: ${res.deny}` }))
    return false
  }
  // Without an id in the answer, the agent is found in the session's list by its description.
  const id = (res as { agentId?: string }).agentId ?? (await $.agent.list().catch(() => [])).filter(a => a.description === base.description && !r.agents[a.id]).at(-1)?.id
  if (!id) {
    await patch($, cur => ({ ...cur, phase: 'needs-human', note: `Started the ${describe(role, cur)}, but can't follow it: no agent id.` }))
    return false
  }
  await patch($, cur => ({ ...cur, agents: { ...cur.agents, [id]: role } }))
  return true
}

async function start($: EngineInterface, feature: string): Promise<string> {
  const cur = await read($, run)
  if (cur && isLive(cur.phase)) return `A factory run is already going: ${cur.feature}. /factory stop ends it.`
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return 'The factory needs a git repository: it builds on a branch, in a worktree of its own.'
  const root = top.stdout.trim()
  const head = await git($, ['rev-parse', 'HEAD'], root)
  if (head.exitCode !== 0) return 'The repository has no commit yet to build from.'
  let r = newRun(feature, await $.clock.now(), head.stdout.trim(), root)
  // A branch name already taken gets a number.
  for (let k = 2; k <= 6; k++) {
    const added = await git($, ['worktree', 'add', '-b', r.branch, r.worktree, r.base], root)
    if (added.exitCode === 0) break
    if (k === 6) return `Could not create a worktree for the run: ${tailOf(added.stderr, 3)}`
    r = { ...r, slug: `${r.slug}-${k}`, branch: `factory/${r.slug}-${k}`, worktree: r.worktree.replace(/[^\\/]+$/, `${r.slug}-${k}`), specFile: `docs/specs/${r.slug}-${k}.md` }
  }
  await keepOutOfGit($, root)
  await readTheme($)
  await update($, run, () => r)
  void $.ui.open({ id: PANE, title: PANE_TITLE })
  hasGoalRun = (await $.command.list().catch(() => [])).some(c => c.name === 'session-goal')
  await spawnRole($, 'spec', specPrompt(r))
  return `Factory run started: ${r.feature}. Branch ${r.branch}; the spec-writer is writing ${r.specFile}.`
}

// The worktrees live in .factory/ of the repository: listed in .git/info/exclude, never committed.
// The diagram's palette follows the theme set in /config; dark when it can't be read.
async function readTheme($: EngineInterface) {
  const row = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')
  const value = String((row as { value?: unknown } | undefined)?.value ?? '')
  await update($, theme, () => (/light/i.test(value) ? 'light' : 'dark'))
}

async function keepOutOfGit($: EngineInterface, root: string) {
  const path = `${root}/.git/info/exclude`
  const text = await $.fs.read(path).then(t => String(t), () => null)
  if (text === null || /^\.factory\/$/m.test(text)) return
  await $.fs.write(path, `${text.replace(/\n?$/, '\n')}.factory/\n`).catch(() => {})
}

async function onSpec($: EngineInterface, answer: string, ok: boolean) {
  const tasks = ok ? parseTasks(answer) : []
  if (!tasks.length) {
    await patch($, r => ({ ...r, phase: 'needs-human', steps: { ...r.steps, spec: { ...r.steps.spec, state: 'fail' } }, note: ok ? 'The spec-writer gave no TASKS list.' : 'The spec-writer stopped before finishing.' }))
    return
  }
  const r = await patch($, cur => ({ ...cur, tasks, phase: 'plan', steps: { ...cur.steps, spec: { ...cur.steps.spec, state: 'pass' } }, note: 'waiting for you to approve the plan' }))
  if (r && hasGoalRun) void $.prompt.submit({ text: planPrompt(r) }).catch(() => {})
}

async function onPlan($: EngineInterface, outcome: { approved: true } | { changes: string }) {
  const r = await read($, run)
  if (!r || r.phase !== 'plan') return
  if ('approved' in outcome) return startBuild($, [], [])
  await patch($, cur => ({ ...cur, phase: 'spec', steps: { ...cur.steps, spec: { ...cur.steps.spec, state: 'run' } }, note: 'revising the spec' }))
  await spawnRole($, 'spec', specPrompt(r, outcome.changes || 'The person asked for changes to the plan.'))
}

async function startBuild($: EngineInterface, findings: Finding[], failed: Check[]) {
  const r = await patch($, cur => ({ ...cur, phase: 'build', steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'run' } }, note: failed.length ? 'fixing the checks' : findings.length ? `fixing ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'building' }))
  if (r) await spawnRole($, 'builder', buildPrompt(r, findings, failed))
}

async function checkCommands($: EngineInterface, worktree: string): Promise<string[][]> {
  if (checksOption.trim()) return splitChecks(checksOption)
  const files = (await $.fs.list(worktree).catch(() => [])).map(f => f.name)
  const pkg = files.includes('package.json') ? await $.fs.read(`${worktree}/package.json`).then(t => String(t), () => null) : null
  return detectChecks(files, pkg)
}

async function runChecks($: EngineInterface) {
  const r = await patch($, cur => ({ ...cur, phase: 'checks', steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'pass' }, checks: { ...cur.steps.checks, state: 'run' } }, checkRound: cur.checkRound + 1, note: 'running the checks' }))
  if (!r) return
  const cmds = await checkCommands($, r.worktree)
  const results: Check[] = []
  for (const argv of cmds) {
    const out = await $.process.run(argv, { cwd: r.worktree, timeoutMs: CHECK_TIMEOUT_MS }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    results.push({ cmd: argv.join(' '), ok: out.exitCode === 0, tail: out.exitCode === 0 ? '' : tailOf(`${out.stdout}\n${out.stderr}`) })
  }
  const failed = results.filter(c => !c.ok)
  const after = await patch($, cur => ({ ...cur, checks: results, steps: { ...cur.steps, checks: { ...cur.steps.checks, state: !cmds.length ? 'skip' : failed.length ? 'fail' : 'pass' } } }))
  if (!after || after.phase !== 'checks') return
  if (!failed.length) return startReviews($)
  if (after.checkRound < MAX_CHECK_ROUNDS) return startBuild($, [], failed)
  await patch($, cur => ({ ...cur, phase: 'needs-human', note: `The checks still fail after ${cur.checkRound} builder passes: ${failed.map(c => c.cmd).join(', ')}.` }))
}

async function startReviews($: EngineInterface) {
  // Round one asks every reviewer; a later round only those who asked for changes.
  const r = await patch($, cur => {
    const round = cur.round + 1
    const again = cur.round === 0 ? cur.reviews.map(x => x.role) : cur.reviews.filter(x => x.state === 'changes').map(x => x.role)
    return {
      ...cur,
      round,
      checkRound: 0,
      phase: 'review',
      note: `reviewing, round ${round}`,
      reviews: cur.reviews.map(x => (again.includes(x.role) ? { ...x, state: 'run', findings: [], round } : x)),
    }
  })
  if (!r) return
  const stat = await git($, ['diff', '--stat', r.base], r.worktree)
  for (const x of r.reviews.filter(v => v.round === r.round)) await spawnRole($, x.role, reviewPrompt(r, x.role, stat.exitCode === 0 ? stat.stdout.trim() : ''))
}

async function onReview($: EngineInterface, role: Reviewer, answer: string, ok: boolean) {
  const verdict = ok ? parseVerdict(answer) : { state: 'changes' as const, findings: [{ severity: 'major' as const, where: '-', text: 'The reviewer stopped before finishing.' }] }
  const r = await patch($, cur => ({ ...cur, reviews: cur.reviews.map(x => (x.role === role ? { ...x, state: verdict.state, findings: verdict.findings } : x)) }))
  if (!r || r.phase !== 'review') return
  const mine = r.reviews.filter(x => x.round === r.round)
  if (mine.some(x => x.state === 'run')) return
  const changes = mine.filter(x => x.state === 'changes')
  if (changes.length && r.round < maxRounds) return startBuild($, openFindings(changes), [])
  await patch($, cur => ({ ...cur, phase: 'approve', steps: { ...cur.steps, approver: { ...cur.steps.approver, state: 'run' } }, note: 'the approver is deciding' }))
  const now = await read($, run)
  if (now) await spawnRole($, 'approver', approvePrompt(now))
}

async function onApprover($: EngineInterface, answer: string, ok: boolean) {
  const { decision, reason } = ok ? parseDecision(answer) : { decision: 'ESCALATE' as const, reason: 'The approver stopped before deciding.' }
  if (decision === 'APPROVE') return finish($, reason)
  await patch($, r => ({ ...r, phase: 'needs-human', steps: { ...r.steps, approver: { ...r.steps.approver, state: 'changes' } }, note: reason }))
  $.ui.toast('The factory needs you: /factory approve or /factory stop')
}

// Approved, by the approver or by the person: the main Claude opens the PR.
async function finish($: EngineInterface, reason: string) {
  const r = await patch($, cur => ({ ...cur, phase: 'done', steps: { ...cur.steps, approver: { ...cur.steps.approver, state: 'pass' } }, note: reason || 'approved' }))
  if (!r) return
  void $.prompt.submit({ text: prPrompt(r, reason) }).catch(() => {
    $.ui.toast(`Approved. Open a PR from ${r.branch} yourself; the prompt could not be sent.`)
  })
}

async function onAgentDone($: EngineInterface, agentId: string, answer: string, ok: boolean) {
  const r = await read($, run)
  const role = r?.agents[agentId]
  if (!r || !role || !isLive(r.phase)) return
  if (role === 'spec') return onSpec($, answer, ok)
  if (role === 'builder') {
    if (!ok) return void (await patch($, cur => ({ ...cur, phase: 'needs-human', steps: { ...cur.steps, builder: { ...cur.steps.builder, state: 'fail' } }, note: 'The builder stopped before finishing.' })))
    return runChecks($)
  }
  if (role === 'approver') return onApprover($, answer, ok)
  return onReview($, role, answer, ok)
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

async function approveNow($: EngineInterface): Promise<string> {
  const r = await read($, run)
  if (!r) return 'No factory run.'
  // Queued, not awaited: a prompt submitted while the command's hook still runs is refused.
  if (r.phase === 'plan') {
    void serial(() => onPlan($, { approved: true }))
    return 'Plan approved: the builder starts.'
  }
  if (r.phase === 'needs-human') {
    void serial(() => finish($, 'approved by the person'))
    return 'Approved: Claude opens the PR.'
  }
  return `Nothing waits for approval: the run is ${r.note}.`
}

async function stopNow($: EngineInterface): Promise<string> {
  const r = await patch($, cur => ({ ...cur, phase: 'stopped', note: 'stopped by the person' }))
  return r ? `Stopped. The branch ${r.branch} and its worktree ${r.worktree} stay; remove them with git worktree remove when done.` : 'No factory run.'
}

async function tick($: EngineInterface) {
  const r = await read($, run)
  if (r && isLive(r.phase) && r.phase !== 'needs-human') await update($, frame, f => f + 1)
}

export const register: Register = (on, options) => {
  maxRounds = Math.max(1, Math.min(3, Number(options.maxRounds ?? 2) || 2))
  checksOption = String(options.checks ?? '')

  on('session.start', async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    await $.command.register({ name: 'factory', description: 'Run a feature through the software factory: spec, plan, build, checks, reviews, approval', argumentHint: '<feature> | approve | stop' })
    for (const role of Object.keys(ROLES) as Role[]) {
      const spec = ROLES[role]
      await $.agent
        .register({ name: spec.name, description: `The factory's ${spec.label}: started by /factory runs only.`, prompt: ROLE_PROMPTS[role], model: spec.model, ...(spec.tools ? { tools: spec.tools } : {}) })
        .catch(() => {})
    }
    timers.push($.clock.every(FRAME_MS, () => tick($)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))

  // The roles are the factory's: the model doesn't dispatch them itself.
  on('agent.offer', async ($, e, next) => (e.agent.startsWith('factory:') ? { isOffered: false } : next(e)))

  on('command.run', { command: 'factory' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'approve') return { text: await approveNow($) }
    if (arg === FACTORY_PLAN_APPROVED_ARG) return { text: await approveNow($) }
    if (arg === 'stop') return { text: await stopNow($) }
    if (!arg) {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      const r = await read($, run)
      return { text: r ? `${r.feature}: ${r.note}.` : 'No factory run. /factory <feature> starts one.' }
    }
    return { text: await start($, arg) }
  })

  // Each agent's answer moves the run on.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined && (await read($, run))?.agents[e.agentId]) {
      const id = e.agentId
      void serial(() => onAgentDone($, id, e.answer, e.reason === 'answer'))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (e.agentId !== undefined && u && (await read($, run))?.agents[e.agentId]) await addTokens($, e.agentId, u.input_tokens + u.output_tokens + u.cache_creation_input_tokens)
    return r
  }).catch(async function* ($, e, next) { return yield* next(e) })

  // goal-run's plan dialog answers for the spec's tasks: approved, or changes for the spec-writer.
  // Read from the tool call and from PostToolUse, whichever reaches the factory (the mods' order).
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
    const waitsOnMe = r.phase === 'plan' || r.phase === 'needs-human'
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} paddingX={1} alignItems="center">
          <Text bold color={waitsOnMe ? '#d97706' : ACCENT}>{`🏭 ${r.feature}`}</Text>
          <Text dimColor wrap="truncate-end">{`· ${r.note} · ${tok(tokensOf(r))} tokens`}</Text>
          {r.phase === 'plan' && !hasGoalRun ? <Button key="f-approve-plan" label="Approve plan" variant="primary" onPress={() => approveNow($)} /> : null}
          {r.phase === 'needs-human' ? <Button key="f-approve" label="Approve" variant="primary" onPress={() => approveNow($)} /> : null}
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
          <Text dimColor>No run yet. /factory &lt;feature&gt; writes a spec, has you approve its plan, builds it on a branch, runs the checks and the reviews, and asks the approver.</Text>
        </Box>
      )
    }
    const f = await read($, frame)
    const findings = r.reviews.filter(x => x.round === r.round && x.findings.length)
    const failed = r.checks.filter(c => !c.ok)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={ACCENT}>{`🏭 ${r.feature}`}</Text>
          <Text dimColor wrap="truncate-end">{`${r.note} · ${tok(tokensOf(r))} tokens · spec ${r.specFile}`}</Text>
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
        {failed.length ? (
          <Box flexDirection="column">
            <Text bold color="#dc2626">Failing checks</Text>
            {failed.map((c, i) => <Text key={`c-${i}`} dimColor wrap="truncate-end">{`$ ${c.cmd}: ${c.tail.split('\n').slice(-1)[0] ?? ''}`}</Text>)}
          </Box>
        ) : null}
        <Box flexDirection="row" gap={1}>
          {r.phase === 'plan' ? <Button key="p-approve-plan" label="Approve plan" variant="primary" onPress={() => approveNow($)} /> : null}
          {r.phase === 'needs-human' ? <Button key="p-approve" label="Approve" variant="primary" onPress={() => approveNow($)} /> : null}
          {isLive(r.phase) ? <Button key="p-stop" label="Stop" onPress={() => stopNow($)} /> : null}
        </Box>
      </Box>
    )
  })
}
