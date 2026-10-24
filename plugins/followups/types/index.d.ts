export type Status = 'open' | 'in_progress' | 'done'
export type Kind = 'bug' | 'task'
export type Flag = { id: string; title: string; detail: string; where: string; at: number; kind?: Kind }
export type Item = Flag & { status: Status }

declare module 'claude-code' {
  interface PluginState {
    followups: {
      // What Claude flagged and the person hasn't answered yet.
      pending: Flag[]
      // What the person chose to keep.
      items: Item[]
      // The last export's outcome, shown under the buttons.
      exported: string
      // Titles (normalised) the person said aren't needed, so they aren't suggested again.
      skipped: string[]
      // The list as this session last loaded or saved it, to merge with another session's saves.
      base: Item[]
    }
  }
}
