// Reading the memory mistake-brain keeps: MISTAKES.md (the inbox) and the shared MEMORY.md index of
// the PARA folders. Pure functions over text, so the hooks module only fetches files.

import type { Brain, Entry, EntryType, Folder, Lesson, Pulse } from '../types'

export const FOLDERS: Folder[] = ['Projects', 'Areas', 'Resources', 'Archives']
const TYPES: EntryType[] = ['mistake', 'success', 'decision', 'handoff']

const HEADING = /^## \[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\]\s+(.+)$/
const FIELD = /^- \*\*(Type|Status|PARA route):\*\*\s*(.*)$/

// Every entry, in file order (newest first, as the skill writes them). An entry without a Type is
// an older one: a mistake, per the format spec.
export function parseMistakes(text: string): Entry[] {
  const out: Entry[] = []
  let cur: Entry | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = HEADING.exec(line)
    if (head) {
      cur = { at: head[1]!, title: head[2]!.trim(), type: 'mistake', status: 'unrouted', route: '' }
      out.push(cur)
      continue
    }
    const field = cur && FIELD.exec(line)
    if (!cur || !field) continue
    const value = field[2]!.trim()
    if (field[1] === 'Type') {
      const t = value.toLowerCase() as EntryType
      if (TYPES.includes(t)) cur.type = t
    } else if (field[1] === 'Status') cur.status = value.toLowerCase()
    else cur.route = value
  }
  return out
}

const empty = (): Record<Folder, Lesson[]> => ({ Projects: [], Areas: [], Resources: [], Archives: [] })

// MEMORY.md: `- [Project] Projects/x.md — summary (N lessons, last updated YYYY-MM-DD)` per file
// under its folder's heading, an archive count, the promoted rules, and the last dream's date.
export function parseMemory(text: string): Omit<Brain, 'entries'> {
  const folders = empty()
  const rules: string[] = []
  let archives = 0
  let lastDream: string | null = null
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^## (.+)$/.exec(line)
    if (head) {
      section = head[1]!.trim()
      continue
    }
    const count = /^Archives:\s*(\d+)\s+files?/i.exec(line)
    if (count) archives = Number(count[1])
    if (FOLDERS.includes(section as Folder)) {
      const m = /^- \[[^\]]+\]\s+(\S+)\s+[—–-]\s+(.*)$/.exec(line)
      if (!m) continue
      const tail = /\s*\((\d+) lessons?(?:,\s*last updated (\d{4}-\d{2}-\d{2}))?\)\s*$/.exec(m[2]!)
      folders[section as Folder].push({
        file: m[1]!.replace(/^.*\//, ''),
        summary: (tail ? m[2]!.slice(0, tail.index) : m[2]!).trim(),
        lessons: tail ? Number(tail[1]) : 0,
        updated: tail?.[2] ?? '',
        isIndexed: true,
      })
    } else if (/^Rules promoted/i.test(section)) {
      if (/^- /.test(line) && !/^- _\(/.test(line)) rules.push(line.slice(2).trim())
    } else if (/^Last dream/i.test(section) && !lastDream) {
      lastDream = /\*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(line)?.[1] ?? null
    }
  }
  return { folders, archives, rules, lastDream }
}

