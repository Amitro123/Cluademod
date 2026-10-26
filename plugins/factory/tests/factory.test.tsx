import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detectChecks, detectSetup, parseDecision, parseTasks, parseVerdict, splitChecks } from '../hooks/flow'
import { factoryArgs, PLAN_APPROVED_FOR_FACTORY, PLAN_KEPT_FOR_FACTORY, planChangesForFactory } from '../hooks/texts'

const PLAN = 'mcp__goal-run__plan'

const BAND = {
  plugin: 'factory',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

const PANE = {
  plugin: 'factory',
  component: 'Pane',
  requestId: 'factory',
  props: { title: 'Factory', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const SPEC_ANSWER = 'Wrote docs/specs/rate-limiter.md.\nTASKS:\n1. [high] Token bucket core\n2. [high] Middleware with Retry-After (needs 1)\n3. [medium] Tests for bursts (needs 1, 2)'
const PASS = 'Looked at the diff.\nVERDICT: PASS\nFINDINGS:\n- [minor] src/limit.ts:4 a name could be clearer'
const CHANGES = 'VERDICT: CHANGES\nFINDINGS:\n- [major] src/mw.ts:12 Retry-After is in ms, not seconds'

type Spawned = { id: string; subagentType: string; prompt: string; description: string; cwd?: string }

// The engine beneath: git and the checks, the agents the factory starts, its prompts, the commands there are.
// `fails`: how many non-git commands fail first (setup and checks alike). `worktree`: the stderr of
// each failing `git worktree add`, in turn. `dirty`: the builder left uncommitted work.
function engine(on: On, { hold = '', goalRun = true, fails = 0, files = ['package.json', 'node_modules'], pkg = '{"scripts":{"test":"vitest"}}', denyType = false, worktree = [] as string[], dirty = false, commitFails = false } = {}) {
  const spawned: Spawned[] = []
  const ran: string[] = []
  const sent: string[] = []
  const toasts: string[] = []
  const written: Record<string, string> = {}
  // `hold`: that command waits until the test releases it, so the test can act meanwhile.
  let release = () => {}
  const held = new Promise<void>(r => (release = r))
  let failing = fails
  const worktreeErrs = [...worktree]
  mock.clock(on, { now: Date.UTC(2026, 9, 25, 9) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('agent.register', (_, e) => ({ value: { agent: `factory:${e.name}` } }) as never)
  on('command.list', () => ({ value: goalRun ? [{ name: 'session-goal', description: 'g', source: 'plugin' }] : [] }) as never)
  // The mod's own spawn arrives in the Agent tool's words (subagent_type).
  on('agent.spawn', (_, e) => {
    const a = e as unknown as { subagentType?: string; subagent_type?: string; prompt: string; description: string; cwd?: string }
    const type = a.subagentType ?? a.subagent_type ?? ''
    if (denyType && type.startsWith('factory:')) return { deny: 'unknown agent type' } as never
    const id = `a${spawned.length + 1}`
    spawned.push({ id, subagentType: type, prompt: a.prompt, description: a.description, cwd: a.cwd })
    return { model: 'm', agentId: id } as never
  })
  // The kit answers a mod's own spawn itself, without an agentId: the mod finds its agent in the list.
  on('agent.list', () => ({ value: spawned.map(s => ({ id: s.id, description: s.description, type: s.subagentType, status: 'running' })) }) as never)
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
  on('process.run', async (_, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    if (cmd === hold) await held
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd === 'git rev-parse HEAD') return ok('abc123\n')
    if (cmd.startsWith('git worktree add')) {
      const err = worktreeErrs.shift()
      return err ? ({ value: { exitCode: 128, stdout: '', stderr: err } } as never) : ok()
    }
    if (cmd.startsWith('git diff --stat')) return ok(' src/mw.ts | 40 +++\n 1 file changed')
    if (cmd === 'git status --porcelain') return ok(dirty ? ' M src/mw.ts\n?? src/limit/new.ts\n?? node_modules/\n?? .env\n?? certs/server.key\n' : '')
    if (cmd === 'git diff --cached --quiet') return { value: { exitCode: dirty ? 1 : 0, stdout: '', stderr: '' } } as never
    if (cmd === 'git rev-parse --git-path info/exclude') return ok('.git/info/exclude\n')
    if (cmd.startsWith('git commit') && commitFails) return { value: { exitCode: 1, stdout: '', stderr: 'Please tell me who you are.' } } as never
    if (cmd.startsWith('git ')) return ok()
    if (failing > 0) {
      failing--
      return { value: { exitCode: 1, stdout: 'FAIL src/mw.test.ts\n  expected 429', stderr: '' } } as never
    }
    return ok('ok')
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('package.json')) return { value: pkg } as never
    if (e.path in written) return { value: written[e.path] } as never
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined } as never
  })
  on('fs.list', () => ({ value: files.map(name => ({ name, kind: 'file' })) }) as never)
  on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined } as never
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('classic.PostToolUse', () => ({}) as never)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'm', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  // goal-run's plan tool, as it answers for a factory plan the person approved.
  on('tool.call', { tool: PLAN }, () => ({ result: PLAN_APPROVED_FOR_FACTORY }) as never)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { spawned, ran, sent, toasts, written, release }
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')

// An agent of the run answers: its turn completes, and the factory moves on.
async function answer($: Engine, id: string, text: string, reason: 'answer' | 'error' = 'answer') {
  await $.turn.complete({ answer: text, durationMs: 1000, isAborted: false, turnId: `t-${id}`, agentId: id, reason } as never)
  await settled()
}

async function step($: Engine, agentId: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId } as never)
  for await (const _ of s) { /* drain */ }
  await s.result
}

