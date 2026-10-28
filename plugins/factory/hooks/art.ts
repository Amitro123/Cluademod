// The factory's pipeline, drawn from a run: an SVG diagram for the desktop pane, and the same
// steps as text lines for the terminal.

import type { Run, StepState } from '../types'
import { modelOf, ROLES, tok } from './flow'

const COLOR: Record<StepState, string> = { pass: '#16a34a', changes: '#d97706', run: '#2563eb', wait: '#94a3b8', skip: '#cbd5e1', fail: '#dc2626' }
const MARK: Record<StepState, string> = { pass: '✓', changes: '!', run: '◐', wait: '◌', skip: '–', fail: '✕' }
const PALETTE = {
  dark: { bg: '#0b0e14', card: '#111827', line: '#334155', text: '#e2e8f0', dim: '#94a3b8' },
  light: { bg: '#fbfaf7', card: '#ffffff', line: '#cbd5e1', text: '#1e293b', dim: '#64748b' },
}
export type Theme = keyof typeof PALETTE

export const DIAGRAM = { width: 600, height: 556 }

// The builder's round: the review round it builds for (a build before any review is round 1).
export const buildRound = (run: Run) => (run.phase === 'build' || run.phase === 'checks' ? run.round + 1 : Math.max(1, run.round))

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// One step's state, read off the run (the plan gate and the outcomes have no step of their own).
export function states(run: Run) {
  // Approved once the builder has been started; a run stopped before that never had its plan approved.
  const planState: StepState = run.phase === 'plan' ? 'run' : run.steps.builder.state !== 'wait' ? 'pass' : 'wait'
  const reviewing = run.reviews.filter(r => r.round === run.round && r.round > 0)
  const inCount = reviewing.filter(r => r.state === 'pass' || r.state === 'changes' || r.state === 'fail').length
  const waitState: StepState = !reviewing.length ? 'wait' : inCount < reviewing.length ? 'run' : reviewing.some(r => r.state !== 'pass') ? 'changes' : 'pass'
  const opened = run.phase === 'done' && run.steps.approver.state === 'pass'
  return {
    planState,
    waitState,
    inCount,
    outOf: reviewing.length,
    // Ready: approved, the PR waits for the person's press.
    pr: (opened ? 'pass' : run.phase === 'ready' ? 'run' : 'wait') as StepState,
    human: (run.phase === 'needs-human' ? 'changes' : 'wait') as StepState,
  }
}

const checksLine = (run: Run) =>
  run.checks.length ? run.checks.map(c => `${c.cmd.split(' ').slice(-1)[0]} ${c.isMissing ? '–' : c.ok ? '✓' : '✗'}`).join(' · ') : run.steps.checks.state === 'skip' ? 'none ran' : ''