// What a PARA file itself says: one lesson per `## [YYYY-MM-DD] title` heading, the newest date
// among those and its `- Added:` lines, and the first paragraph under the title as a summary.
export type ParaFile = { file: string; lessons: number; updated: string; summary: string }
export function paraStats(file: string, text: string): ParaFile {
  let lessons = 0
  let updated = ''
  let summary = ''
  let isTitle = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^## \[(\d{4}-\d{2}-\d{2})/.exec(line)
    const added = /^- Added:\s*(\d{4}-\d{2}-\d{2})/.exec(line)
    if (head) lessons++
    for (const d of [head?.[1], added?.[1]]) if (d && d > updated) updated = d
    if (/^# /.test(line)) isTitle = true
    else if (isTitle && !summary && line && !line.startsWith('#')) summary = line
    if (/^## /.test(line)) isTitle = false
  }
  return { file, lessons, updated, summary }
}

// The index joined with what is on disk. A file's lessons and date are counted from the file (the
// index's own numbers can be missing or stale); its summary is the index's, else the file's. A
// PARA file the index doesn't name still shows, marked.
export function withListing(folders: Record<Folder, Lesson[]>, onDisk: Partial<Record<Folder, (string | ParaFile)[]>>): Record<Folder, Lesson[]> {
  const out = empty()
  for (const f of FOLDERS) {
    const disk = new Map((onDisk[f] ?? []).map(d => (typeof d === 'string' ? { file: d, lessons: -1, updated: '', summary: '' } : d)).map(d => [d.file, d]))
    const counted = (l: Lesson): Lesson => {
      const d = disk.get(l.file)
      return d && d.lessons >= 0 ? { ...l, lessons: d.lessons, updated: d.updated || l.updated, summary: l.summary || d.summary } : l
    }
    const named = new Set(folders[f].map(l => l.file))
    const extra = [...disk.values()]
      .filter(d => !named.has(d.file))
      .map(d => ({ file: d.file, summary: d.summary, lessons: Math.max(0, d.lessons), updated: d.updated, isIndexed: false }))
    out[f] = [...folders[f].map(counted), ...extra]
  }
  return out
}

export const lessonCount = (b: Brain) => FOLDERS.reduce((n, f) => n + b.folders[f].reduce((k, l) => k + l.lessons, 0), 0)
export const unrouted = (b: Brain) => b.entries.filter(e => e.status === 'unrouted').length

// An entry's identity: its time and type, numbered when several share them. Not its title, so
// rewording an entry doesn't read as a new one.
function keysOf(entries: Entry[]): string[] {
  const seen = new Map<string, number>()
  return entries.map(e => {
    const k = `${e.at} ${e.type}`
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return `${k} #${n}`
  })
}

// What changed between two readings, as the one thing worth showing: a new entry first, then a
// dream, a promoted rule, or a lesson routed into a folder.
export function diffBrain(a: Brain | null, b: Brain): Omit<Pulse, 'at'> | null {
  if (!a) return null
  // Entries are newest first, so the numbering runs from the oldest to stay put as new ones arrive.
  const ka = keysOf([...a.entries].reverse()).reverse()
  const kb = keysOf([...b.entries].reverse()).reverse()
  const known = new Set(ka)
  const fresh = b.entries.find((_, i) => !known.has(kb[i]!))
  if (fresh) return { kind: fresh.type, title: fresh.title }
  if (b.lastDream && b.lastDream !== a.lastDream) return { kind: 'dream', title: `the memory was reorganized (${b.lastDream})` }
  const rule = b.rules.find(r => !a.rules.includes(r))
  if (rule) return { kind: 'promote', title: rule }
  for (const folder of FOLDERS) {
    const before = new Map(a.folders[folder].map(l => [l.file, l.lessons]))
    const grown = b.folders[folder].find(l => !before.has(l.file) || l.lessons > before.get(l.file)!)
    if (grown) return { kind: 'route', title: grown.file, folder, file: grown.file }
  }
  const was = new Map(a.entries.map((e, i) => [ka[i]!, e.status]))
  const routed = b.entries.find((e, i) => e.status !== 'unrouted' && was.get(kb[i]!) === 'unrouted')
  if (routed) return { kind: 'route', title: routed.title }
  return null
}


// What the person is asked to have Claude log: through the skill, so the entry keeps its format.
export function logPrompt(type: EntryType, title: string, detail: string): string {
  return [
    `Log this to MISTAKES.md with /mistake-brain log, as Type: ${type}.`,
    `- ${title}`,
    ...(detail ? [`- ${detail}`] : []),
    'Fill the fields for that type from what happened in this session; keep it short.',
  ].join('\n')
}
