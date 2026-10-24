// The pixel art: Claude in running shoes on a track to a finish flag, as one SVG string, and the
// terminal's text version of the same track.

const BODY = '#d97757'
const EYE = '#1d1f2b'
const SHOE = '#3b7dd8'
const STRIPE = '#ffffff'
const SOLE = '#3a3d4d'
const TRACK = '#8b8fa3'
const CELL = 4

export type Pose = 'run' | 'stand' | 'cheer'

// 14×12 cells: two rows of headroom for raised arms, then the body (`o`, `e` an eye); arms, legs
// and the sneakers are placed per frame.
const TOP = 2
const HEAD = ['..ooooooooo..', '..ooooooooo..', '..ooeooooeo..', '..ooeooooeo..', '..ooooooooo..', '..ooooooooo..']

type Px = [x: number, y: number, fill: string]

// One frame of the sprite as cells: running cycles four strides, standing and cheering hold still.
export function spriteCells(pose: Pose, frame: number): Px[] {
  const px: Px[] = []
  const bob = pose === 'run' && frame % 2 === 1 ? 1 : 0
  HEAD.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'o') px.push([x, y + TOP + bob, BODY])
      if (row[x] === 'e') px.push([x, y + TOP + bob, EYE])
    }
  })
  // Arms: out at the sides, swinging up and down while running, raised when cheering.
  if (pose === 'cheer') {
    for (const [x, y] of [[1, 2], [0, 1], [0, 0], [11, 2], [12, 1], [12, 0]] as const) px.push([x, y, BODY])
  } else {
    const swing = pose === 'run' ? (frame % 4 < 2 ? -1 : 1) : 0
    const armY = TOP + 3 + bob
    for (const [x, dy] of [[0, swing], [1, swing], [11, -swing], [12, -swing]] as const) px.push([x, armY + dy, BODY])
  }
  // Legs and shoes: the front and back foot trade places through the stride.
  const stride = pose === 'run' ? [[-1, 1], [0, 0], [1, -1], [0, 0]][frame % 4]! : [0, 0]
  const feet = [
    { x: 4 + stride[0]!, lift: pose === 'run' && stride[0]! > 0 ? 1 : 0 },
    { x: 8 + stride[1]!, lift: pose === 'run' && stride[1]! > 0 ? 1 : 0 },
  ]
  for (const { x, lift } of feet) {
    const y = TOP + 6 + bob - lift
    px.push([x, y, BODY], [x, y + 1, BODY])
    // A chunky sneaker pointing ahead: blue with a white stripe, on a dark sole.
    px.push([x - 1, y + 2, SHOE], [x, y + 2, STRIPE], [x + 1, y + 2, SHOE], [x + 2, y + 2, SHOE])
    px.push([x - 1, y + 3, SOLE], [x, y + 3, SOLE], [x + 1, y + 3, SOLE], [x + 2, y + 3, SOLE])
  }
  return px
}

export const TRACK_SIZE = { width: 360, height: 74 }
const SPRITE_W = 14 * CELL
const SPRITE_H = 12 * CELL
const LEFT = 6
const FLAG_X = TRACK_SIZE.width - 22
const GROUND = 66

// Where the runner stands for a fraction of the goal: the start at 0, the flag at 1.
export const runnerX = (fraction: number) => LEFT + Math.round(Math.max(0, Math.min(1, fraction)) * (FLAG_X - SPRITE_W - LEFT - 2))

export function trackSvg(fraction: number, pose: Pose, frame: number): string {
  const { width: w, height: h } = TRACK_SIZE
  const x0 = runnerX(fraction)
  const y0 = GROUND - SPRITE_H + 1
  let s = ''
  // The track: run so far in the body's color, the rest dashed, a checkered flag at the end.
  s += `<line x1="${LEFT}" y1="${GROUND + 1}" x2="${FLAG_X}" y2="${GROUND + 1}" stroke="${TRACK}" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="4 4"/>`
  s += `<line x1="${LEFT}" y1="${GROUND + 1}" x2="${x0 + SPRITE_W / 2}" y2="${GROUND + 1}" stroke="${BODY}" stroke-width="3" stroke-linecap="round"/>`
  s += `<rect x="${FLAG_X}" y="${GROUND - 34}" width="2" height="36" fill="${SOLE}"/>`
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    s += `<rect x="${FLAG_X + 2 + c * 4}" y="${GROUND - 34 + r * 4}" width="4" height="4" fill="${(r + c) % 2 ? '#ffffff' : '#1d1f2b'}" stroke="#1d1f2b" stroke-width="0.3"/>`
  }
  // Dust behind the shoes while running; confetti at the flag once there.
  if (pose === 'run') {
    const puff = frame % 2 ? 2 : 3
    s += `<circle cx="${x0 - 4}" cy="${GROUND - 2}" r="${puff}" fill="${TRACK}" fill-opacity="0.35"/><circle cx="${x0 - 10}" cy="${GROUND - 1}" r="${puff - 1}" fill="${TRACK}" fill-opacity="0.2"/>`
  }
  if (pose === 'cheer') {
    const bits = [[-14, 6, STRIPE], [-6, 0, '#3b7dd8'], [4, 4, '#1f9d6b'], [SPRITE_W + 2, 2, '#c9a227'], [SPRITE_W + 8, 9, '#8a5cf0'], [-10, 14, '#c9a227']] as const
    for (const [dx, dy, c] of bits) s += `<rect x="${x0 + dx}" y="${y0 - 6 + dy + (frame % 2)}" width="3" height="3" fill="${c}" transform="rotate(${(dx * 7) % 45} ${x0 + dx} ${y0 + dy})"/>`
  }
  for (const [x, y, fill] of spriteCells(pose, frame)) {
    s += `<rect x="${x0 + x * CELL}" y="${y0 + y * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${s}</svg>`
}

// The terminal's track: the runner's place along a row of cells, the flag at the end.
export function trackText(fraction: number, pose: Pose, frame: number, cells: number): string {
  const runner = pose === 'cheer' ? '\\(^o^)/' : pose === 'run' ? (frame % 2 ? '=(•_•)»' : '-(•_•)»') : ' (•_•) '
  const room = Math.max(4, cells - runner.length - 2)
  const at = Math.round(Math.max(0, Math.min(1, fraction)) * room)
  return `${'━'.repeat(at)}${runner}${'┄'.repeat(room - at)} ⚑`
}
