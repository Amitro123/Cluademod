// The factory's pure parts: what each role is told, how its answer is read, which checks run, and
// how a run starts. The hooks module only spawns, runs and draws.

import type { Check, Finding, Phase, Review, Reviewer, Role, Run, Severity, Size, SpecTask, StepState } from '../types'
import { FACTORY_SOURCE } from './texts'

export const REVIEWERS: Reviewer[] = ['security', 'code']

// Each role as an agent type `factory:<name>`, with the model it runs on by default: sonnet does
// the writing and building; opus is kept where a miss costs most, the security review and the
// approval. A large feature moves the builder up to opus too (modelsFor).
export const ROLES: Record<Role, { name: string; model: string; label: string; tools?: string[] }> = {
  spec: { name: 'spec-writer', model: 'sonnet', label: 'spec-writer', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] },
  builder: { name: 'builder', model: 'sonnet', label: 'builder' },
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

// The spec-writer's size line:  SIZE: small | medium | large.  None (or another word): null.
export function parseSize(answer: string): Size | null {
  const m = /^\s*SIZE:\s*(small|medium|large)\b/im.exec(answer)
  return m ? (m[1]!.toLowerCase() as Size) : null
}

// The model each role runs on for a feature of this size. 'auto' moves the builder up to opus for a
// large one; 'fixed' keeps the defaults whatever the size.
export function modelsFor(size: Size | null, mode: 'auto' | 'fixed'): Record<Role, string> {
  const out = Object.fromEntries((Object.keys(ROLES) as Role[]).map(r => [r, ROLES[r].model])) as Record<Role, string>
  if (mode === 'auto' && size === 'large') out.builder = 'opus'
  return out
}

// The factory's own skill for a role, shipped in the plugin (skills/<name>/SKILL.md): its method.
export const builtinSkill = (role: Role) => `factory:${ROLES[role].name}`

// The skills option: which skills a role loads before its job, in place of the factory's own, as
// "role=skill,skill; role=skill" (spec, builder, security, code, approver); "role=none" loads none.
// A skill can be a plugin's, plugin:name. Unknown roles and empty names are left out.
export function parseSkills(text: string): Partial<Record<Role, string[]>> {
  const out: Partial<Record<Role, string[]>> = {}
  for (const part of text.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const role = part.slice(0, at).trim().toLowerCase() as Role
    if (!(role in ROLES)) continue
    const names = part.slice(at + 1).split(',').map(x => x.trim()).filter(Boolean)
    // none: the role loads no skill, not even the factory's own.
    if (names.length === 1 && names[0]!.toLowerCase() === 'none') out[role] = []
    else if (names.length) out[role] = [...(out[role] ?? []), ...names]
  }
  return out
}

// What a role is told first when it has skills: load them, and follow them for this job.
export const skillsLine = (names: readonly string[]) =>
  `Before anything else, load ${names.length === 1 ? 'this skill' : 'these skills'} with the Skill tool and follow ${names.length === 1 ? 'it' : 'them'} for this job: ${names.map(n => `Skill(${n})`).join(', ')}. If one isn't installed, say so in your answer and go on without it.`

export const modelOf = (run: Pick<Run, 'models'> | null | undefined, role: Role) => run?.models?.[role] ?? ROLES[role].model

// The answer's last line that holds exactly one `KEY: <option>`: an answer that echoes the prompt's
// template ("VERDICT: PASS or VERDICT: CHANGES", a line with both) before its own isn't read as it.
function lastSingle(answer: string, key: string, options: string): string | undefined {
  let found: string | undefined
  for (const line of answer.split('\n')) {
    const all = [...line.matchAll(new RegExp(`${key}:\\s*(${options})`, 'gi'))]
    if (all.length === 1) found = all[0]![1]!.toUpperCase()
  }
  return found
}

// A reviewer ends with:  VERDICT: PASS | CHANGES  and  FINDINGS:  "- [major] path:line what and why".
// No verdict reads as CHANGES, so a confused reviewer can't wave a change through.
export function parseVerdict(answer: string): { state: 'pass' | 'changes'; findings: Finding[] } {
  const verdict = lastSingle(answer, 'VERDICT', 'PASS|CHANGES')
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
  const decision = lastSingle(answer, 'DECISION', 'APPROVE|ESCALATE') === 'APPROVE' ? 'APPROVE' : 'ESCALATE'
  const reason = [...answer.matchAll(/REASON:\s*(.+)/gi)].at(-1)?.[1]?.trim() ?? (decision === 'ESCALATE' ? 'The approver gave no clear decision.' : '')
  return { decision, reason }
}

// ---------- the checks ----------


