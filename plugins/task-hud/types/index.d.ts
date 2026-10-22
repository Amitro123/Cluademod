export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type Todo = { id: string; subject: string; activeForm: string; status: TodoStatus }
export type AgentState = 'running' | 'done' | 'failed'
// One line of what an agent did: "Reading notes.md" while it runs, "Read notes.md" after.
export type Activity = { now: string; past: string }
export type Agent = {
  id: string
  description: string
  type: string
  model: string
  // Which creature (color) it is drawn as: the order it was spawned in.
  slot: number
  startedAt: number
  endedAt: number | null
  state: AgentState
  steps: number
  tokens: number
  activity: Activity[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-hud': {
      todos: Todo[]
      title: string
      agents: Agent[]
      tick: number
    }
  }
}
