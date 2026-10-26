// The session journal: what happened this session, one line per event, written as it happens and
// with no model involved. Workers' reports (a routed-worker's Findings / Files / Changes /
// Unsure-about), memory entries, finished to-dos and goal progress. The main agent keeps only the
// bottom line of each worker; the journal is where the rest of the session's story stays readable.

import type { JournalEntry, JournalKind } from '../types'

export type { JournalEntry, JournalKind }

export const JOURNAL_DIR = '.claude/brain'
export const journalFile = (sessionId: string) => `${JOURNAL_DIR}/session-${sessionId.replace(/[^\w.-]/g, '_')}.md`

// The newest entries the tool hands back by default, and the cap on what it hands back at all.
export const JOURNAL_LAST = 40
export const JOURNAL_CAP = 12_000

const SECTIONS = ['Findings', 'Files', 'Changes', 'Unsure-about'] as const
type Section = (typeof SECTIONS)[number]

const one = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// A section's heading in any of the forms a report writes it: "## Findings", "**Findings:**",
// "Findings: …", "- **Unsure-about**". A plain word starts one only with its colon, so a finding that
// opens with "Changes to …" stays a finding. "Open questions" is filed under Unsure-about, as the
// worker is told to.
const WORD = '(findings|files|changes|unsure[- ]about|open questions)'
const HEADINGS = [
  new RegExp(`^\\s*#{1,6}\\s*${WORD}\\s*:?\\s*$`, 'i'),
  new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*${WORD}\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, 'i'),
  new RegExp(`^\\s*(?:[-*]\\s+)?${WORD}\\s*:\\s*(.*)$`, 'i'),
]
const heading = (line: string) => HEADINGS.map(r => r.exec(line)).find(Boolean) ?? null

export function reportSections(answer: string): Partial<Record<Section, string[]>> {
  const out: Partial<Record<Section, string[]>> = {}
  let at: Section | null = null
  for (const line of answer.split('\n')) {
    const m = heading(line)
    if (m) {
      const word = m[1]!.toLowerCase()
      at = word.startsWith('unsure') || word.startsWith('open') ? 'Unsure-about' : (SECTIONS.find(s => s.toLowerCase() === word) ?? null)
      if (at) out[at] ??= []
      const rest = one(m[2] ?? '')
      if (at && rest) out[at]!.push(rest)
      continue
    }
    const item = one(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))
    if (at && item) out[at]!.push(item)
  }
  return out
}

const NONE = /^(none|n\/a|nothing|-|—|no changes?\.?|none\.?)$/i
const items = (list: string[] | undefined) => (list ?? []).filter(x => !NONE.test(x))

// One journal line for a worker's report: what it was asked, its first findings, what it changed
// and where; the open questions ride along apart. A report without the sections gives its first line.
export function workerEntry(at: string, task: string, agentType: string, answer: string): JournalEntry | null {
  const text = answer.trim()
  if (!text) return null
  const s = reportSections(text)
  const head = `${agentType ? `${agentType}: ` : ''}${clip(one(task) || 'a task', 80)}`
  const open = items(s['Unsure-about']).map(x => clip(x, 160))
  const findings = items(s.Findings)
  const parts: string[] = []
  if (findings.length) parts.push(clip(findings.slice(0, 2).join('; '), 220))
  else if (!Object.keys(s).length) parts.push(clip(one(text.split('\n').find(l => l.trim()) ?? ''), 220))
  const changes = items(s.Changes)
  if (changes.length) parts.push(`changed: ${clip(changes.join('; '), 160)}`)
  const files = items(s.Files)
  if (files.length) parts.push(`files: ${clip(files.slice(0, 4).join(', '), 140)}${files.length > 4 ? ` +${files.length - 4}` : ''}`)
  if (open.length) parts.push(`open: ${open.length}`)
  return { at, kind: 'worker', text: parts.length ? `${head} — ${parts.join(' · ')}` : head, ...(open.length ? { open } : {}) }
}

const LABEL: Record<JournalKind, string> = { worker: 'worker', memory: 'memory', todo: 'to-do', goal: 'goal' }

export function journalLine(e: JournalEntry): string {
  return `- ${e.at} [${LABEL[e.kind]}] ${e.text}${e.open?.length ? `\n${e.open.map(q => `  - unsure: ${q}`).join('\n')}` : ''}`
}

