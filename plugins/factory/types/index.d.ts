// A step's state, as the pane draws it.
export type StepState = 'wait' | 'run' | 'pass' | 'changes' | 'fail' | 'skip'
export type Role = 'spec' | 'builder' | 'security' | 'code' | 'approver'
// How big the spec-writer judged the feature: what the models of the later roles follow.
export type Size = 'small' | 'medium' | 'large'
export type Reviewer = 'security' | 'code'
export type Severity = 'blocker' | 'major' | 'minor'
export type Finding = { severity: Severity; where: string; text: string }
// A task of the spec's breakdown: what goes to goal-run's plan.
export type SpecTask = { title: string; priority: 'high' | 'medium' | 'low'; dependsOn: number[] }
// isMissing: the command couldn't start here (its program isn't installed): skipped, not failed, so the
// builder isn't sent to fix what it can't.
export type Check = { cmd: string; ok: boolean; tail: string; isMissing?: boolean }
// agentId: the reviewer's agent this round (null until started), so a late answer from an earlier one is ignored.
export type Review = { role: Reviewer; state: StepState; findings: Finding[]; tokens: number; round: number; agentId: string | null }
// Where the run is: each phase waits on one thing (an agent, the checks, the person).
// 'ready': the approver said APPROVE; the PR waits for the person's Open PR.
export type Phase = 'spec' | 'plan' | 'build' | 'checks' | 'review' | 'approve' | 'ready' | 'needs-human' | 'done' | 'stopped'
// Why a run is at needs-human: what stopped it decides what the person can do (Approve only after an
// ESCALATE; Retry for the rest).
export type Blocked =
  | { on: 'escalate' }
  | { on: 'spec' }
  // why: the builder stopped mid-job (not just failed to commit): Retry sends it on.
  | { on: 'builder'; why?: string }
  | { on: 'checks' }
  | { on: 'setup' }
  | { on: 'start'; role: Role }

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
  // The tasks as goal-run numbered them (by priority and dependencies), once it approved the plan:
  // the ids the builder marks.
  goalTasks?: { id: string; title: string }[]
  // The spec-writer's judgment of the feature, and the model each role runs on in this run.
  size?: Size
  models?: Partial<Record<Role, string>>
  // The builder that built this run: each later round goes back to it (it keeps what it read and
  // why), until it fails and a fresh one is started.
  builderId?: string
  // The commands the factory found in the project (no checks or setup option) that the person let
  // run, with the last commit of the files that define them: a change there asks again.
  autoApproved?: string
  // Where the run keeps what each step said (its record), and how many entries it has written.
  record?: string
  recorded?: number
  // What the builder says it changed (its closing summary), and git's count of the change.
  summary?: string
  stat?: string
  steps: Record<'spec' | 'builder' | 'checks' | 'approver', { state: StepState; tokens: number }>
  checks: Check[]
  // Why no check ran, or what detection warned about: what the reviewers and the approver are told.
  checksNote?: string
  reviews: Review[]
  // The agents this run spawned, by agentId: the role each one plays.
  agents: Record<string, Role>
  // What the person or the approver said last: the reason a run waits on them.
  note: string
  blocked: Blocked | null
  // Who approves the plan: goal-run's dialog, or the factory's own band (no goal-run, or the person
  // has a goal of their own).
  gate: 'goal-run' | 'factory'
  // The dependencies were installed in the worktree (the setup command ran).
  setupDone: boolean
  // New files the factory left out of its commits: dependencies, build output, credentials.
  skipped?: string[]
  // The followups to-do item the run came from: marked done once the PR is open.
  followupId?: string
}

declare module 'claude-code' {
  interface PluginState {
    factory: {
      run: Run | null
      frame: number
      theme: 'dark' | 'light'
      stoppedAgents: string[]
    }
  }
}
