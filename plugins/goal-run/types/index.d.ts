export type TaskStatus = 'pending' | 'in_progress' | 'done'
export type Task = { id: string; title: string; status: TaskStatus; tokens: number }
// planning: Claude is writing the plan; proposed: it waits for the person; active: being worked; done: reached.
export type GoalStatus = 'planning' | 'proposed' | 'active' | 'done'
export type Goal = {
  text: string
  status: GoalStatus
  tasks: Task[]
  // The task tokens are counted against: the last one started and not yet done.
  activeId: string | null
  // Tokens spent while no task was in progress: planning, and work between tasks.
  other: number
}
// What the band above the prompt asks: for a new goal, or whether to go on with an unfinished one.
export type Asking = 'new' | 'resume' | null

declare module 'claude-code' {
  interface PluginState {
    'goal-run': {
      goal: Goal | null
      asking: Asking
      tick: number
    }
  }
}