async function startRun($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  const r = await $.command.run({ command: 'factory', args: 'Rate limiter' } as never)
  await settled()
  return String(r.text)
}

async function command($: Engine, args: string) {
  const r = await $.command.run({ command: 'factory', args } as never)
  await settled()
  return String(r.text)
}

// From the start to the reviews: spec a1, builder a2, reviewers a3 (security) and a4 (code).
async function toReviews($: Engine) {
  await startRun($)
  await answer($, 'a1', SPEC_ANSWER)
  await command($, 'approve')
  await answer($, 'a2', 'built')
}

// The transitions run after the event that caused them returns (in the plugin's own copy of the module).
async function settled() {
  for (let i = 0; i < 40; i++) await new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, 0))
}

const last = (w: { spawned: Spawned[] }) => w.spawned.at(-1)!

async function bandText($: Engine) {
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  const t = await texts(band)
  await band.unmount()
  return t
}

describe('a run from the feature to the PR', () => {
  test('spec, the plan in goal-run, build, checks, both reviews, the approver, then your Open PR', async ($, on) => {
    const w = engine(on)
    const started = await startRun($)
    expect(started).toMatch(/Factory run started: Rate limiter\. Branch factory\/rate-limiter, worktree \/repo\/\.factory\/rate-limiter/)
    // The worktree is next to the repository, not in it: nothing in the main checkout scans it.
    expect(w.ran).toContain('git worktree add -b factory/rate-limiter /repo/.factory/rate-limiter abc123')
    expect(last(w)).toMatchObject({ subagentType: 'factory:spec-writer', description: 'factory · spec-writer', cwd: '/repo/.factory/rate-limiter' })
    expect(last(w).prompt).toContain('Rate limiter')

    // The spec's tasks go to goal-run's plan, through the main Claude.
    await step($, 'a1')
    await answer($, 'a1', SPEC_ANSWER)
    expect(w.sent.at(-1)).toContain(PLAN)
    expect(w.sent.at(-1)).toMatch(/source "factory"/)
    expect(w.sent.at(-1)).toContain('Middleware with Retry-After')
    expect(w.spawned).toHaveLength(1)

    // The person approves in goal-run's dialog: the builder starts.
    await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks: [{ title: 'Token bucket core', priority: 'high' }] } as never)
    await settled()
    expect(last(w)).toMatchObject({ id: 'a2', subagentType: 'factory:builder', description: 'factory · builder, round 1' })

    // Green checks, then the two reviewers at once, on what will be pushed.
    await answer($, 'a2', 'Done, committed.')
    expect(w.ran).toContain('npm test')
    expect(w.ran).toContain('git diff --stat abc123 HEAD')
    expect(w.spawned.slice(2).map(s => s.subagentType)).toEqual(['factory:security-reviewer', 'factory:code-reviewer'])
    expect(w.spawned[2]!.prompt).toContain('src/mw.ts | 40')
    expect(w.spawned[2]!.prompt).toContain('git diff abc123..HEAD')

    await answer($, 'a3', PASS)
    expect(w.spawned).toHaveLength(4)
    await answer($, 'a4', PASS)
    expect(last(w)).toMatchObject({ id: 'a5', subagentType: 'factory:approver' })

    // The approver is an agent: its APPROVE readies the PR, and the person opens it.
    await answer($, 'a5', 'DECISION: APPROVE\nREASON: spec met, tests green')
    const sentBefore = w.sent.length
    expect(w.toasts.at(-1)).toMatch(/Open PR/)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/approved: spec met, tests green/)
    await band.press({ key: 'f-pr' })
    await settled()
    await band.unmount()
    expect(w.sent.length).toBe(sentBefore + 1)
    expect(w.sent.at(-1)).toMatch(/Push branch factory\/rate-limiter/)
    expect(w.sent.at(-1)).toMatch(/spec met, tests green/)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(pane)
    expect(text).toMatch(/✓ spec-writer \(opus\) · 3 tasks/)
    expect(text).toMatch(/✓ approver/)
    expect(text).toMatch(/✓ open PR/)
    expect(text).toMatch(/2k tokens/)
    await pane.unmount()
  })

  test('changes send the builder back with the findings, and every reviewer looks again', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await command($, 'plan-approved')
    await answer($, 'a2', 'built')
    await answer($, 'a3', PASS)
    await answer($, 'a4', CHANGES)
    expect(last(w)).toMatchObject({ id: 'a5', subagentType: 'factory:builder', description: 'factory · builder, round 2' })
    expect(last(w).prompt).toContain('Retry-After is in ms, not seconds')

    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
    expect(await texts(pane)).toMatch(/fixing 1 finding/)
    const svg = (await pane.findAll({ type: 'Svg' } as never))[0] as unknown as { props: { source: string } }
    expect(svg.props.source).toContain('builder · round 2')
    // The light theme set in /config: the light palette's background.
    expect(svg.props.source).toContain('#fbfaf7')
    await pane.unmount()

    // The fix is new code for security too.
    await answer($, 'a5', 'fixed')
    expect(w.spawned.slice(5).map(s => s.subagentType)).toEqual(['factory:security-reviewer', 'factory:code-reviewer'])
    // A late answer from round 1's reviewer doesn't count for round 2.
    await answer($, 'a4', PASS)
    await answer($, 'a6', PASS)
    expect(w.spawned).toHaveLength(7)
    await answer($, 'a7', PASS)
    expect(last(w).subagentType).toBe('factory:approver')
  })

  test('at the round limit the approver decides on what it has', async ($, on) => {
    const w = engine(on)
    await toReviews($)
    await answer($, 'a3', PASS)
    await answer($, 'a4', CHANGES)
    await answer($, 'a5', 'fixed')
    await answer($, 'a6', PASS)
    await answer($, 'a7', CHANGES)
    expect(last(w).subagentType).toBe('factory:approver')
    expect(last(w).prompt).toContain('Retry-After')
  })

  test('work the builder left uncommitted is committed before the checks, without dependencies or credentials', async ($, on) => {
    const w = engine(on, { dirty: true })
    await toReviews($)
    const at = (c: string) => w.ran.indexOf(c)
    expect(at('git add -u')).toBeGreaterThan(-1)
    expect(w.ran).toContain('git add -- src/limit/new.ts')
    expect(w.ran.some(c => /add .*(node_modules|\.env|server\.key)/.test(c))).toBe(false)
    expect(w.ran).not.toContain('git add -A')
    expect(at('git commit -m factory: Rate limiter')).toBeGreaterThan(at('git add -- src/limit/new.ts'))
    expect(at('npm test')).toBeGreaterThan(at('git commit -m factory: Rate limiter'))
    expect(last(w).subagentType).toBe('factory:code-reviewer')
    // The person and the PR prompt hear what was left out.
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await texts(pane)).toMatch(/Left out of the commits: node_modules\/, \.env, certs\/server\.key/)
    await pane.unmount()
    await answer($, 'a3', PASS)
    await answer($, 'a4', PASS)
    await answer($, 'a5', 'DECISION: APPROVE\nREASON: ok')
    await command($, 'approve')
    expect(w.sent.at(-1)).toMatch(/left these new files out of its commits.*node_modules\//)
  })

  test('the worktree folder is kept out of git through the exclude file git names', async ($, on) => {
    const w = engine(on)
    await startRun($)
    expect(w.ran).toContain('git rev-parse --git-path info/exclude')
    expect(w.written['/repo/.git/info/exclude']).toBe('.factory/\n')
    await command($, 'stop')
    await command($, 'Second feature')
    expect(w.written['/repo/.git/info/exclude']).toBe('.factory/\n')
  })

  test("a commit that fails stops the run, for the person to look at", async ($, on) => {
    const w = engine(on, { dirty: true, commitFails: true })
    await toReviews($)
    expect(w.ran).not.toContain('npm test')
    expect(await bandText($)).toMatch(/could not be committed: Please tell me who you are/)
  })
})

