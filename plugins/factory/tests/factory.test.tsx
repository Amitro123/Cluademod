import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detectChecks, parseDecision, parseTasks, parseVerdict, splitChecks } from '../hooks/flow'
import { PLAN_APPROVED_FOR_FACTORY, planChangesForFactory } from '../hooks/texts'

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
function engine(on: On, { goalRun = true, checkFails = 0, files = ['package.json'], pkg = '{"scripts":{"test":"vitest"}}', denyType = false } = {}) {
  const spawned: Spawned[] = []
  const ran: string[] = []
  const sent: string[] = []
  const toasts: string[] = []
  const written: Record<string, string> = {}
  let fails = checkFails
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
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    if (cmd === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } } as never
    if (cmd === 'git rev-parse HEAD') return { value: { exitCode: 0, stdout: 'abc123\n', stderr: '' } } as never
    if (cmd.startsWith('git diff --stat')) return { value: { exitCode: 0, stdout: ' src/mw.ts | 40 +++\n 1 file changed', stderr: '' } } as never
    if (cmd.startsWith('git ')) return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    if (fails > 0) {
      fails--
      return { value: { exitCode: 1, stdout: 'FAIL src/mw.test.ts\n  expected 429', stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: 'ok', stderr: '' } } as never
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('.git/info/exclude')) return { value: written[e.path] ?? '# git ls-files --others --exclude-from=.git/info/exclude\n' } as never
    if (e.path.endsWith('package.json')) return { value: pkg } as never
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
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { spawned, ran, sent, toasts, written }
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? '')).join(' | ')

// An agent of the run answers: its turn completes, and the factory moves on.
async function answer($: Engine, id: string, text: string, reason: 'answer' | 'error' = 'answer') {
  await $.turn.complete({ answer: text, durationMs: 1000, isAborted: false, turnId: `t-${id}`, agentId: id, reason } as never)
  await settled()
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

// The transitions run after the event that caused them returns (in the plugin's own copy of the module).
async function settled() {
  for (let i = 0; i < 30; i++) await new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, 0))
}

const last = (w: { spawned: Spawned[] }) => w.spawned.at(-1)!

describe('a run from the feature to the PR', () => {
  test('spec, the plan in goal-run, build, checks, both reviews, the approver, then the PR prompt', async ($, on) => {
    const w = engine(on)
    const started = await startRun($)
    expect(started).toMatch(/Factory run started: Rate limiter\. Branch factory\/rate-limiter/)
    expect(w.ran).toContain('git worktree add -b factory/rate-limiter /repo/.factory/rate-limiter abc123')
    expect(w.written['/repo/.git/info/exclude']).toMatch(/^\.factory\/$/m)
    expect(last(w)).toMatchObject({ subagentType: 'factory:spec-writer', description: 'factory · spec-writer', cwd: '/repo/.factory/rate-limiter' })
    expect(last(w).prompt).toContain('Rate limiter')

    // The spec's tasks go to goal-run's plan, through the main Claude.
    await step($, 'a1')
    await answer($, 'a1', SPEC_ANSWER)
    expect(w.sent.at(-1)).toContain(PLAN)
    expect(w.sent.at(-1)).toMatch(/"source"\s*:\s*"factory"|source "factory"/)
    expect(w.sent.at(-1)).toContain('Middleware with Retry-After')
    expect(w.spawned).toHaveLength(1)

    // The person approves in goal-run's dialog: the builder starts.
    await $.tool.call({ tool: PLAN, goal: 'Rate limiter', source: 'factory', tasks: [{ title: 'Token bucket core', priority: 'high' }] } as never)
    await settled()
    expect(last(w)).toMatchObject({ id: 'a2', subagentType: 'factory:builder', description: 'factory · builder, round 1' })

    // Green checks, then the two reviewers at once.
    await answer($, 'a2', 'Done, committed.')
    expect(w.ran).toContain('npm test')
    expect(w.spawned.slice(2).map(s => s.subagentType)).toEqual(['factory:security-reviewer', 'factory:code-reviewer'])
    expect(w.spawned[2]!.prompt).toContain('src/mw.ts | 40')

    await answer($, 'a3', PASS)
    expect(w.spawned).toHaveLength(4)
    await answer($, 'a4', PASS)
    expect(last(w)).toMatchObject({ id: 'a5', subagentType: 'factory:approver' })

    await answer($, 'a5', 'DECISION: APPROVE\nREASON: spec met, tests green')
    expect(w.sent.at(-1)).toMatch(/factory\/rate-limiter/)
    expect(w.sent.at(-1)).toMatch(/pull request|PR/)

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    const text = await texts(pane)
    expect(text).toMatch(/✓ spec-writer \(opus\) · 3 tasks/)
    expect(text).toMatch(/✓ approver/)
    expect(text).toMatch(/✓ open PR/)
    expect(text).toMatch(/2k tokens/)
    await pane.unmount()
  })

  test('changes send the builder back with the findings, and only that reviewer looks again', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.command.run({ command: 'factory', args: 'plan-approved' } as never)
    await settled()
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

    await answer($, 'a5', 'fixed')
    expect(w.spawned.slice(5).map(s => s.subagentType)).toEqual(['factory:code-reviewer'])
    await answer($, 'a6', PASS)
    expect(last(w).subagentType).toBe('factory:approver')
  })

  test('at the round limit the approver decides on what it has', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.command.run({ command: 'factory', args: 'approve' } as never)
    await settled()
    await answer($, 'a2', 'built')
    await answer($, 'a3', PASS)
    await answer($, 'a4', CHANGES)
    await answer($, 'a5', 'fixed')
    await answer($, 'a6', CHANGES)
    expect(last(w).subagentType).toBe('factory:approver')
    expect(last(w).prompt).toContain('Retry-After')
  })
})

