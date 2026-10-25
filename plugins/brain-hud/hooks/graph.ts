// The memory as a knowledge graph: MEMORY.md at the centre, the four PARA folders around it, each
// folder's files, and every MISTAKES.md entry as a dot linked to the file it was routed to.
// Entries not routed yet float in an inbox cluster with no link. A fixed radial layout, so the
// graph never jumps between refreshes.

import type { Brain, Entry, EntryType, Folder, Lesson } from '../types'

export type Theme = 'dark' | 'light'
export const GRAPH = { width: 640, height: 400 }

const FOLDERS: Folder[] = ['Projects', 'Areas', 'Resources', 'Archives']
const HUB_ANGLE: Record<Folder, number> = { Projects: -140, Areas: -40, Resources: 40, Archives: 140 }
const HUB_R = 104
// What a large memory is cut to, so nothing runs off the canvas or piles up: files per folder (the
// ones with the most lessons, and the one just written to), dots per file, dots in the inbox.
const MAX_FILES = 7
const MAX_RINGS = 3
const PER_RING = 18
const MAX_INBOX = 30

// Where file j of n sits: in a column on its folder's outer side (Projects and Archives left, Areas
// and Resources right), spread evenly down that folder's half of the canvas, its label facing out.
// A column keeps every label on its own row, however many files a folder holds (up to MAX_FILES).
const COLUMN_X = 150
function filePos(cx: number, cy: number, folder: Folder, j: number, n: number) {
  const right = folder === 'Areas' || folder === 'Resources'
  const top = folder === 'Projects' || folder === 'Areas'
  const [lo, hi] = top ? [14, cy - 12] : [cy + 14, GRAPH.height - 26]
  const y = n === 1 ? (top ? hi - 20 : lo + 20) : lo + ((hi - lo) * (j + 0.5)) / n
  return { x: right ? cx + COLUMN_X : cx - COLUMN_X, y, deg: right ? 0 : 180 }
}
const HUB_COLOR: Record<Folder, string> = { Projects: '#a78bfa', Areas: '#38bdf8', Resources: '#34d399', Archives: '#94a3b8' }
const TYPE_COLOR: Record<EntryType, string> = { mistake: '#f87171', success: '#4ade80', decision: '#60a5fa', handoff: '#fbbf24' }

const PALETTE = {
  dark: { bg: '#0b0e14', edge: '#94a3b8', label: '#e2e8f0', dim: '#64748b', core: '#f8fafc', ring: '#1e293b' },
  light: { bg: '#fbfaf7', edge: '#64748b', label: '#1e293b', dim: '#94a3b8', core: '#334155', ring: '#e2e8f0' },
}

const rad = (deg: number) => (deg * Math.PI) / 180
const at = (x: number, y: number, deg: number, r: number) => [x + Math.cos(rad(deg)) * r, y + Math.sin(rad(deg)) * r] as const
const f1 = (n: number) => n.toFixed(1)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// The files a folder shows, in the index's order: the most lessons first past MAX_FILES, and the
// file just written to always.
export function shownFiles(files: Lesson[], hot?: string): Lesson[] {
  if (files.length <= MAX_FILES) return files
  const keep = new Set([...files].sort((a, b) => b.lessons - a.lessons).slice(0, MAX_FILES).map(l => l.file))
  if (hot && files.some(l => l.file === hot) && !keep.has(hot)) {
    const least = [...files].filter(l => keep.has(l.file)).sort((a, b) => a.lessons - b.lessons)[0]!
    keep.delete(least.file)
    keep.add(hot)
  }
  return files.filter(l => keep.has(l.file))
}

// Where an entry was routed: its folder and file name, from "Project: .agent-brain/…/Projects/x.md".
export function routeOf(e: Entry): { folder: Folder; file: string } | null {
  const m = /(Projects|Areas|Resources|Archives)\/([^/\s]+\.md)/.exec(e.route)
  return m ? { folder: m[1] as Folder, file: m[2]! } : null
}