describe('the worktree', () => {
  test('a taken name gets a number, counted from the feature', async ($, on) => {
    const w = engine(on, { worktree: ["fatal: a branch named 'factory/rate-limiter' already exists", "fatal: '/repo/.factory/rate-limiter-2' already exists"] })
    const started = await startRun($)
    expect(w.ran.filter(c => c.startsWith('git worktree add'))).toEqual([
      'git worktree add -b factory/rate-limiter /repo/.factory/rate-limiter abc123',
      'git worktree add -b factory/rate-limiter-2 /repo/.factory/rate-limiter-2 abc123',
      'git worktree add -b factory/rate-limiter-3 /repo/.factory/rate-limiter-3 abc123',
    ])
    expect(started).toMatch(/Branch factory\/rate-limiter-3/)
    expect(last(w).prompt).toContain('docs/specs/rate-limiter-3.md')
  })

  test('any other failure is reported at once', async ($, on) => {
    const w = engine(on, { worktree: ['fatal: not a valid object name: abc123'] })
    const started = await startRun($)
    expect(started).toMatch(/Could not create a worktree for the run: fatal: not a valid object name/)
    expect(w.ran.filter(c => c.startsWith('git worktree add'))).toHaveLength(1)
    expect(w.spawned).toHaveLength(0)
  })
})

