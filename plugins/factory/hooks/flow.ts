// The factory's pure parts: what each role is told, how its answer is read, which checks run, and
// how a run starts. The hooks module only spawns, runs and draws.

import type { Check, Finding, Phase, Review, Reviewer, Role, Run, Severity, SpecTask, StepState } from '../types'
import { FACTORY_SOURCE } from './texts'

export const REVIEWERS: Reviewer[] = ['security', 'code']

// Each role as an agent type `factory:<name>`, with the model it runs on by default.
export const ROLES: Record<Role, { name: string; model: string; label: string; tools?: string[] }> = {
  spec: { name: 'spec-writer', model: 'opus', label: 'spec-writer', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] },
  builder: { name: 'builder', model: 'opus', label: 'builder' },
  security: { name: 'security-reviewer', model: 'opus', label: 'security', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
  code: { name: 'code-reviewer', model: 'sonnet', label: 'code', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
  approver: { name: 'approver', model: 'opus', label: 'approver', tools: ['Read', 'Grep', 'Glob'] },
}

// The roles' standing instructions, short defaults; a project's own skills can say more.
export const ROLE_PROMPTS: Record<Role, string> = {
  spec: `You are the spec-writer of a software factory. You turn a feature request into a spec a builder can implement and reviewers can check against: a short PRD (the problem, who it's for, what's out of scope), a technical spec (the design, interfaces, data, failure modes) and numbered acceptance criteria, each testable. Read the code you need first; don't write any implementation.`,
  builder: `You are the builder of a software factory. You implement exactly what the spec asks, in the repository you are started in, with tests for each acceptance criterion. Keep the change focused; don't refactor beyond it. Commit your work to the current branch when you are done.`,
  security: `You are the security reviewer of a software factory. Review the change against the spec for: injection and unsafe input handling, authentication and authorization, secrets in code or logs, unsafe defaults, dependency risk, and data exposure. Report only real, specific problems.`,
  code: `You are the code reviewer of a software factory. Review the change against the spec for: correctness against each acceptance criterion, missing or weak tests, error handling, clarity, layering and design, and performance traps. Report only real, specific problems.`,
  approver: `You are the approver of a software factory. You decide whether a change that went through review can go to a pull request. You don't review the code again: you weigh the spec, the check results and the reviewers' verdicts and findings.`,
}

// ---------- reading the agents' answers ----------

// The spec-writer ends with:  TASKS:  then lines  "1. [high] Title (needs 2, 3)".
export function parseTasks(answer: string): SpecTask[] {
  const at = answer.lastIndexOf('TASKS:')
  if (at < 0) return []
  const out: SpecTask[] = []
  for (const raw of answer.slice(at + 6).split('\n')) {
    const m = /^\s*\d+[.)]\s*\[(high|medium|low)\]\s*(.+?)\s*(?:\(needs ([\d,\s]+)\))?\s*$/i.exec(raw)
    if (!m) continue
    out.push({ title: m[2]!.trim(), priority: m[1]!.toLowerCase() as SpecTask['priority'], dependsOn: (m[3] ?? '').split(/[,\s]+/).filter(Boolean).map(Number) })
  }
  return out
}

// A reviewer ends with:  VERDICT: PASS | CHANGES  and  FINDINGS:  "- [major] path:line what and why".
// No verdict reads as CHANGES, so a confused reviewer can't wave a change through.
export function parseVerdict(answer: string): { state: 'pass' | 'changes'; findings: Finding[] } {
  const verdict = /VERDICT:\s*(PASS|CHANGES)/i.exec(answer)?.[1]?.toUpperCase()
  const findings: Finding[] = []
  for (const raw of answer.split('\n')) {
    const m = /^\s*[-*]\s*\[(blocker|major|minor)\]\s+(\S+)\s+[—–-]?\s*(.+)$/i.exec(raw)
    if (m) findings.push({ severity: m[1]!.toLowerCase() as Severity, where: m[2]!, text: m[3]!.trim() })
  }
  if (!verdict) return { state: 'changes', findings: [{ severity: 'major', where: '-', text: 'The reviewer gave no VERDICT line.' }, ...findings] }
  // A PASS that still lists a blocker isn't a pass.
  const state = verdict === 'PASS' && !findings.some(f => f.severity === 'blocker') ? 'pass' : 'changes'
  return { state, findings }
}

// The approver ends with:  DECISION: APPROVE | ESCALATE  and  REASON: one line.
export function parseDecision(answer: string): { decision: 'APPROVE' | 'ESCALATE'; reason: string } {
  const decision = /DECISION:\s*(APPROVE|ESCALATE)/i.exec(answer)?.[1]?.toUpperCase() === 'APPROVE' ? 'APPROVE' : 'ESCALATE'
  const reason = /REASON:\s*(.+)/i.exec(answer)?.[1]?.trim() ?? (decision === 'ESCALATE' ? 'The approver gave no clear decision.' : '')
  return { decision, reason }
}

// ---------- the checks ----------