export function diagramSvg(run: Run, frame: number, theme: Theme = 'light'): string {
  const P = PALETTE[theme]
  const { width: W, height: H } = DIAGRAM
  const cx = W / 2
  const st = states(run)
  let s = ''
  const box = (x: number, y: number, w: number, h: number, title: string, model: string, state: StepState, meta = '') => {
    const col = COLOR[state]
    let b = ''
    if (state === 'run') b += `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="12" fill="${col}" fill-opacity="${frame % 2 ? 0.16 : 0.08}"/>`
    const dash = state === 'wait' || state === 'skip' ? ' stroke-dasharray="4 3"' : ''
    b += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${P.card}" stroke="${col}" stroke-width="${state === 'skip' ? 1.2 : 2}"${dash}/>`
    b += `<circle cx="${x + 16}" cy="${y + 17}" r="8" fill="${col}"/><text x="${x + 16}" y="${y + 21}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${MARK[state]}</text>`
    b += `<text x="${x + 30}" y="${y + 21}" font-size="12.5" font-weight="700" fill="${P.text}">${esc(title)}</text>`
    if (model) b += `<text x="${x + w - 10}" y="${y + 21}" font-size="10" fill="${P.dim}" text-anchor="end">${model}</text>`
    if (meta) b += `<text x="${x + 12}" y="${y + h - 9}" font-size="10" fill="${P.dim}">${esc(short(meta, Math.floor(w / 5.6)))}</text>`
    return b
  }
  const arrow = (y1: number, y2: number, x = cx, dashed = false) =>
    `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 6}" stroke="${P.line}" stroke-width="1.6"${dashed ? ' stroke-dasharray="4 3"' : ''}/><path d="M${x - 4} ${y2 - 7}l4 7 4-7z" fill="${P.line}"/>`

  const bw = 230
  const bx = cx - bw / 2
  s += box(bx, 10, bw, 44, ROLES.spec.label, modelOf(run, 'spec'), run.steps.spec.state, run.steps.spec.tokens ? `${tok(run.steps.spec.tokens)} tokens · ${run.tasks.length} tasks${run.size ? ` · ${run.size}` : ''}` : 'writing the spec')
  s += arrow(54, 72)
  s += box(bx, 72, bw, 44, 'plan approval', 'you', st.planState, st.planState === 'run' ? 'waiting for you (Goal pane or here)' : '')
  s += arrow(116, 130)
  s += box(bx, 130, bw, 44, buildRound(run) > 1 ? `builder · round ${buildRound(run)}` : 'builder', modelOf(run, 'builder'), run.steps.builder.state, run.steps.builder.tokens ? `${tok(run.steps.builder.tokens)} tokens` : '')
  s += arrow(174, 192)
  s += box(bx, 192, bw, 44, run.checkRound > 1 ? `checks · pass ${run.checkRound}` : 'checks', 'no model', run.steps.checks.state, checksLine(run))

  // The reviewers, side by side, all waited for.
  const rw = 180
  const gap = 20
  const n = run.reviews.length
  const x0 = cx - (n * rw + (n - 1) * gap) / 2
  s += `<line x1="${cx}" y1="236" x2="${cx}" y2="256" stroke="${P.line}" stroke-width="1.6"/>`
  s += `<line x1="${x0 + rw / 2}" y1="256" x2="${x0 + (n - 1) * (rw + gap) + rw / 2}" y2="256" stroke="${P.line}" stroke-width="1.6"/>`
  run.reviews.forEach((r, i) => {
    const x = x0 + i * (rw + gap)
    s += arrow(256, 272, x + rw / 2)
    const meta = r.state === 'pass' ? `PASS${r.tokens ? ` · ${tok(r.tokens)}` : ''}` : r.state === 'changes' ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${r.tokens ? ` · ${tok(r.tokens)}` : ''}` : r.state === 'run' ? 'reviewing' : ''
    s += box(x, 272, rw, 48, ROLES[r.role].label, modelOf(run, r.role), r.state, meta)
    s += `<line x1="${x + rw / 2}" y1="320" x2="${x + rw / 2}" y2="338" stroke="${P.line}" stroke-width="1.6"/>`
  })
  s += `<line x1="${x0 + rw / 2}" y1="338" x2="${x0 + (n - 1) * (rw + gap) + rw / 2}" y2="338" stroke="${P.line}" stroke-width="1.6"/>`
  s += `<text x="${x0}" y="266" font-size="9.5" fill="${P.dim}">reviewers${run.round ? ` · round ${run.round}` : ''}</text>`
  s += arrow(338, 356)
  const wcol = COLOR[st.waitState]
  s += `<rect x="${bx}" y="356" width="${bw}" height="40" rx="9" fill="${P.card}" stroke="${wcol}" stroke-width="2"${st.waitState === 'wait' ? ' stroke-dasharray="4 3"' : ''}/>`
  s += `<text x="${cx}" y="374" font-size="12" font-weight="700" fill="${P.text}" text-anchor="middle">wait for all${st.outOf ? ` · ${st.inCount} of ${st.outOf} in` : ''}</text>`
  if (st.waitState === 'changes') s += `<text x="${cx}" y="388" font-size="10" fill="${wcol}" text-anchor="middle">${run.reviews.filter(r => r.round === run.round && r.state === 'changes').length} asked for changes</text>`
  // The loop back to the builder, while rounds are left.
  s += `<path d="M${bx + bw} 376 H${W - 14} V152 H${bx + bw + 6}" fill="none" stroke="${st.waitState === 'changes' ? COLOR.changes : P.line}" stroke-width="1.6" stroke-dasharray="5 4"/>`
  s += `<path d="M${bx + bw + 8} 148l-8 4 8 4z" fill="${st.waitState === 'changes' ? COLOR.changes : P.line}"/>`
  s += `<text x="${W - 20}" y="300" font-size="10" fill="${P.dim}" transform="rotate(-90 ${W - 20} 300)">changes: builder again</text>`
  s += arrow(396, 414, cx, true)
  s += box(bx, 414, bw, 44, ROLES.approver.label, modelOf(run, 'approver'), run.steps.approver.state, run.blocked?.on === 'escalate' || run.phase === 'ready' || run.phase === 'done' ? run.note : '')
  s += `<line x1="${cx - 70}" y1="458" x2="${cx - 70}" y2="486" stroke="${P.line}" stroke-dasharray="4 3"/><line x1="${cx + 70}" y1="458" x2="${cx + 70}" y2="486" stroke="${P.line}" stroke-dasharray="4 3"/>`
  s += `<text x="${cx - 118}" y="480" font-size="9.5" fill="${P.dim}" text-anchor="middle">APPROVE</text><text x="${cx + 118}" y="480" font-size="9.5" fill="${P.dim}" text-anchor="middle">ESCALATE</text>`
  s += box(cx - 190, 486, 160, 40, 'open PR', '', st.pr)
  s += box(cx + 30, 486, 160, 40, 'needs-human', '', st.human)
  s += `<text x="${cx}" y="546" font-size="10" fill="${P.dim}" text-anchor="middle">${esc(short(`branch ${run.branch} · ${run.worktree.split(/[\\/]/).slice(-2).join('/')}`, 96))}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="10" fill="${P.bg}"/>${s}</svg>`
}

// The terminal's pipeline: one line a step.
export function pipelineLines(run: Run): string[] {
  const st = states(run)
  const line = (state: StepState, label: string, extra = '') => `${MARK[state]} ${label}${extra ? ` · ${extra}` : ''}`
  return [
    line(run.steps.spec.state, `spec-writer (${modelOf(run, 'spec')})`, run.tasks.length ? `${run.tasks.length} tasks${run.size ? `, ${run.size}` : ''}` : ''),
    line(st.planState, 'plan approval (you)'),
    line(run.steps.builder.state, `builder${buildRound(run) > 1 ? ` · round ${buildRound(run)}` : ''} (${modelOf(run, 'builder')})`),
    line(run.steps.checks.state, 'checks', checksLine(run)),
    ...run.reviews.map(r => `  ${line(r.state, `${ROLES[r.role].label} (${modelOf(run, r.role)})`, r.state === 'changes' ? `${r.findings.length} findings` : r.state === 'pass' ? 'PASS' : '')}`),
    line(run.steps.approver.state, `approver (${modelOf(run, 'approver')})`),
    line(st.pr !== 'wait' ? st.pr : st.human === 'changes' ? 'changes' : 'wait', st.pr === 'pass' ? 'open PR' : st.pr === 'run' ? 'open PR (you)' : st.human === 'changes' ? 'needs-human' : 'PR or needs-human'),
  ]
}