describe('the checks come before any reviewer', () => {
  test('red checks go back to the builder, then to the person, who can retry them', async ($, on) => {
    const w = engine(on, { fails: 5 })
    await toReviews($)
    expect(last(w)).toMatchObject({ id: 'a3', subagentType: 'factory:builder' })
    expect(last(w).prompt).toContain('expected 429')
    await answer($, 'a3', 'fixed?')
    expect(w.spawned).toHaveLength(3)
    expect(w.spawned.some(s => s.subagentType.endsWith('reviewer'))).toBe(false)
    expect(await bandText($)).toMatch(/checks still fail after 2 builder passes: npm test/)

    // Not a PR: Approve isn't offered, and /factory approve says why.
    expect(await command($, 'approve')).toMatch(/^Nothing to approve: The checks still fail/)
    expect(w.sent.filter(t => /Push branch/.test(t))).toEqual([])
    const tests = w.ran.filter(c => c === 'npm test').length
    expect(await command($, 'retry')).toMatch(/Retrying: the checks/)
    expect(w.ran.filter(c => c === 'npm test').length).toBe(tests + 1)
  })

  test('no checks at all is a skip', async ($, on) => {
    const w = engine(on, { files: [] })
    await toReviews($)
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual([])
    expect(w.spawned.slice(2).map(s => s.subagentType)).toEqual(['factory:security-reviewer', 'factory:code-reviewer'])
  })

  test('the checks option wins over detection, and autoPr opens the PR on APPROVE', { options: { checks: 'make test; make lint', autoPr: 'on' } }, async ($, on) => {
    const w = engine(on)
    await toReviews($)
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual(['make test', 'make lint'])
    await answer($, 'a3', PASS)
    await answer($, 'a4', PASS)
    await answer($, 'a5', 'DECISION: APPROVE\nREASON: good')
    expect(w.sent.at(-1)).toMatch(/Push branch factory\/rate-limiter/)
  })
})

