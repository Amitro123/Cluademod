// Wording one mod writes and another reads: followups' Start prompt and done result, goal-run's
// start prompt, reached-goal toast and result. Edit it here, then run `node tools/sync-texts.mjs`:
// a mod can import nothing outside its own folder, so each one keeps a copy in hooks/texts.ts.

export type StartItem = { id: string; title: string; isBug?: boolean }

// followups: one line per item it hands Claude when the person presses Start.
export const startLine = (i: { id: string; title: string; kind?: string; detail?: string; where?: string }) =>
  `- id ${i.id}: ${i.title}${i.kind === 'bug' ? ' (bug)' : ''}${i.detail ? ` — ${i.detail}` : ''}${i.where ? ` [where: ${i.where}]` : ''}`

export function parseStartPrompt(text: string): StartItem[] {
  const out: StartItem[] = []
  for (const line of text.split('\n')) {
    const m = /^- id (\S+): (.+?)( \(bug\))?(?: — .*?)?(?: \[where: .*\])?$/.exec(line.trim())
    if (m) out.push({ id: m[1]!, title: m[2]!.trim().slice(0, 120), ...(m[3] ? { isBug: true } : {}) })
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
export const planChangesForFactory = (said: string) => `The person wants changes: ${said}\nThe factory's spec-writer revises the spec; don't propose a plan yourself.`
export const PLAN_WAITING_FOR_FACTORY = "The person hasn't answered; the plan waits for approval in the Goal pane, and the factory waits with it."

export function parsePlanOutcome(text: string): { approved: true } | { changes: string } | null {
  if (text.startsWith('Approved.')) return { approved: true }
  const m = /^The person wants changes(?:: ([\s\S]*?)\n| to the plan)/.exec(text)
  return m ? { changes: (m[1] ?? '').trim() } : null
}