// With no `checks` set: what the project's own files suggest. Detection lives in checks.ts (never throws).
export { detectChecks, detectProjectChecks, specChecks, allowedCommand, splitChecks, NOTHING_RAN } from './checks'
export type { ChecksIO, DetectedChecks } from './checks'

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

// The feature as typed or handed over, without the wrapper a paste carries in the prompt.
export const cleanFeature = (text: string) =>
  text.replace(/<\/?pasted_content\b[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

// To the main Claude, when the factory takes over a goal or a to-do item: the work is the factory's.
// After a takeOver whose run then failed to start: the work is the main Claude's after all.
export const factoryCouldNotStart = (why: string) => `The factory couldn't start that run after all: ${why} Do the work yourself, as first asked.`
export const takeOverNote = (feature: string) =>
  `The factory took this over: "${titleOf(feature, 200)}". Its spec-writer writes the spec and its builder does the work, in a worktree of its own. Don't start the work or propose a plan yourself; answer in one line that the factory is on it.`

// A run's name where a line is all there is (the band, a dialog's first line): the feature's first
// sentence, clipped. A feature is often a whole paragraph of instructions.
export function titleOf(feature: string, n = 60): string {
  const line = feature.trim().split('\n')[0]!.trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line
  return sentence.length > n ? `${sentence.slice(0, n - 1).trimEnd()}…` : sentence
}

// A branch and folder name from the feature: its Latin letters and digits. A feature written partly
// or wholly in another script (Hebrew, say) keeps too little of itself that way, so it gets a short
// stable hash of the whole text, and two such features don't share a name.
export function slugOf(feature: string): string {
  const latin = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')
  if (latin && !/[^\x00-\x7f]/.test(feature)) return latin
  let h = 0x811c9dc5
  for (const c of feature.trim()) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0
  return `${latin || 'feature'}-${h.toString(36).padStart(7, '0').slice(-7)}`
}

export function specPrompt(run: Run, feedback = ''): string {
  return [
    `Feature: ${run.feature}`,
    ...(feedback ? [`The person asked for changes to your earlier spec: ${feedback}`, 'Revise the spec file and the tasks.'] : []),
    `Write the spec to ${run.specFile} (create the folder if needed).`,
    `End the spec file with a "## Code map" section, for the builder and reviewers to start from instead of searching again: each file the change touches or depends on, with the functions, types and line ranges that matter (path:start-end) and a few words on each; the signatures of the types it uses from large files (type definitions, generated code), so nobody reads those whole; and the commands that test the change. In it, list every copy of the code the change touches (the same logic in another module, a bundled and a standalone version, generated output) and mark each in or out of scope.`,
    'Then judge the size of the feature, on a line of its own:',
    'SIZE: small, medium or large',
    'small: a local change in one or two files. medium: a few files in one area, the design clear. large: it spans several modules, or needs design decisions (architecture, data model or migrations, security, concurrency), or the request leaves real questions open. The builder runs on a stronger model for a large one.',
    'Then end your answer with the task breakdown, in this exact form, 3 to 8 tasks, in any order:',
    'TASKS:',
    '1. [high] <short imperative title>',
    '2. [medium] <title> (needs 1)',
    'Priority is how much a task matters to the feature; "needs" lists the tasks it depends on.',
  ].join('\n')
}

// What a builder that stopped mid-job is told when it's sent on: it keeps its own context, so only
// to pick up where it was, after checking what it already left in the worktree.
export const resumePrompt = (why: string) =>
  `You stopped before finishing${why ? ` (${why})` : ''}. Carry on from where you stopped: check \`git status\` and \`git log\` in this worktree for what you already did, and don't redo it. Commit when done, and end with the two-line summary of what you changed.`

// A new builder on a worktree that already has work in it (the one before stopped and couldn't be
// sent on): what is there, from git, so it starts from it instead of reading its way back.
export function progressNote(log: string, status: string): string {
  const commits = log.trim().split('\n').filter(Boolean)
  const changed = status.trim().split('\n').filter(Boolean)
  if (!commits.length && !changed.length) return ''
  return [
    'A builder before you started this job and stopped; its work is in this worktree. Start from it, check it against the spec, and do what is left; don\'t redo it.',
    ...(commits.length ? [`Its commits (newest first):`, ...commits.slice(0, 20).map(c => `- ${c}`)] : []),
    ...(changed.length ? [`Uncommitted changes:`, ...changed.slice(0, 30).map(c => `- ${c.trim()}`)] : []),
  ].join('\n')
}

// An API error no other model gets past (a spend or rate limit, quota, overload): the run waits for
// the person's Retry instead of trying the session's model at once.
export const isLimitError = (why: string) => /spend limit|rate limit|usage limit|quota|overloaded|429|529|credit/i.test(why)

// The builder's prompt: the whole job for a new builder; for the builder that built it before
// (`again`), only what to fix this round. A note is the person's own, sent back with /factory rework.
export function buildPrompt(run: Run, findings: Finding[], failed: Check[], { again = false, note = '' } = {}): string {
  // In the session goal, goal-run's ids: it numbers the tasks in its own order, not the spec's.
  const tasks = run.gate === 'goal-run' && run.goalTasks?.length ? run.goalTasks.map(t => `- ${t.id}: ${t.title}`) : run.tasks.map((t, i) => `- t${i + 1}: ${t.title}`)
  const head = again
    ? [`Another round on the change you built for: ${titleOf(run.feature, 200)}`, `Same branch ${run.branch} and worktree. Fix what follows, keep the rest as it is, and commit.`]
    : [
        `Implement the spec in ${run.specFile} for: ${run.feature}`,
        `You are on branch ${run.branch}, in its own worktree. Commit your work to this branch when done.`,
        `For each of the spec's Open questions, say in your closing summary how you settled it.`,
        `Start from the spec's "Code map": read the files it lists by the ranges it gives. Search (Grep) before reading anything it doesn't list, and never read a large file (type definitions, generated code, lockfiles) whole.`,
        // Marked in goal-run only when its plan is the session goal: when goal-run kept the person's own
        // goal, its t1, t2... are the person's tasks, not these.
        run.gate === 'goal-run' ? 'The tasks (in the session goal: mark each with mcp__goal-run__update as in_progress, then done):' : 'The tasks:',
        ...tasks,
      ]
  return [
    ...head,
    ...(note ? ['', `The person sent the change back: ${note}`] : []),
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

// Why a command run rejected: it couldn't start (its program isn't installed), unless it timed out.
export const couldNotStart = (err: unknown) => !/time(d)?\s*out/i.test(String(err))

// The checks that actually ran: one whose program isn't installed here was skipped, not run.
export const ranChecks = (run: Pick<Run, 'checks'>) => run.checks.filter(c => !c.isMissing)
const checkWord = (c: Check) => (c.isMissing ? 'not installed, not run' : c.ok ? 'passed' : 'FAILED')

export function reviewPrompt(run: Run, role: Reviewer, stat: string): string {
  return [
    `Review the change for: ${run.feature}`,
    `The spec is ${run.specFile}. The change is the commits on branch ${run.branch} since ${run.base.slice(0, 12)}, in the repository you are started in (git diff ${run.base.slice(0, 12)}..HEAD): exactly what will be pushed.`,
    stat ? `Files changed:\n${stat}` : '',
    ...(!ranChecks(run).length && run.checksNote ? [`No checks ran for this change: ${run.checksNote} Nothing was verified by running it, so weigh the tests you read accordingly.`] : []),
    `Start from the diff and the spec's "Code map". Read a changed file whole when it is short (under about 400 lines), else around the changed lines; search before reading anything else.`,
    'Check every API field, input or type the change, or an acceptance criterion, relies on against its real definition (search for it and read the definition), not against the spec\'s wording: a criterion built on a field that doesn\'t exist is a blocker, and a test that only feeds a made-up fixture doesn\'t prove it.',
    `Look only at what a ${role} review covers. Don't change any file.`,
    'End your answer with exactly:',
    'VERDICT: PASS or VERDICT: CHANGES',
    'FINDINGS:',
    '- [blocker|major|minor] <path:line> <what is wrong and why>',
    'A blocker or major finding means CHANGES. Write "FINDINGS: none" when there are none.',
  ].filter(Boolean).join('\n')
}

// `stat`: git's list of the files the change touched, so the approver can hold them against the spec.
export function approvePrompt(run: Run, stat = ''): string {
  const reviews = run.reviews.map(r => `- ${r.role}: ${r.state === 'pass' ? 'PASS' : 'CHANGES'}${r.findings.length ? `\n${r.findings.map(f => `  - [${f.severity}] ${f.where} ${f.text}`).join('\n')}` : ''}`)
  return [
    `Decide on the change for: ${run.feature}`,
    `The spec is ${run.specFile}; the change is on branch ${run.branch}.`,
    `Checks: ${ranChecks(run).length ? run.checks.map(c => `${c.cmd} ${checkWord(c)}`).join(', ') : `NONE RAN. ${run.checksNote || 'none configured'}`}.`,
    ...(ranChecks(run).length && run.checksNote ? [`Check notes: ${run.checksNote}`] : []),
    ...(stat ? [`Files the change touched:\n${stat}`, "Hold them against the spec's Design and Code map: a file, dependency or public interface the spec doesn't name is scope it didn't ask for. Name it in your reason, and ESCALATE unless it is plainly needed to meet a criterion."] : []),
    "Read the spec's Open questions: one the change settled by guessing, rather than the way the spec or the builder's summary says, is the person's to decide: ESCALATE.",
    `Review rounds: ${run.round}. The last verdicts:`,
    ...reviews,
    'APPROVE when every acceptance criterion is met and no blocker or major finding is left; otherwise ESCALATE to the person.',
    ...(!ranChecks(run).length ? ['No check ran: an APPROVE goes to the person as an escalation, since nothing was verified by running it. Say in your reason what the reviews did verify.'] : []),
    'End with exactly:',
    'DECISION: APPROVE or DECISION: ESCALATE',
    'REASON: <one line>',
  ].join('\n')
}

// To the main Claude: put the spec's tasks into goal-run's plan, where the person approves them.
export function planPrompt(run: Run): string {
  const tasks = JSON.stringify(run.tasks.map(t => ({ title: t.title, priority: t.priority, ...(t.dependsOn.length ? { dependsOn: t.dependsOn } : {}) })))
  return [
    `The factory's spec for ${JSON.stringify(run.feature)} is in ${run.specFile}.`,
    `Call mcp__goal-run__plan now with goal ${JSON.stringify(run.feature)}, source "${FACTORY_SOURCE}", and exactly these tasks, unchanged:`,
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
    `Title it after the feature. In the body: what it does (from ${run.specFile}), the checks (${run.checks.map(c => `${c.cmd} ${c.isMissing ? '– not installed' : c.ok ? '✓' : '✗'}`).join(', ') || 'none ran'}), and ${run.round} review round${run.round === 1 ? '' : 's'}: ${run.reviews.map(r => `${r.role} ${r.state === 'pass' ? 'PASS' : 'CHANGES'}`).join(', ')}.`,
    ...(minor.length ? ['List these minor findings under "Not fixed":', ...minor] : []),
    ...(run.followupId ? [`Once the PR is open, call mcp__followups__done with id "${run.followupId}" and the PR's link as the note: the run came from that to-do item.`] : []),
    ...(run.skipped?.length ? [`The factory left these new files out of its commits (dependencies, build output or credentials); don't add them: ${run.skipped.join(', ')}.`] : []),
  ].join('\n')
}

// ---------- a run ----------

// The worktrees sit inside the repository, in .factory/ (kept out of git): within the session's
// working directory, so the agents' edits get the same permissions and sandbox as the person's.
export const worktreeOf = (root: string, slug: string) => `${root.replace(/[\\/]+$/, '')}/.factory/${slug}`
// The main repository a run's worktree belongs to: worktreeOf turned back.
export const rootOf = (run: { worktree: string; slug: string }) => run.worktree.slice(0, -`/.factory/${run.slug}`.length)
// Beside the worktree, never in it: a slug has no dot, so no run's worktree is named so.
export const recordOf = (root: string, slug: string) => `${root.replace(/[\\/]+$/, '')}/.factory/${slug}.record`

// An agent's closing lines: the builder ends with a two-line summary of what it changed.
export function lastLines(text: string, n: number): string {
  return text.split('\n').map(l => l.trim()).filter(Boolean).slice(-n).join(' ').slice(0, 300)
}

// What the builder may leave untracked that never goes into a commit: installed dependencies,
// build output, and credentials.
const NEVER_COMMIT = [/(^|\/)(node_modules|\.venv|venv|__pycache__|dist|build)(\/|$)/, /(^|\/)\.env(\.[^/]*)?$/, /\.(pem|key|p12|pfx)$/i]
export const neverCommit = (path: string) => NEVER_COMMIT.some(re => re.test(path))

// The files left out, as a person reads them: a file inside an excluded folder (node_modules/, dist/)
// as that folder, once, so a whole install doesn't list file by file.
export function leftOut(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    const parts = p.split('/')
    let shown = p
    for (let i = 1; i < parts.length; i++) {
      const dir = `${parts.slice(0, i).join('/')}/`
      if (neverCommit(dir)) {
        shown = dir
        break
      }
    }
    if (!out.includes(shown)) out.push(shown)
  }
  return out
}

// The untracked files in `git status --porcelain -z -uall` output: each file on its own (never a
// folder, which would stage the .env or node_modules inside it), unquoted, non-ASCII names as they
// are. A rename or copy entry carries its old path as the next field, skipped here.
export function untrackedOf(porcelainZ: string): string[] {
  const fields = porcelainZ.split('\0')
  const out: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.startsWith('?? ')) out.push(f.slice(3))
    else if (/^[RC]/.test(f)) i++
  }
  return out
}

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
    record: recordOf(root, slug),
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