describe('a fresh worktree gets its dependencies', () => {
  test("the lockfile's install runs once, before the first checks", async ($, on) => {
    const w = engine(on, { files: ['package.json', 'package-lock.json'] })
    await toReviews($)
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual(['npm ci', 'npm test'])
  })

  test('the setup option wins over the lockfile', { options: { setup: 'pnpm install' } }, async ($, on) => {
    const w = engine(on, { files: ['package.json', 'package-lock.json'] })
    await toReviews($)
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual(['pnpm install', 'npm test'])
  })

  test("a failed setup is the person's, not the builder's", async ($, on) => {
    const w = engine(on, { files: ['package.json', 'yarn.lock'], fails: 1 })
    await toReviews($)
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual(['yarn install --frozen-lockfile'])
    expect(w.spawned).toHaveLength(2)
    expect(await bandText($)).toMatch(/The setup failed: yarn install --frozen-lockfile/)
    await command($, 'retry')
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual(['yarn install --frozen-lockfile', 'yarn install --frozen-lockfile', 'npm test'])
    expect(last(w).subagentType).toBe('factory:code-reviewer')
  })
})

describe('the plan', () => {
  test("without goal-run, the factory asks for the plan's approval itself", async ($, on) => {
    const w = engine(on, { goalRun: false })
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    expect(w.sent).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/waiting for you to approve the plan/)
    await band.press({ key: 'f-approve-plan' })
    await settled()
    expect(last(w).subagentType).toBe('factory:builder')
    await band.unmount()
  })

  test("a regular plan's answers don't move the factory's", async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.classic.PostToolUse({ tool_name: PLAN, tool_input: {}, tool_response: 'Approved. Session goal: Ship it. 0/2 tasks done (0%).' } as never)
    await $.classic.PostToolUse({ tool_name: PLAN, tool_input: {}, tool_response: 'The person wants changes to the plan. Ask what to change, then propose it again with this tool.' } as never)
    await settled()
    expect(w.spawned).toHaveLength(1)
    expect(await bandText($)).toMatch(/waiting for you to approve the plan/)
  })

  test('with a goal of your own in goal-run, the factory asks in its band', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.classic.PostToolUse({ tool_name: PLAN, tool_input: {}, tool_response: PLAN_KEPT_FOR_FACTORY } as never)
    await settled()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/goal-run keeps your own goal/)
    await band.press({ key: 'f-approve-plan' })
    await settled()
    await band.unmount()
    expect(last(w).subagentType).toBe('factory:builder')
  })

  test('changes to the plan go back to the spec-writer', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.classic.PostToolUse({ tool_name: PLAN, tool_input: {}, tool_response: planChangesForFactory('split the middleware task') } as never)
    await settled()
    expect(last(w)).toMatchObject({ id: 'a2', subagentType: 'factory:spec-writer' })
    expect(last(w).prompt).toContain('split the middleware task')
  })

  test("a role the engine wouldn't register runs as a general-purpose agent with the role's instructions", async ($, on) => {
    const w = engine(on, { denyType: true })
    await startRun($)
    expect(last(w).subagentType).toBe('general-purpose')
    expect(last(w).prompt).toMatch(/spec-writer/)
    expect(last(w).prompt).toContain('Rate limiter')
  })
})

