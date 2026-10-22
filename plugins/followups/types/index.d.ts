export type Flag = { id: string; title: string; detail: string; where: string; at: number }
export type Item = Flag & { isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    followups: {
      // What Claude flagged and the person hasn't answered yet.
      pending: Flag[]
      // What the person chose to keep.
      items: Item[]
      // The last export's outcome, shown under the buttons.
      exported: string
    }
  }
}
