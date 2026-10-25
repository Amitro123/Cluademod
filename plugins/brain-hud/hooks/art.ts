// The pixel art: Claude with a brain on its head, reacting to what just happened to the memory, as
// one SVG string; the terminal's text version; and the brain map for the pane's header.

import type { Folder, PulseKind } from '../types'

const BODY = '#d97757'
const EYE = '#1d1f2b'
const BRAIN = '#f2a7c3'
const FOLD = '#c96f97'
const CELL = 4

export const KIND_COLOR: Record<PulseKind, string> = {
  mistake: '#e5484d',
  success: '#30a46c',
  decision: '#3b7dd8',
  handoff: '#f5a524',
  route: '#8e6cd8',
  promote: '#d97757',
  dream: '#6e7ab8',
}

type Px = [x: number, y: number, fill: string]

// 13×13 cells: a brain of 4 rows over the body. Eyes close in a dream; the brain flashes red for a
// mistake and glows green for a success.
const BRAIN_ROWS = ['...bbbbbbb...', '..bbfbbbfbb..', '..bfbbfbbfb..', '...bbbbbbb...']
const HEAD = ['..ooooooooo..', '..ooeooooeo..', '..ooeooooeo..', '..ooooooooo..', '..ooooooooo..']

export function claudeCells(kind: PulseKind, frame: number): Px[] {
  const px: Px[] = []
  const lit = frame % 2 === 0
  const brain = kind === 'mistake' && lit ? '#ff8a8f' : kind === 'success' && lit ? '#b8f0c8' : BRAIN
  BRAIN_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'b') px.push([x, y, brain])
      if (row[x] === 'f') px.push([x, y, FOLD])
    }
  })
  const asleep = kind === 'dream'
  HEAD.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'o') px.push([x, y + 4, BODY])
      if (row[x] === 'e' && !(asleep && y === 1)) px.push([x, y + 4, asleep ? BODY : EYE])
    }
  })
  if (asleep) px.push([4, 6, EYE], [5, 6, EYE], [9, 6, EYE], [10, 6, EYE])
  // Arms: one raised to hand over a note or stamp a rule, else at the sides.
  const raised = kind === 'handoff' || kind === 'promote' || kind === 'decision'
  px.push([0, 7, BODY], [1, 7, BODY])
  px.push(raised ? [12, 5, BODY] : [12, 7, BODY], raised ? [11, 6, BODY] : [11, 7, BODY])
  // Legs.
  for (const x of [4, 8]) px.push([x, 9, BODY], [x, 10, BODY])
  return px
}

export const SCENE = { width: 200, height: 56 }