export function graphSvg(b: Brain, opts: { theme: Theme; hot?: string; fresh?: number; travelling?: { entry: number; t: number } }): string {
  const { width: w, height: h } = GRAPH
  const P = PALETTE[opts.theme]
  const cx = w / 2
  const cy = h / 2 - 14
  let edges = ''
  let nodes = ''
  let labels = ''

  // The files each folder holds, with the entries routed to them.
  const routed = new Map<string, { e: Entry; i: number }[]>()
  const inbox: { e: Entry; i: number }[] = []
  // Routed somewhere the graph has no node for (a rule, a path it can't read): counted, not drawn as
  // waiting, so the inbox matches the unrouted count.
  let elsewhere = 0
  b.entries.forEach((e, i) => {
    if (e.status === 'unrouted') return inbox.push({ e, i })
    const r = routeOf(e)
    if (!r) return elsewhere++
    const k = `${r.folder}/${r.file}`
    routed.set(k, [...(routed.get(k) ?? []), { e, i }])
  })

  for (const folder of FOLDERS) {
    const [hx, hy] = at(cx, cy, HUB_ANGLE[folder], HUB_R)
    const color = HUB_COLOR[folder]
    const all = b.folders[folder]
    const files = shownFiles(all, opts.hot)
    edges += `<line x1="${cx}" y1="${cy}" x2="${f1(hx)}" y2="${f1(hy)}" stroke="${color}" stroke-opacity="0.45" stroke-width="1.6"/>`
    // Files fan out beyond the hub, away from the centre.
    files.forEach((l, j) => {
      const { x: fx, y: fy, deg } = filePos(cx, cy, folder, j, files.length)
      const fr = 4 + Math.sqrt(Math.max(1, l.lessons)) * 1.4
      const hot = opts.hot === l.file
      edges += `<line x1="${f1(hx)}" y1="${f1(hy)}" x2="${f1(fx)}" y2="${f1(fy)}" stroke="${color}" stroke-opacity="0.35" stroke-width="1"/>`
      // Its entries: a ring of dots, linked by short spokes.
      const mine = routed.get(`${folder}/${l.file}`) ?? []
      const dots = mine.slice(0, PER_RING * MAX_RINGS)
      dots.forEach(({ e, i }, k) => {
        const ring = Math.floor(k / PER_RING)
        const n = Math.min(PER_RING, dots.length - ring * PER_RING)
        const [ex, ey] = at(fx, fy, (360 / n) * (k % PER_RING) + ring * 10, fr + 10 + ring * 8)
        edges += `<line x1="${f1(fx)}" y1="${f1(fy)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="${P.edge}" stroke-opacity="0.18" stroke-width="0.6"/>`
        if (i === opts.fresh) nodes += `<circle cx="${f1(ex)}" cy="${f1(ey)}" r="8" fill="${TYPE_COLOR[e.type]}" fill-opacity="0.35" filter="url(#glow)"/>`
        nodes += `<circle cx="${f1(ex)}" cy="${f1(ey)}" r="2.4" fill="${TYPE_COLOR[e.type]}"/>`
      })
      if (hot) nodes += `<circle cx="${f1(fx)}" cy="${f1(fy)}" r="${f1(fr + 7)}" fill="${color}" fill-opacity="0.25" filter="url(#glow)"/>`
      nodes += `<circle cx="${f1(fx)}" cy="${f1(fy)}" r="${f1(fr)}" fill="${color}" fill-opacity="${hot ? 1 : 0.85}" stroke="${P.bg}" stroke-width="1.5"/>`
      // The label hangs on the far side of the file, along the angle it sits at.
      const rings = Math.ceil(dots.length / PER_RING)
      const gap = fr + (rings ? 14 + rings * 8 : 8)
      const [lx, ly] = at(fx, fy, deg, gap)
      const c = Math.cos(rad(deg))
      const anchor = c > 0.35 ? 'start' : c < -0.35 ? 'end' : 'middle'
      const dy = anchor === 'middle' ? (Math.sin(rad(deg)) > 0 ? 8 : -12) : 0
      labels += `<text x="${f1(lx)}" y="${f1(ly + dy)}" font-size="9.5" fill="${hot ? color : P.label}" font-weight="${hot ? 700 : 500}" text-anchor="${anchor}">${esc(short(l.file.replace(/\.md$/, ''), 24))}</text>`
      labels += `<text x="${f1(lx)}" y="${f1(ly + dy + 11)}" font-size="8.5" fill="${P.dim}" text-anchor="${anchor}">${l.isIndexed ? `${l.lessons} lesson${l.lessons === 1 ? '' : 's'}` : 'not in MEMORY.md'}</text>`
    })
    // The hub.
    nodes += `<circle cx="${f1(hx)}" cy="${f1(hy)}" r="11" fill="${P.bg}" stroke="${color}" stroke-width="2"/>`
    nodes += `<circle cx="${f1(hx)}" cy="${f1(hy)}" r="4" fill="${color}"/>`
    const up = Math.sin(rad(HUB_ANGLE[folder])) < 0
    labels += `<text x="${f1(hx)}" y="${f1(hy + (up ? -17 : 24))}" font-size="10" font-weight="700" fill="${color}" text-anchor="middle">${folder}${all.length ? (all.length > files.length ? ` · +${all.length - files.length} more` : '') : ' · empty'}</text>`
  }

  // The inbox: entries waiting to be routed, unlinked, below the centre.
  const ix = cx
  const iy = h - 34
  inbox.slice(0, MAX_INBOX).forEach(({ e, i }, k) => {
    const col = k % 10
    const row = Math.floor(k / 10)
    if (i === opts.fresh) nodes += `<circle cx="${f1(ix - (Math.min(10, inbox.length) - 1) * 4.5 + col * 9)}" cy="${f1(iy + row * 9)}" r="10" fill="${TYPE_COLOR[e.type]}" fill-opacity="0.35" filter="url(#glow)"/>`
    nodes += `<circle cx="${f1(ix - (Math.min(10, inbox.length) - 1) * 4.5 + col * 9)}" cy="${f1(iy + row * 9)}" r="3" fill="${TYPE_COLOR[e.type]}" stroke="${TYPE_COLOR[e.type]}" stroke-opacity="0.35" stroke-width="3"/>`
  })
  labels += `<text x="${ix}" y="${iy - 10}" font-size="9" fill="${P.dim}" text-anchor="middle">inbox · ${inbox.length} to route${elsewhere ? ` · ${elsewhere} routed outside the folders` : ''}</text>`
  if (inbox.length > MAX_INBOX) labels += `<text x="${f1(ix + 52)}" y="${iy + 21}" font-size="9" fill="${P.dim}">+${inbox.length - MAX_INBOX}</text>`

  // Rules promoted from the memory, above the centre.
  b.rules.slice(0, 3).forEach((r, k) => {
    const [rx, ry] = [cx - 60 + k * 60, 26]
    edges += `<line x1="${cx}" y1="${cy}" x2="${rx}" y2="${ry}" stroke="${P.edge}" stroke-opacity="0.3" stroke-dasharray="2 3"/>`
    nodes += `<rect x="${rx - 7}" y="${ry - 7}" width="14" height="14" rx="3" fill="#f59e0b"/>`
    labels += `<text x="${rx}" y="${ry + 18}" font-size="8" fill="${P.dim}" text-anchor="middle">${esc(short(r, 18))}</text>`
  })

  // The centre: MEMORY.md, the index both harnesses read.
  nodes += `<circle cx="${cx}" cy="${cy}" r="22" fill="${P.core}" fill-opacity="0.08" filter="url(#glow)"/>`
  nodes += `<circle cx="${cx}" cy="${cy}" r="14" fill="${P.bg}" stroke="${P.core}" stroke-width="2"/>`
  nodes += `<circle cx="${cx}" cy="${cy}" r="5" fill="${P.core}"/>`
  labels += `<text x="${cx}" y="${cy + 30}" font-size="10" font-weight="700" fill="${P.label}" text-anchor="middle">MEMORY.md</text>`

  // A new entry travelling from the inbox to its file.
  if (opts.travelling) {
    const e = b.entries[opts.travelling.entry]
    const r = e && routeOf(e)
    if (e && r) {
      const files = shownFiles(b.folders[r.folder], opts.hot)
      const j = Math.max(0, files.findIndex(l => l.file === r.file))
      const { x: fx, y: fy } = filePos(cx, cy, r.folder, j, files.length)
      const t = opts.travelling.t
      // Along a curve through the centre's side, from the inbox to the file.
      const qx = (ix + fx) / 2 - 60
      const qy = (iy + fy) / 2
      const x = (1 - t) ** 2 * ix + 2 * (1 - t) * t * qx + t ** 2 * fx
      const y = (1 - t) ** 2 * iy + 2 * (1 - t) * t * qy + t ** 2 * fy
      edges += `<path d="M${ix} ${iy} Q${f1(qx)} ${f1(qy)} ${f1(fx)} ${f1(fy)}" fill="none" stroke="${TYPE_COLOR[e.type]}" stroke-opacity="0.5" stroke-width="1.2" stroke-dasharray="3 3"/>`
      nodes += `<circle cx="${f1(x)}" cy="${f1(y)}" r="9" fill="${TYPE_COLOR[e.type]}" fill-opacity="0.3" filter="url(#glow)"/><circle cx="${f1(x)}" cy="${f1(y)}" r="4" fill="${TYPE_COLOR[e.type]}"/>`
    }
  }

  const defs = `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}<rect width="${w}" height="${h}" rx="10" fill="${P.bg}"/>${edges}${nodes}${labels}</svg>`
}