describe('the checks come before any reviewer', () => {
  test('red checks go back to the builder, then to the person', async ($, on) => {
    const w = engine(on, { checkFails: 5 })
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.command.run({ command: 'factory', args: 'approve' } as never)
    await settled()
    await answer($, 'a2', 'built')
    expect(last(w)).toMatchObject({ id: 'a3', subagentType: 'factory:builder' })
    expect(last(w).prompt).toContain('expected 429')
    await answer($, 'a3', 'fixed?')
    expect(w.spawned).toHaveLength(3)
    expect(w.spawned.some(s => s.subagentType.endsWith('reviewer'))).toBe(false)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/checks still fail after 2 builder passes: npm test/)
    await band.unmount()
  })

  test('the checks option wins over detection, and no checks at all is a skip', async ($, on) => {
    const w = engine(on, { files: [] })
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.command.run({ command: 'factory', args: 'approve' } as never)
    await settled()
    await answer($, 'a2', 'built')
    expect(w.ran.filter(c => !c.startsWith('git '))).toEqual([])
    expect(w.spawned.slice(2).map(s => s.subagentType)).toEqual(['factory:security-reviewer', 'factory:code-reviewer'])
  })
})

describe('without goal-run', () => {
  test("the factory asks for the plan's approval itself", async ($, on) => {
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

  test("a role the engine wouldn't register runs as a general-purpose agent with the role's instructions", async ($, on) => {
    const w = engine(on, { denyType: true })
    await startRun($)
    expect(last(w).subagentType).toBe('general-purpose')
    expect(last(w).prompt).toMatch(/spec-writer|spec/i)
    expect(last(w).prompt).toContain('Rate limiter')
  })
})

describe('the person decides', () => {
  test('changes to the plan go back to the spec-writer', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.classic.PostToolUse({ tool_name: PLAN, tool_input: {}, tool_response: planChangesForFactory('split the middleware task') } as never)
    await settled()
    expect(last(w)).toMatchObject({ id: 'a2', subagentType: 'factory:spec-writer' })
    expect(last(w).prompt).toContain('split the middleware task')
  })

  test('an ESCALATE waits for the person; /factory approve sends the PR prompt', async ($, on) => {
    const w = engine(on)
    await startRun($)
    await answer($, 'a1', SPEC_ANSWER)
    await $.command.run({ command: 'factory', args: 'approve' } as never)
    await settled()
    await answer($, 'a2', 'built')
    await answer($, 'a3', PASS)
    await answer($, 'a4', PASS)
    await answer($, 'a5', 'DECISION: ESCALATE\nREASON: the spec asks for Redis, the build uses memory')
    expect(w.toasts.at(-1)).toMatch(/The factory needs you/)
    const before = w.sent.length
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).toMatch(/the spec asks for Redis/)
    await band.unmount()

    const r = await $.command.run({ command: 'factory', args: 'approve' } as never)
    expect(String(r.text)).toMatch(/Claude opens the PR/)
    await settled()
    expect(w.sent.length).toBe(before + 1)
    expect(w.toasts).toHaveLength(1)
    expect(w.sent.at(-1)).toMatch(/factory\/rate-limiter/)
  })

  test('stop ends the run: late answers are ignored and the band goes', async ($, on) => {
    const w = engine(on)
    await startRun($)
    const r = await $.command.run({ command: 'factory', args: 'stop' } as never)
    expect(String(r.text)).toMatch(/Stopped\. The branch factory\/rate-limiter/)
    await answer($, 'a1', SPEC_ANSWER)
    expect(w.sent).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await texts(band)).not.toMatch(/🏭/)
    await band.unmount()
  })

  test('a second run waits for the first', async ($, on) => {
    engine(on)
    await startRun($)
    const r = await $.command.run({ command: 'factory', args: 'Something else' } as never)
    expect(String(r.text)).toMatch(/already going: Rate limiter/)
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
})