describe('the person decides', () => {
  test("a spec with no tasks can't be approved into a PR; Retry asks the spec-writer again", async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', 'I wrote a spec.')
    expect(await bandText($)).toMatch(/The spec-writer gave no TASKS list/)
    expect(await command($, 'approve')).toMatch(/^Nothing to approve/)
    expect(w.sent).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    await band.press({ key: 'f-retry' })
    await settled()
    await band.unmount()
    expect(last(w)).toMatchObject({ id: 'a2', subagentType: 'factory:spec-writer' })
  })

  test('an ESCALATE waits for the person; Approve PR sends the PR prompt', async ($, on) => {
    const w = engine(on)
    await toReviews($)
    await answer($, 'a3', PASS)
    await answer($, 'a4', PASS)
    await answer($, 'a5', 'DECISION: ESCALATE\nREASON: the spec asks for Redis, the build uses memory')
    expect(w.toasts.at(-1)).toMatch(/The factory needs you/)
    const before = w.sent.length
    expect(await bandText($)).toMatch(/the spec asks for Redis/)
    expect(await command($, 'retry')).toMatch(/The approver escalated/)

    expect(await command($, 'approve')).toMatch(/Claude opens the PR/)
    expect(w.sent.length).toBe(before + 1)
    expect(w.sent.at(-1)).toMatch(/factory\/rate-limiter/)
  })

  test("stop ends the run: its agents' tool calls are refused, late answers ignored, the band goes", async ($, on) => {
    const w = engine(on)
    await startRun($)
    expect(await command($, 'stop')).toMatch(/Stopped\. The branch factory\/rate-limiter/)
    const edit = { tool: 'Edit', file_path: '/repo/.factory/rate-limiter/a.ts', old_string: 'a', new_string: 'b' }
    expect(String((await $.tool.call({ ...edit, agentId: 'a1' } as never)).deny)).toMatch(/factory run was stopped/)
    expect((await $.tool.call(edit as never)).result).toBe('edited')
    expect((await $.tool.call({ ...edit, agentId: 'other' } as never)).result).toBe('edited')
    await answer($, 'a1', SPEC_ANSWER)
    expect(w.sent).toEqual([])
    expect(await bandText($)).not.toMatch(/🏭/)
  })

  test('a Stop during the checks ends them: the commands left are not run', async ($, on) => {
    const w = engine(on, { hold: 'npm test', pkg: '{"scripts":{"test":"x","lint":"y","typecheck":"z"}}' })
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await command($, 'approve')
    await answer($, 'a2', 'built')
    expect(w.ran.at(-1)).toBe('npm test')
    await command($, 'stop')
    w.release()
    await settled()
    expect(w.ran.filter(c => c.startsWith('npm'))).toEqual(['npm test'])
    expect(w.spawned.some(s => s.subagentType.endsWith('reviewer'))).toBe(false)
  })

  test("a stopped run's agents stay refused after a new run starts", async ($, on) => {
    engine(on)
    await startRun($)
    await command($, 'stop')
    await command($, 'Second feature')
    const edit = { tool: 'Edit', file_path: '/repo/.factory/rate-limiter/a.ts', old_string: 'a', new_string: 'b' }
    expect(String((await $.tool.call({ ...edit, agentId: 'a1' } as never)).deny)).toMatch(/factory run was stopped/)
    expect((await $.tool.call({ ...edit, agentId: 'a2' } as never)).result).toBe('edited')
  })

  test('a run from a to-do item has Claude mark the item done once the PR is open', async ($, on) => {
    const w = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    const started = await command($, factoryArgs('Rate limiter — bursts must pass', 'k3x-1a2b3'))
    expect(started).toMatch(/Factory run started: Rate limiter — bursts must pass\./)
    expect(last(w).prompt).not.toContain('followup:')
    await answer($, 'a1', SPEC_ANSWER)
    await command($, 'approve')
    await answer($, 'a2', 'built')
    await answer($, 'a3', PASS)
    await answer($, 'a4', PASS)
    await answer($, 'a5', 'DECISION: APPROVE\nREASON: ok')
    await command($, 'approve')
    expect(w.sent.at(-1)).toMatch(/call mcp__followups__done with id "k3x-1a2b3"/)
  })

  test('a second run waits for the first', async ($, on) => {
    engine(on)
    await startRun($)
    expect(await command($, 'Something else')).toMatch(/already going: Rate limiter/)
  })

  test('the roles are hidden from the model', async ($, on) => {
    engine(on)
    on('agent.offer', () => ({ isOffered: true }) as never)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    expect((await $.agent.offer({ agent: 'factory:builder', description: 'x', source: 'plugin' } as never)).isOffered).toBe(false)
    expect((await $.agent.offer({ agent: 'Explore', description: 'x', source: 'built-in' } as never)).isOffered).toBe(true)
  })
})

