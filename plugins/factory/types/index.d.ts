// A step's state, as the pane draws it.
export type StepState = 'wait' | 'run' | 'pass' | 'changes' | 'fail' | 'skip'
export type Role = 'spec' | 'builder' | 'security' | 'code' | 'approver'
export type Reviewer = 'security' | 'code'
export type Severity = 'blocker' | 'major' | 'minor'
export type Finding = { severity: Severity; where: string; text: string }
// A task of the spec's breakdown: what goes to goal-run's plan.
export type SpecTask = { title: string; priority: 'high' | 'medium' | 'low'; dependsOn: number[] }
export type Check = { cmd: string; ok: boolean; tail: string }
export type Review = { role: Reviewer; state: StepState; findings: Finding[]; tokens: number; round: number }
// Where the run is: each phase waits on one thing (an agent, the checks, the person).
export type Phase = 'spec' | 'plan' | 'build' | 'checks' | 'review' | 'approve' | 'needs-human' | 'done' | 'stopped'

export type Run = {
  feature: string
  slug: string
  phase: Phase
  // Review rounds so far (builder rounds follow them), and builder passes for red checks.
  round: number
  checkRound: number
  startedAt: number
  // The git branch and worktree the run builds in, and the commit it started from.
  base: string
  branch: string
  worktree: string
  specFile: string
  tasks: SpecTask[]
  steps: Record<'spec' | 'builder' | 'checks' | 'approver', { state: StepState; tokens: number }>
  checks: Check[]
  reviews: Review[]
  // The agents this run spawned, by agentId: the role each one plays.
  agents: Record<string, Role>
  // What the person or the approver said last: the reason a run waits on them.
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    factory: {
      run: Run | null
      frame: number
      theme: 'dark' | 'light'
    }
  }
}