// The `checks` option: commands separated by ";" or new lines, each run without a shell.
export function splitChecks(option: string): string[][] {
  return option.split(/[;\n]/).map(c => c.trim()).filter(Boolean).map(c => c.split(/\s+/))
}

// With no `checks` set: what the project's own files suggest.
export function detectChecks(files: string[], packageJson: string | null): string[][] {
  const out: string[][] = []
  if (packageJson !== null) {
    let scripts: Record<string, unknown> = {}
    try {
      scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {}
    } catch {
      scripts = {}
    }
    if (scripts.test) out.push(['npm', 'test'])
    for (const s of ['lint', 'typecheck']) if (scripts[s]) out.push(['npm', 'run', s])
  }
  if (files.includes('pyproject.toml') || files.includes('pytest.ini') || files.includes('setup.cfg')) out.push(['python', '-m', 'pytest', '-q'])
  if (files.includes('go.mod')) out.push(['go', 'test', './...'])
  if (files.includes('Cargo.toml')) out.push(['cargo', 'test'])
  return out
}

// A fresh worktree has no installed dependencies: with no `setup` set, the lockfile says how to
// install them. Nothing when they're there already (or the project isn't one of these).
export function detectSetup(files: string[]): string[] | null {
  if (!files.includes('package.json') || files.includes('node_modules')) return null
  if (files.includes('pnpm-lock.yaml')) return ['pnpm', 'install', '--frozen-lockfile']
  if (files.includes('yarn.lock')) return ['yarn', 'install', '--frozen-lockfile']
  if (files.includes('package-lock.json')) return ['npm', 'ci']
  return ['npm', 'install']
}

// The last lines of a failing command's output: enough for the builder, short for the pane.
export const tailOf = (text: string, lines = 30) => text.trim().split('\n').slice(-lines).join('\n')

// ---------- what each step is asked ----------

export const slugOf = (feature: string) =>
  feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'feature'

export function specPrompt(run: Run, feedback = ''): string {
  return [
    `Feature: ${run.feature}`,
    ...(feedback ? [`The person asked for changes to your earlier spec: ${feedback}`, 'Revise the spec file and the tasks.'] : []),
    `Write the spec to ${run.specFile} (create the folder if needed).`,
    'Then end your answer with the task breakdown, in this exact form, 3 to 8 tasks, in any order:',
    'TASKS:',
    '1. [high] <short imperative title>',
    '2. [medium] <title> (needs 1)',
    'Priority is how much a task matters to the feature; "needs" lists the tasks it depends on.',
  ].join('\n')
}

export function buildPrompt(run: Run, findings: Finding[], failed: Check[]): string {
  const tasks = run.tasks.map((t, i) => `- t${i + 1}: ${t.title}`)
  return [
    `Implement the spec in ${run.specFile} for: ${run.feature}`,
    `You are on branch ${run.branch}, in its own worktree. Commit your work to this branch when done.`,
    'The tasks (in the session goal, if goal-run is installed: mark each with mcp__goal-run__update as in_progress, then done):',
    ...tasks,
    ...(failed.length
      ? ['', 'The checks failed on your last pass. Fix them:', ...failed.map(c => `$ ${c.cmd}\n${c.tail}`)]
      : []),
    ...(findings.length
      ? ['', `Review round ${run.round} asked for changes. Fix each blocker and major finding; fix a minor one only when it's cheap:`, ...findings.map(f => `- [${f.severity}] ${f.where} ${f.text}`)]
      : []),
    '',
    'End with a two-line summary of what you changed.',
  ].join('\n')
}

export function reviewPrompt(run: Run, role: Reviewer, stat: string): string {
  return [
    `Review the change for: ${run.feature}`,
    `The spec is ${run.specFile}. The change is the commits on branch ${run.branch} since ${run.base.slice(0, 12)}, in the repository you are started in (git diff ${run.base.slice(0, 12)}..HEAD): exactly what will be pushed.`,
    stat ? `Files changed:\n${stat}` : '',
    `Look only at what a ${role} review covers. Don't change any file.`,
    'End your answer with exactly:',
    'VERDICT: PASS or VERDICT: CHANGES',
    'FINDINGS:',
    '- [blocker|major|minor] <path:line> <what is wrong and why>',
    'A blocker or major finding means CHANGES. Write "FINDINGS: none" when there are none.',
  ].filter(Boolean).join('\n')
}

export function approvePrompt(run: Run): string {
  const reviews = run.reviews.map(r => `- ${r.role}: ${r.state === 'pass' ? 'PASS' : 'CHANGES'}${r.findings.length ? `\n${r.findings.map(f => `  - [${f.severity}] ${f.where} ${f.text}`).join('\n')}` : ''}`)
  return [
    `Decide on the change for: ${run.feature}`,
    `The spec is ${run.specFile}; the change is on branch ${run.branch}.`,
    `Checks: ${run.checks.length ? run.checks.map(c => `${c.cmd} ${c.ok ? 'passed' : 'FAILED'}`).join(', ') : 'none configured'}.`,
    `Review rounds: ${run.round}. The last verdicts:`,
    ...reviews,
    'APPROVE when every acceptance criterion is met and no blocker or major finding is left; otherwise ESCALATE to the person.',
    'End with exactly:',
    'DECISION: APPROVE or DECISION: ESCALATE',
    'REASON: <one line>',
  ].join('\n')
}