describe('the parsers', () => {
  test('tasks, with priorities and what they need', () => {
    expect(parseTasks(SPEC_ANSWER)).toEqual([
      { title: 'Token bucket core', priority: 'high', dependsOn: [] },
      { title: 'Middleware with Retry-After', priority: 'high', dependsOn: [1] },
      { title: 'Tests for bursts', priority: 'medium', dependsOn: [1, 2] },
    ])
    expect(parseTasks('no list here')).toEqual([])
  })

  test('verdicts: no verdict and a PASS with a blocker are changes', () => {
    expect(parseVerdict(PASS).state).toBe('pass')
    expect(parseVerdict(CHANGES)).toEqual({ state: 'changes', findings: [{ severity: 'major', where: 'src/mw.ts:12', text: 'Retry-After is in ms, not seconds' }] })
    expect(parseVerdict('looks fine').state).toBe('changes')
    expect(parseVerdict('VERDICT: PASS\n- [blocker] a.ts:1 secret in code').state).toBe('changes')
  })

  test('decisions: anything unclear escalates', () => {
    expect(parseDecision('DECISION: APPROVE\nREASON: good')).toEqual({ decision: 'APPROVE', reason: 'good' })
    expect(parseDecision('hmm').decision).toBe('ESCALATE')
  })

  test('checks: the option splits into argv, detection reads the project', () => {
    expect(splitChecks('npm test; npm run lint\ngo vet ./...')).toEqual([['npm', 'test'], ['npm', 'run', 'lint'], ['go', 'vet', './...']])
    expect(detectChecks(['package.json'], '{"scripts":{"test":"x","lint":"y"}}')).toEqual([['npm', 'test'], ['npm', 'run', 'lint']])
    expect(detectChecks(['go.mod'], null)).toEqual([['go', 'test', './...']])
    expect(detectChecks([], null)).toEqual([])
  })

  test('setup: the lockfile, only when node_modules is missing', () => {
    expect(detectSetup(['package.json', 'pnpm-lock.yaml'])).toEqual(['pnpm', 'install', '--frozen-lockfile'])
    expect(detectSetup(['package.json', 'package-lock.json'])).toEqual(['npm', 'ci'])
    expect(detectSetup(['package.json'])).toEqual(['npm', 'install'])
    expect(detectSetup(['package.json', 'node_modules', 'package-lock.json'])).toBeNull()
    expect(detectSetup(['go.mod'])).toBeNull()
  })
})