export function journalText(entries: readonly JournalEntry[], last = JOURNAL_LAST): string {
  if (!entries.length) return 'Nothing in the session journal yet: worker reports, memory entries, finished to-dos and goal progress land here as they happen.'
  const shown = entries.slice(-Math.max(1, last))
  const head = `Session journal: ${countsText(entries)}${shown.length < entries.length ? ` (the last ${shown.length} of ${entries.length})` : ''}.`
  let body = shown.map(journalLine).join('\n')
  if (body.length > JOURNAL_CAP) body = `…\n${body.slice(body.length - JOURNAL_CAP).replace(/^[^\n]*\n/, '')}`
  return `${head}\n${body}`
}

export function journalDoc(sessionId: string, entries: readonly JournalEntry[]): string {
  return [`# Session journal ${sessionId}`, '', 'Written by brain-hud as the session goes: one line per worker report, memory entry, finished to-do and goal step. Local, never committed.', '', ...entries.map(journalLine), ''].join('\n')
}

export function countsText(entries: readonly JournalEntry[]): string {
  const n = (k: JournalKind) => entries.filter(e => e.kind === k).length
  const open = entries.reduce((s, e) => s + (e.open?.length ?? 0), 0)
  const parts = [
    [n('worker'), 'worker report', 'worker reports'],
    [n('memory'), 'memory entry', 'memory entries'],
    [n('todo'), 'to-do done', 'to-dos done'],
    [n('goal'), 'goal step', 'goal steps'],
    [open, 'open question', 'open questions'],
  ] as const
  const said = parts.filter(([c]) => c > 0).map(([c, a, b]) => `${c} ${c === 1 ? a : b}`)
  return said.length ? said.join(', ') : 'nothing yet'
}

// The line the main agent reads beside a prompt, when the journal grew since the last one.
export function contextLine(entries: readonly JournalEntry[], tool: string): string {
  const last = entries[entries.length - 1]
  return `[brain-hud] Session so far: ${countsText(entries)}. Latest: ${clip(last ? last.text : '', 140)}. ${tool} reads the whole journal (what workers found and changed, what was fixed) when you need the detail instead of re-reading files.`
}

// What the session leaves open: the workers' unanswered questions, the to-dos started and not
// done, a goal not reached. Nothing open, no handoff.
export type Loose = { questions: string[]; todos: string[]; goal: string }

export function looseEnds(entries: readonly JournalEntry[], startedTodos: readonly { id: string; title: string }[], doneIds: readonly string[], goal: { text: string; reached: boolean }): Loose {
  return {
    questions: [...new Set(entries.flatMap(e => e.open ?? []))].slice(-8),
    todos: startedTodos.filter(t => !doneIds.includes(t.id)).map(t => t.title),
    goal: goal.text && !goal.reached ? goal.text : '',
  }
}

export const hasLoose = (l: Loose) => Boolean(l.questions.length || l.todos.length || l.goal)

export const HANDOFF_TITLE = 'Session handoff (auto-draft)'

// A handoff entry in the skill's format, for MISTAKES.md: a draft the next session's route files.
export function handoffEntry(stamp: string, entries: readonly JournalEntry[], loose: Loose, journalPath: string): string {
  const what = [`Session ended with ${countsText(entries)}.`, loose.goal ? `Goal not reached: ${clip(loose.goal, 160)}.` : ''].filter(Boolean).join(' ')
  const context = [
    entries.filter(e => e.kind !== 'goal').slice(-3).map(e => clip(e.text, 160)).join(' | '),
    `Full session journal: ${journalPath}.`,
  ].filter(Boolean).join(' ')
  const next = [
    ...loose.todos.map(t => `finish the to-do "${clip(t, 100)}"`),
    ...loose.questions.map(q => `answer: ${clip(q, 140)}`),
    ...(loose.goal ? ['carry on with the goal'] : []),
  ].slice(0, 8)
  return [
    `## [${stamp}] ${HANDOFF_TITLE}`,
    '- **Type:** handoff',
    `- **What happened:** ${what}`,
    `- **Context needed:** ${context}`,
    `- **Next steps:** ${next.join('; ')}.`,
    '- **PARA route:** unrouted',
    '- **Status:** unrouted',
    '',
  ].join('\n')
}

export const MARKER = '<!-- mistake-brain: new entries are inserted immediately below this line -->'

// The entry just below the marker, as the skill inserts it; null where the file has no marker.
export function insertBelowMarker(text: string, entry: string): string | null {
  const at = text.indexOf(MARKER)
  if (at < 0) return null
  const end = at + MARKER.length
  const rest = text.slice(end).replace(/^\s*\n/, '')
  return `${text.slice(0, end)}\n\n${entry.trimEnd()}\n\n${rest}`
}

const pad = (n: number) => String(n).padStart(2, '0')
export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const stampOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}`
}