// To the main Claude: put the spec's tasks into goal-run's plan, where the person approves them.
export function planPrompt(run: Run): string {
  const tasks = JSON.stringify(run.tasks.map(t => ({ title: t.title, priority: t.priority, ...(t.dependsOn.length ? { dependsOn: t.dependsOn } : {}) })))
  return [
    `The factory's spec for "${run.feature}" is in ${run.specFile}.`,
    `Call mcp__goal-run__plan now with goal "${run.feature}", source "${FACTORY_SOURCE}", and exactly these tasks, unchanged:`,
    tasks,
    "Then stop: the factory's builder does the work. Don't start the tasks or edit any file.",
  ].join('\n')
}

// To the main Claude, once approved: the PR, through whatever GitHub access the session has.
export function prPrompt(run: Run, reason: string): string {
  const minor = run.reviews.flatMap(r => r.findings.filter(f => f.severity === 'minor').map(f => `- ${r.role}: ${f.where} ${f.text}`))
  return [
    `The factory run "${run.feature}" is approved${reason ? ` (${reason})` : ''}.`,
    `Push branch ${run.branch} (its worktree is ${run.worktree}) and open a pull request from it.`,
    `Title it after the feature. In the body: what it does (from ${run.specFile}), the checks (${run.checks.map(c => `${c.cmd} ${c.ok ? '✓' : '✗'}`).join(', ') || 'none'}), and ${run.round} review round${run.round === 1 ? '' : 's'}: ${run.reviews.map(r => `${r.role} ${r.state === 'pass' ? 'PASS' : 'CHANGES'}`).join(', ')}.`,
    ...(minor.length ? ['List these minor findings under "Not fixed":', ...minor] : []),
    ...(run.followupId ? [`Once the PR is open, call mcp__followups__done with id "${run.followupId}" and the PR's link as the note: the run came from that to-do item.`] : []),
    ...(run.skipped?.length ? [`The factory left these new files out of its commits (dependencies, build output or credentials); don't add them: ${run.skipped.join(', ')}.`] : []),
  ].join('\n')
}

// ---------- a run ----------

// The worktrees sit inside the repository, in .factory/ (kept out of git): within the session's
// working directory, so the agents' edits get the same permissions and sandbox as the person's.
export const worktreeOf = (root: string, slug: string) => `${root.replace(/[\\/]+$/, '')}/.factory/${slug}`

// What the builder may leave untracked that never goes into a commit: installed dependencies,
// build output, and credentials.
const NEVER_COMMIT = [/(^|\/)(node_modules|\.venv|venv|__pycache__|dist|build)(\/|$)/, /(^|\/)\.env(\.[^/]*)?$/, /\.(pem|key|p12|pfx)$/i]
export const neverCommit = (path: string) => NEVER_COMMIT.some(re => re.test(path))

// The untracked paths in `git status --porcelain` output (a folder ends in /).
export const untrackedOf = (porcelain: string) =>
  porcelain.split('\n').filter(l => l.startsWith('?? ')).map(l => l.slice(3).replace(/^"(.*)"$/, '$1'))

export function newRun(feature: string, at: number, base: string, root: string, slug = slugOf(feature)): Run {
  const step = (): { state: StepState; tokens: number } => ({ state: 'wait', tokens: 0 })
  return {
    feature: feature.trim(),
    slug,
    phase: 'spec',
    round: 0,
    checkRound: 0,
    startedAt: at,
    base,
    branch: `factory/${slug}`,
    worktree: worktreeOf(root, slug),
    specFile: `docs/specs/${slug}.md`,
    tasks: [],
    steps: { spec: { state: 'run', tokens: 0 }, builder: step(), checks: step(), approver: step() },
    checks: [],
    reviews: REVIEWERS.map(role => ({ role, state: 'wait' as StepState, findings: [], tokens: 0, round: 0, agentId: null })),
    agents: {},
    note: 'writing the spec',
    blocked: null,
    gate: 'goal-run',
    setupDone: false,
  }
}

export const isLive = (p: Phase) => p !== 'done' && p !== 'stopped'
// Waiting for the person, not for an agent or a command.
export const waitsOnPerson = (p: Phase) => p === 'plan' || p === 'ready' || p === 'needs-human'
export const tokensOf = (run: Run) => Object.values(run.steps).reduce((n, s) => n + s.tokens, 0) + run.reviews.reduce((n, r) => n + r.tokens, 0)
export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

// The findings the builder must still address: every finding of the reviewers that asked for changes.
export const openFindings = (reviews: Review[]) => reviews.filter(r => r.state === 'changes').flatMap(r => r.findings)
