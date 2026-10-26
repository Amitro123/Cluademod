// The four kinds of MISTAKES.md entry, as mistake-brain's format spec names them.
export type EntryType = 'mistake' | 'success' | 'decision' | 'handoff'
// One MISTAKES.md entry, from its heading and fields; `at` is the heading's "YYYY-MM-DD HH:MM".
export type Entry = { at: string; title: string; type: EntryType; status: string; route: string }
export type Folder = 'Projects' | 'Areas' | 'Resources' | 'Archives'
// One line of the session journal: a worker's report, a memory entry, a to-do done or a goal step,
// at its clock time; a worker's open questions ride along for the end-of-session handoff.
export type JournalKind = 'worker' | 'memory' | 'todo' | 'goal'
export type JournalEntry = { at: string; kind: JournalKind; text: string; open?: string[] }
// One PARA file: what MEMORY.md says of it, or only that it's on disk (`isIndexed` false).
export type Lesson = { file: string; summary: string; lessons: number; updated: string; isIndexed: boolean }
export type Brain = {
  entries: Entry[]
  folders: Record<Folder, Lesson[]>
  // MEMORY.md counts archives rather than listing them.
  archives: number
  rules: string[]
  lastDream: string | null
  // The MEMORY.md the index was read from, or null when none was found.
  index?: string | null
}
// What just happened to the memory: a new entry of a kind, or a step of the skill's pipeline.
export type PulseKind = EntryType | 'route' | 'promote' | 'dream'
export type Pulse = { kind: PulseKind; title: string; at: number; folder?: Folder; file?: string }
// Work another mod finished, offered to memory: a done follow-up, a reached goal.
export type Offer = { key: string; from: 'followups' | 'goal-run'; title: string; detail: string; types: EntryType[] }

declare module 'claude-code' {
  interface PluginState {
    'brain-hud': {
      brain: Brain | null
      pulse: Pulse | null
      frame: number
      offers: Offer[]
      // Folders opened in the pane.
      open: string[]
      // Whether followups' /followup command is there, for a handoff's "Add to to-do".
      canFollow: boolean
      // Follow-ups started from the to-do list (id → title, bug or not), and the goal being run.
      started: { id: string; title: string; isBug: boolean }[]
      goalText: string
      // Whether the pane already opened by itself this session.
      paneShown: boolean
      // The offer whose other types "…" opened.
      more: string
      // The graph's palette, from the theme in /config.
      theme: 'dark' | 'light'
      // The unrouted count the person said "Later" to: the reminder waits until there are more.
      routeLater: number
      // The session journal (worker reports, memory entries, to-dos done, goal steps), and how
      // many of its entries the main agent was last told of beside a prompt.
      journal: JournalEntry[]
      told: number
      // To-dos finished this session, whether the goal was reached, and whether the end-of-session
      // handoff draft was written: what the draft leaves out.
      doneIds: string[]
      goalReached: boolean
      handedOff: boolean
    }
  }
}
