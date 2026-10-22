// The pixel art: one creature per sub-agent, the band's task bar and a card's progress line,
// all as plain SVG strings so every surface that has `Svg` draws the same thing.

export const COLORS = ['#1f9d6b', '#e0533d', '#3b7dd8', '#d6409f', '#8a5cf0', '#e08a1e', '#16a3b8', '#c9a227']
const EYE = '#1d1f2b'
const GRAY = '#8b8fa3'

export const colorOf = (slot: number) => COLORS[slot % COLORS.length] ?? COLORS[0]!

// 11×8 cells. `#` body, `o` eye, `-` a shut eye (done), legs drawn per frame.
const BODY = ['..#######..', '.#########.', '###o###o###', '###########', '###########', '.#########.']
const DONE_EYES = '###-###-###'
const LEGS = ['.#.#.#.#.#.', '#.#.#.#.#.#']
const CELL = 4
export const CREATURE = { width: 11 * CELL, height: 8 * CELL }

export function creatureSvg(slot: number, state: 'running' | 'done' | 'failed', frame: number): string {
  const body = state === 'failed' ? GRAY : colorOf(slot)
  const rows = [...BODY]
  if (state !== 'running') rows[2] = DONE_EYES
  // Running creatures shuffle their legs and bob a pixel; finished ones stand still.
  const walk = state === 'running' ? frame % 2 : 0
  rows.push(LEGS[walk] ?? '', '...........')
  const dy = state === 'running' && walk ? 1 : 0
  let rects = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x]
      if (c === '.') continue
      const fill = c === '#' ? body : EYE
      const h = c === '-' ? CELL / 2 : CELL
      const top = (y + dy) * CELL + (c === '-' ? CELL / 2 : 0)
      rects += `<rect x="${x * CELL}" y="${top}" width="${CELL}" height="${h}" fill="${fill}"/>`
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CREATURE.width}" height="${CREATURE.height}" viewBox="0 0 ${CREATURE.width} ${CREATURE.height}" shape-rendering="crispEdges">${rects}</svg>`
}

export const BAR = { width: 420, height: 22 }

// The band's bar: a track, the done part filled, "Tasks 4/5" riding the fill's right edge.
export function taskBarSvg(done: number, total: number): string {
  const { width: w, height: h } = BAR
  const r = h / 2
  const fill = total ? Math.max(h, Math.round((w * done) / total)) : 0
  const label = `Tasks ${done}/${total}`
  const lw = label.length * 7 + 16
  const lx = Math.min(w - lw, Math.max(0, fill - lw))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" rx="${r}" fill="#3b7dd8" fill-opacity="0.22"/>
${done ? `<rect width="${fill}" height="${h}" rx="${r}" fill="#3b7dd8"/>` : ''}
<rect x="${lx}" width="${lw}" height="${h}" rx="3" fill="#1d4fa8"/>
<text x="${lx + lw / 2}" y="${h / 2 + 4.5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#fff">${label}</text>
</svg>`
}

export const LINE = { width: 220, height: 4 }

export function progressLineSvg(fraction: number, color: string): string {
  const { width: w, height: h } = LINE
  const f = Math.round(w * Math.max(0, Math.min(1, fraction)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="2" fill="${GRAY}" fill-opacity="0.25"/><rect width="${f}" height="${h}" rx="2" fill="${color}"/></svg>`
}

// The terminal's versions.
export const barText = (fraction: number, cells: number) => {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  return '▰'.repeat(n) + '▱'.repeat(cells - n)
}
export const creatureText = (state: 'running' | 'done' | 'failed', frame: number) =>
  state === 'done' ? '▟(-‿-)▙' : state === 'failed' ? '▟(×_×)▙' : frame % 2 ? '▟(•_•)▙' : '▙(•_•)▟'
