// GENERATED from shared/texts.ts by tools/sync-texts.mjs: edit that file, not this one.
// Wording one mod writes and another reads: followups' Start prompt and done result, goal-run's
// start prompt, reached-goal toast and result. Edit it here, then run `node tools/sync-texts.mjs`:
// a mod can import nothing outside its own folder, so each one keeps a copy in hooks/texts.ts.

export type StartItem = { id: string; title: string; isBug?: boolean; detail?: string; where?: string }

// followups: one line per item it hands Claude when the person presses Start.
// The title is JSON-quoted, so one holding " — ", " (bug)" or "[where:" reads back whole.
export const startLine = (i: { id: string; title: string; kind?: string; detail?: string; where?: string }) =>
  `- id ${i.id}: ${JSON.stringify(i.title)}${i.kind === 'bug' ? ' (bug)' : ''}${i.detail ? ` — ${i.detail}` : ''}${i.where ? ` [where: ${i.where}]` : ''}`

export function parseStartPrompt(text: string): StartItem[] {
  const out: StartItem[] = []
  for (const line of text.split('\n')) {
    // A quoted title; else the unquoted one a start prompt from before had.
    const m = /^- id (\S+): ("(?:[^"\\]|\\.)*")( \(bug\))?(?: — (.*?))?(?: \[where: (.*)\])?$/.exec(line.trim()) ?? /^- id (\S+): (.+?)( \(bug\))?(?: — (.*?))?(?: \[where: (.*)\])?$/.exec(line.trim())
    if (!m) continue
    let title = m[2]!
    if (title.startsWith('"')) {
      try {
        title = String(JSON.parse(title))
      } catch {
        continue
      }
    }
    out.push({ id: m[1]!, title: title.trim().slice(0, 120), ...(m[3] ? { isBug: true } : {}), ...(m[4] ? { detail: m[4] } : {}), ...(m[5] ? { where: m[5] } : {}) })
  }
  return out
}

// A tool's answer as text, however it arrives: a string, MCP content blocks, or `{ content }`
// (what a classic PostToolUse hook gets as tool_response).
export function toolText(response: unknown): string {
  if (typeof response === 'string') return response
  const blocks = Array.isArray(response) ? response : (response as { content?: unknown } | null)?.content
  if (Array.isArray(blocks)) return blocks.map(b => String((b as { text?: unknown })?.text ?? '')).join('\n')
  return response == null ? '' : JSON.stringify(response)
}

// followups: what its done tool answers.
export const doneResult = (title: string, note: string) => `Marked "${title}" done${note ? ` (${note})` : ''}.`

export function parseDoneResult(text: string): { title: string; note: string } | null {
  const m = /^Marked "(.+)" done(?: \((.*)\))?\.$/.exec(text)
  return m ? { title: m[1]!, note: m[2] ?? '' } : null
}

// goal-run: the prompt that hands Claude the goal, the toast when it is reached (on every path), and
// the update tool's words for it.
export const goalPrompt = (text: string) => `My goal for this session: ${text}`
export const parseGoalPrompt = (text: string) => /^My goal for this session: (.+)$/m.exec(text)?.[1]?.trim() ?? null
export const goalReachedToast = (text: string) => `Goal reached: ${text}`
export const GOAL_REACHED = 'The goal is reached.'
// goal-run: the note it adds to followups' done result when that to-do item closed the goal's last task.
export const goalClosedNote = (text: string) => `That closed the last task of the session goal "${text}". ${GOAL_REACHED}`
export const parseGoalClosedNote = (text: string) => /^That closed the last task of the session goal "(.+)"\. /.exec(text)?.[1] ?? null