const rect = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`

// A folder icon at (x, y).
const folderIcon = (x: number, y: number, fill: string) =>
  `<path d="M${x} ${y + 3}h7l2 2h11v13h-20z" fill="${fill}"/><path d="M${x} ${y + 7}h20v11h-20z" fill="${fill}" fill-opacity="0.75"/>`

// Claude on the left; to its right, what it does for this kind of event.
export function sceneSvg(kind: PulseKind, frame: number): string {
  const { width: w, height: h } = SCENE
  const color = KIND_COLOR[kind]
  const ox = 8
  const oy = h - 11 * CELL - 2
  let s = ''
  if (kind === 'success') s += `<circle cx="${ox + 26}" cy="${oy + 8}" r="${frame % 2 ? 16 : 13}" fill="${color}" fill-opacity="0.18"/>`
  for (const [x, y, fill] of claudeCells(kind, frame)) s += rect(ox + x * CELL, oy + y * CELL, CELL, CELL, fill)
  const ax = 72
  const t = frame % 8
  if (kind === 'mistake') {
    // A spark off the brain, then a plaster across it.
    s += `<path d="M${ox + 44} ${oy - 1}l-5 8h4l-3 7 8-10h-4l3-5z" fill="${color}" opacity="${frame % 2 ? 1 : 0.4}"/>`
    s += rect(ox + 10, oy + 4, 16, 4, '#f6e2b3', ' transform="rotate(-18 ' + (ox + 18) + ' ' + (oy + 6) + ')"')
  } else if (kind === 'success') {
    s += `<path d="M${ax + 10} ${12 - (t % 2)}l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z" fill="#f5c84b"/>`
  } else if (kind === 'decision') {
    // A signpost: two arms, the chosen one lit.
    s += rect(ax + 10, 14, 3, 36, '#8b8fa3')
    s += `<path d="M${ax + 13} 16h22l5 4-5 4h-22z" fill="${t < 4 ? color : '#8b8fa3'}"/>`
    s += `<path d="M${ax + 10} 28h-20l-5 4 5 4h20z" fill="${t < 4 ? '#8b8fa3' : color}"/>`
  } else if (kind === 'handoff') {
    // A note travelling from Claude's hand to the right.
    const nx = ax + (t * 12)
    s += rect(nx, 18 - (t % 2) * 2, 14, 11, '#fff7d6', ` stroke="${color}" stroke-width="1"`)
    s += rect(nx + 3, 21 - (t % 2) * 2, 8, 1, color) + rect(nx + 3, 24 - (t % 2) * 2, 6, 1, color)
  } else if (kind === 'route') {
    // Notes fly from the brain into a folder.
    s += folderIcon(w - 40, 22, color)
    for (let i = 0; i < 3; i++) {
      const p = ((t + i * 3) % 8) / 8
      const x = ox + 40 + p * (w - 80 - ox)
      const y = oy + 4 - Math.sin(p * Math.PI) * 14
      s += rect(Math.round(x), Math.round(y), 7, 6, '#fff7d6', ` stroke="${color}" stroke-width="0.8"`)
    }
  } else if (kind === 'promote') {
    // A stamp coming down on a rule sheet.
    const down = t < 4 ? t * 3 : 12
    s += rect(ax + 4, 28, 34, 22, '#fff7d6', ` stroke="#8b8fa3" stroke-width="1"`)
    s += rect(ax + 9, 34, 22, 2, '#8b8fa3') + rect(ax + 9, 40, 16, 2, '#8b8fa3')
    s += rect(ax + 14, 4 + down, 14, 6, color) + rect(ax + 19, down - 4, 4, 9, '#5b4636')
    if (t >= 4) s += `<text x="${ax + 21}" y="47" font-size="8" font-weight="700" fill="${color}" text-anchor="middle">RULE</text>`
  } else {
    // Dreaming: Zs rising.
    for (let i = 0; i < 3; i++) {
      const y = 30 - ((t + i * 3) % 8) * 3
      s += `<text x="${ox + 50 + i * 8}" y="${y}" font-size="${8 + i * 2}" font-weight="700" fill="${color}" fill-opacity="${0.4 + i * 0.2}">z</text>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${s}</svg>`
}

const FACE: Record<PulseKind, string> = {
  mistake: '🧠ϟ(>_<)',
  success: '🧠✦(^_^)',
  decision: '🧠 (•_•)⇄',
  handoff: '🧠 (•_•)✉',
  route: '🧠 (•_•)→📁',
  promote: '🧠 (•̀_•́)⚖',
  dream: '🧠 (-_-) z',
}
export const faceText = (kind: PulseKind) => FACE[kind]

export const MAP = { width: 280, height: 96 }

// The brain map: four lobes, one per PARA folder, each brighter the more lessons it holds, and the
// inbox as a stack of notes beside it. `hot` lights the folder something just went into.
export function brainMapSvg(counts: Record<Folder, number>, inbox: number, hot?: Folder): string {
  const { width: w, height: h } = MAP
  const max = Math.max(1, ...Object.values(counts))
  const lobes: [Folder, number, number][] = [['Projects', 52, 28], ['Areas', 136, 28], ['Resources', 52, 68], ['Archives', 136, 68]]
  let s = `<ellipse cx="94" cy="48" rx="92" ry="46" fill="${BRAIN}" fill-opacity="0.25"/>`
  for (const [f, cx, cy] of lobes) {
    const n = counts[f]
    const op = n ? 0.35 + 0.65 * (n / max) : 0.15
    s += `<ellipse cx="${cx}" cy="${cy}" rx="40" ry="17" fill="${f === hot ? '#ffd166' : BRAIN}" fill-opacity="${op.toFixed(2)}" stroke="${FOLD}" stroke-width="1.2"/>`
    s += `<text x="${cx}" y="${cy - 1}" font-size="9" text-anchor="middle" fill="${EYE}">${f}</text>`
    s += `<text x="${cx}" y="${cy + 10}" font-size="9" font-weight="700" text-anchor="middle" fill="${EYE}">${n}</text>`
  }
  // The inbox: one note per unrouted entry, up to 5.
  const notes = Math.min(5, inbox)
  for (let i = 0; i < Math.max(1, notes); i++) s += rect(214 + i * 3, 34 - i * 3, 34, 26, i < notes ? '#fff7d6' : 'none', ` stroke="#8b8fa3" stroke-width="1"${i < notes ? '' : ' stroke-dasharray="3 2"'}`)
  s += `<text x="${231 + Math.max(0, notes - 1) * 3}" y="${51 - Math.max(0, notes - 1) * 3}" font-size="9" text-anchor="middle" fill="${EYE}">${inbox}</text>`
  s += `<text x="231" y="78" font-size="9" text-anchor="middle" fill="#8b8fa3">inbox</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${s}</svg>`
}
