export type TaskStatus = 'pending' | 'in_progress' | 'done'
export type Task = {
  id: string
  title: string
  status: TaskStatus
  tokens: number
  // Set for a task that came from a followups to-do item: that item's id, so its "done" carries over.
  followupId?: string
}
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
  // Tokens spent on work started from the to-do list and kept apart from the goal.
  outside?: number
}

// Work started from the followups to-do list (its Start button) while a goal is open: counted apart,
// and offered to the goal as tasks until the person answers.
export type Side = {
  items: { id: string; title: string }[]
  tokens: number
  // Unanswered: the band asks whether to add the items to the goal.
  isAsking: boolean
  // Once added to the goal: the task ids the items became, which their tokens go to from then on.
  taskIds: string[]
  // The to-do items followups already marked done, so a late "add" brings them in as done.
  doneIds: string[]
  // Its turn's work is still the side job's: false once the person sends a prompt of their own.
  isLive: boolean
}
// What the band above the prompt asks: for a new goal, or whether to go on with an unfinished one.
export type Asking = 'new' | 'resume' | null

declare module 'claude-code' {
  interface PluginState {
    'goal-run': {
      goal: Goal | null
      asking: Asking
      side: Side | null
      tick: number
    }
  }
}