// goal-run ↔ factory: a plan the factory's spec-writer wrote is submitted with source "factory".
// goal-run then lets the factory's builder do the work, and answers the plan tool in these words;
// the factory reads them to go on to the build or back to the spec. A plan approved later in the
// Goal pane is passed on with the command /factory plan-approved.
export const FACTORY_SOURCE = 'factory' as const
export const FACTORY_PLAN_APPROVED_ARG = 'plan-approved'
export const PLAN_APPROVED_FOR_FACTORY = "Approved. The factory's builder does the work: don't start the tasks yourself, and don't propose another plan."
// goal-run orders a plan by priority and dependencies and numbers it in that order, so the builder
// marks tasks by the ids goal-run gave them, carried in the approval (the tool's answer, or the
// arguments of /factory plan-approved).
export type GoalTask = { id: string; title: string }
export const planApprovedForFactory = (tasks: GoalTask[]) => `${PLAN_APPROVED_FOR_FACTORY}\nGoal tasks: ${JSON.stringify(tasks)}`
export const factoryPlanApprovedArgs = (tasks: GoalTask[]) => `${FACTORY_PLAN_APPROVED_ARG} ${JSON.stringify(tasks)}`
function goalTasksIn(json: string): GoalTask[] | undefined {
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v)) return undefined
    const tasks = v.filter((t): t is GoalTask => !!t && typeof t.id === 'string' && typeof t.title === 'string').map(t => ({ id: t.id, title: t.title }))
    return tasks.length ? tasks : undefined
  } catch {
    return undefined
  }
}
// /factory's arguments when goal-run passes on a plan approved in its pane: null for other arguments.
export function parsePlanApprovedArgs(args: string): { goalTasks?: GoalTask[] } | null {
  const m = new RegExp(`^${FACTORY_PLAN_APPROVED_ARG}(?:\\s+([\\s\\S]*))?$`).exec(args.trim())
  if (!m) return null
  const goalTasks = m[1] ? goalTasksIn(m[1]) : undefined
  return goalTasks ? { goalTasks } : {}
}
export const planChangesForFactory = (said: string) => `The person wants changes: ${said}\nThe factory's spec-writer revises the spec; don't propose a plan yourself.`
export const PLAN_WAITING_FOR_FACTORY = "The person hasn't answered; the plan waits for approval in the Goal pane, and the factory waits with it."
// goal-run's answer to a plan when the person chose "Run as factory" in its dialog: Claude starts the
// run with the factory's tool instead of working the plan.
export const FACTORY_START_TOOL = 'mcp__factory__start'
export const factoryChosenForGoal = (goal: string) =>
  `The person chose to run this goal through the factory. Call ${FACTORY_START_TOOL} now with feature ${JSON.stringify(goal)} (add where its details are, a file or issue, if the conversation names one). Its spec-writer writes the spec and its plan comes up for the person's approval; don't plan or start the work yourself.`
// The person has a goal of their own: goal-run keeps it, and the factory asks for approval itself.
export const PLAN_KEPT_FOR_FACTORY = "The person has a session goal of their own, so the factory's plan is not set as the goal. The factory asks the person to approve it in its own band; don't propose a plan or start the tasks."

// Only the factory's own wording counts: a regular plan's "Approved. …" or "The person wants changes
// to the plan" is the main loop's, not the factory's.
export function parsePlanOutcome(text: string): { approved: true; goalTasks?: GoalTask[] } | { changes: string } | { kept: true } | null {
  if (text.startsWith(PLAN_APPROVED_FOR_FACTORY)) {
    const goalTasks = goalTasksIn(/^Goal tasks: (.+)$/m.exec(text)?.[1] ?? '')
    return goalTasks ? { approved: true, goalTasks } : { approved: true }
  }
  if (text.startsWith(PLAN_KEPT_FOR_FACTORY)) return { kept: true }
  const m = /^The person wants changes: ([\s\S]*?)\nThe factory's spec-writer revises the spec/.exec(text)
  return m ? { changes: m[1]!.trim() } : null
}

// followups → factory: a to-do item run through the factory carries its id in /factory's arguments,
// so the run's PR prompt has Claude mark it done with followups' done tool.
export const factoryArgs = (feature: string, followupId?: string) => (followupId ? `${feature} [followup:${followupId}]` : feature)
export function parseFactoryArgs(args: string): { feature: string; followupId?: string } {
  const m = /^([\s\S]*?)\s*\[followup:([\w-]+)\]\s*$/.exec(args)
  return m ? { feature: m[1]!.trim(), followupId: m[2]! } : { feature: args.trim() }
}

// What a project's saved goal and to-do list are keyed by: the main repository, the same for each of
// its git worktrees (a session in a worktree has a root of its own), else the session's root.
// `git` answers `--git-common-dir` relative to the root in the main checkout, absolute in a worktree.
// From a subfolder git answers `../.git`, so `.` and `..` are resolved (older gits lack
// --path-format=absolute). The result keeps the root's separator.
export function projectFrom(root: string, commonDir: string): string {
  const r = root.replace(/[\\/]+$/, '')
  const dir = commonDir.trim()
  if (!dir) return r
  const sep = r.includes('\\') ? '\\' : '/'
  const abs = /^([a-zA-Z]:)?[\\/]/.test(dir) ? dir : `${r}${sep}${dir}`
  const lead = /^([a-zA-Z]:)?[\\/]/.exec(abs)?.[0] ?? ''
  const parts: string[] = []
  for (const part of abs.slice(lead.length).split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  if (parts.at(-1) === '.git') parts.pop()
  return lead.replace(/[\\/]$/, sep) + parts.join(sep)
}
