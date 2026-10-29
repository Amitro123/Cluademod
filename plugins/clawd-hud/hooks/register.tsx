import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ctx, Limit, Mood } from '../types'
import { BATTERY, BOLT, LOW, OK, PILL, batterySvg, boltSvg, cellsText, charge, pillSvg } from './gauges'
import { DONE_SECONDS, ERROR_SECONDS, HARD_SECONDS, SCENE_HEIGHT, SCENE_WIDTH, sceneSvg } from './scene'

// ---------- state ----------

const mood = atom({ plugin: 'clawd-hud', key: 'mood' } as const, 'idle' as Mood)
const moodAt = atom({ plugin: 'clawd-hud', key: 'moodAt' } as const, 0)
const frame = atom({ plugin: 'clawd-hud', key: 'frame' } as const, 0)
// Whether the band last drew SVG scenes (desktop) rather than the terminal's text face. A render
// can't write state, and after a reload the next render sets it again.
let svgBand = false
const cacheAt = atom({ plugin: 'clawd-hud', key: 'cacheAt' } as const, null as number | null)
const now = atom({ plugin: 'clawd-hud', key: 'now' } as const, 0)
const minute = atom({ plugin: 'clawd-hud', key: 'minute' } as const, 0)
const ctx = atom({ plugin: 'clawd-hud', key: 'ctx' } as const, null as Ctx | null)
const limits = atom({ plugin: 'clawd-hud', key: 'limits' } as const, [] as Limit[])
const eureka = atom({ plugin: 'clawd-hud', key: 'eureka' } as const, false)
const loopSince = atom({ plugin: 'clawd-hud', key: 'loopSince' } as const, null as number | null)
const toolCounts = atom({ plugin: 'clawd-hud', key: 'toolCounts' } as const, {} as Record<string, number>)
const cost = atom({ plugin: 'clawd-hud', key: 'cost' } as const, null as number | null)

const MIN = 60_000
// The mascot is redrawn as still frames at this interval (8 a second).
const FRAME_MS = 125
// Idle and resting: the terminal's face needs a frame a second; the SVG scenes look smooth at 4.
const IDLE_FRAME_MS = 1_000
const SVG_IDLE_FRAME_MS = 250
// After the fireworks the spark rests this long before idling.
const RELAX_MS = 4 * MIN
// The same tool with the same input this many times in one turn means Claude is going in circles.
const LOOP_REPEATS = 3
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

// The intervals armed by session.start, kept so a later session.start can cancel them.
const timers: { cancel: () => void }[] = []

// ---------- plans ----------

// Personal plans meter a 5-hour and a weekly window; enterprise seats meter the week and a
// monthly spend cap (a gateway's `spend_limit`, which can run past 100%).
type Cfg = { plan: string; cacheTtl: string }
type Win = { kind: string; label: string }
const PERSONAL: Win[] = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
]
const ENTERPRISE: Win[] = [
  { kind: 'seven_day', label: '7d' },
  { kind: 'spend_limit', label: 'mo' },
]

const isEnterprise = (cfg: Cfg, rl: Limit[]) =>
  cfg.plan === 'enterprise' || (cfg.plan !== 'personal' && rl.some(l => l.kind === 'spend_limit'))

const ttlOf = (cfg: Cfg, enterprise: boolean) =>
  cfg.cacheTtl === '5m' ? 5 * MIN : cfg.cacheTtl === '1h' ? 60 * MIN : enterprise ? 5 * MIN : 60 * MIN

// When the window resets: the API's own time, or for a spend cap without one, the 1st of next month.
function resetAt(win: Win, lim: Limit | undefined, t: number): number | null {
  if (lim?.resetsAt) return Date.parse(lim.resetsAt)
  if (win.kind !== 'spend_limit') return null
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
}

async function planOf($: EngineInterface, cfg: Cfg) {
  const rl = await read($, limits)
  const enterprise = isEnterprise(cfg, rl)
  return { rl, enterprise, wins: enterprise ? ENTERPRISE : PERSONAL, ttlMs: ttlOf(cfg, enterprise) }
}

// ---------- text ----------

// "2d 4h", "3h 12m", "45m".
function until(ms: number): string {
  if (!Number.isFinite(ms)) return '–'
  const mins = Math.max(0, Math.round(ms / MIN))
  const d = Math.floor(mins / 1440)
  const h = Math.floor(mins / 60) % 24
  return d ? `${d}d ${h}h` : h ? `${h}h ${mins % 60}m` : `${mins % 60}m`
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const usd = (n: number) => `$${n.toFixed(2)}`
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

// A window as what is left of it: "66% left", or past a spend cap, "over by 12%".
function leftOf(lim: Limit | undefined) {
  if (!lim) return { left: 0, over: false, text: '–' }
  const used = lim.percentUsed
  if (used > 100) return { left: 0, over: true, text: `over by ${Math.round(used - 100)}%` }
  const left = Math.max(0, 100 - used)
  return { left, over: false, text: `${Math.round(left)}% left` }
}

function cacheOf(at: number | null, tNow: number, ttlMs: number) {
  const left = at === null ? 0 : ttlMs - (tNow - at)
  const warm = at !== null && left > 0
  return {
    warm,
    label: at === null ? 'cache –' : warm ? `cache ${mmss(left)}` : 'cache cold',
    color: !warm ? '#59618a' : left < MIN ? LOW : OK,
  }
}

// ---------- moods ----------

async function setMood($: EngineInterface, m: Mood) {
  const t = await $.clock.now()
  await update($, moodAt, () => t)
  await update($, mood, () => m)
}

// What plays `s` seconds into a stored mood: fireworks, a rest, then idle; or a short storm, then idle.
function sceneFor(m: Mood, s: number): { mood: Mood; t: number } {
  if (m === 'done') return s < DONE_SECONDS ? { mood: 'done', t: s } : sceneFor('relax', s - DONE_SECONDS)
  if (m === 'error') return s < ERROR_SECONDS ? { mood: 'error', t: s } : { mood: 'idle', t: s - ERROR_SECONDS }
  if (m === 'relax' && s >= RELAX_MS / 1000) return { mood: 'idle', t: s - RELAX_MS / 1000 }
  return { mood: m, t: s }
}

const ALT: Record<Mood, string> = {
  idle: 'drifting',
  working: 'working',
  loop: 'stuck riding a coaster loop',
  done: 'setting off fireworks',
  relax: 'taking it easy',
  error: 'gone gray under a storm cloud',
}

// The terminal's spark, as text.
const SPIN = ['◐', '◓', '◑', '◒']

export function faceFor(m: Mood, t: number, idea: boolean): string {
  const f = Math.floor((t * 1000) / FRAME_MS)
  if (m === 'working') return `✦(•_•) ${SPIN[f % SPIN.length]}`
  if (m === 'loop') return '✦(@_@) ↻'
  if (m === 'done') return `✦\\(^o^)/${idea ? ' (!)' : ''}`
  if (m === 'relax') return '✦(˘_˘) ♪'
  if (m === 'error') return '✦(;_;) ϟ'
  // On whole seconds, so the once-a-second idle redraw always lands on it.
  return Math.floor(t) % 4 === 0 ? '✦(-_-)' : '✦(•_•)'
}

// ---------- loop detector ----------

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function countCall($: EngineInterface, e: { tool: string; agentId?: string }) {
  if (e.agentId || (await read($, loopSince)) !== null) return
  const args = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
  const sig = `${e.tool}:${hash(JSON.stringify(args))}`
  await update($, toolCounts, c => ({ ...c, [sig]: (c[sig] ?? 0) + 1 }))
  if (((await read($, toolCounts))[sig] ?? 0) >= LOOP_REPEATS) {
    const t = await $.clock.now()
    await update($, loopSince, () => t)
  }
}

// One line in the status bar with every reading, for surfaces that draw neither band.
async function refreshStatus($: EngineInterface, cfg: Cfg) {
  const { rl, enterprise, wins, ttlMs } = await planOf($, cfg)
  const c = await read($, ctx)
  const spent = await read($, cost)
  const cache = cacheOf(await read($, cacheAt), await $.clock.now(), ttlMs)
  const parts = [
    ...wins.map(w => `${w.label} ${leftOf(rl.find(l => l.kind === w.kind)).text}`),
    ...(enterprise && spent !== null ? [usd(spent)] : []),
    cache.label,
    c?.percent === undefined ? 'ctx –' : `ctx ${c.percent}%`,
  ]
  $.ui.status(`✦ ${parts.join(' · ')}`)
}

export const register: Register = (on, options) => {
  const cfg: Cfg = { plan: String(options.plan ?? 'auto'), cacheTtl: String(options.cacheTtl ?? 'auto') }

  on('session.start', async ($, e, next) => {
    // session.start can fire again for the same module (an enable, a worker respawn):
    // drop the previous timers so the intervals never stack up.
    for (const timer of timers.splice(0)) timer.cancel()

    const u = await $.session.usage()
    await update($, ctx, () => u.context)
    await update($, limits, () => u.rateLimits)
    await update($, cost, () => u.cost?.usd ?? null)
    const t0 = await $.clock.now()
    await update($, minute, () => t0)
    await update($, moodAt, () => t0)

    // Keep "resets in" fresh.
    timers.push($.clock.every(MIN, async () => {
      const t = await $.clock.now()
      await update($, minute, () => t)
      await refreshStatus($, cfg)
    }))
    // Every motion is a function of elapsed time, so an idle or resting spark can redraw
    // less often; working, loop, done and error scenes get every frame.
    timers.push($.clock.every(FRAME_MS, async () => {
      const t = await $.clock.now()
      const scene = sceneFor(await read($, mood), (t - (await read($, moodAt))) / 1000).mood
      const still = scene === 'idle' || scene === 'relax'
      const every = svgBand ? SVG_IDLE_FRAME_MS : IDLE_FRAME_MS
      if (still && t - (await read($, frame)) < every) return
      await update($, frame, () => t)
    }))
    // Tick the cache countdown while it is warm, and once more after expiry: a late tick
    // (the machine slept) must still flip the label to "cold" instead of freezing it.
    timers.push($.clock.every(1_000, async () => {
      const at = await read($, cacheAt)
      if (at === null) return
      const t = await $.clock.now()
      const { ttlMs } = await planOf($, cfg)
      const shownWarm = (await read($, now)) - at < ttlMs
      if (t - at < ttlMs + 2_000 || shownWarm) {
        await update($, now, () => t)
        await refreshStatus($, cfg)
      }
    }))

    await refreshStatus($, cfg)
    return next(e)
  })

  // Each response refreshes the prompt cache and reports the live usage.
  on('session.measure', async ($, e, next) => {
    await update($, ctx, () => e.context)
    if (e.rateLimits.length) await update($, limits, () => e.rateLimits)
    if (e.cost) await update($, cost, () => e.cost?.usd ?? null)
    if (e.changed.includes('context')) {
      const t = await $.clock.now()
      await update($, cacheAt, () => t)
      await update($, now, () => t)
    }
    await refreshStatus($, cfg)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A sub-agent's start is not a new turn: the main turn's counts, loop and timer go on.
    if (e.agentId !== undefined) return next(e)
    await update($, toolCounts, () => ({}))
    await update($, loopSince, () => null)
    await setMood($, 'working')
    return next(e)
  })

  // tool.call gates every tool, so the loop detector is best-effort: its .catch lets the
  // call through if counting fails or overruns the hook's budget.
  on('tool.call', async ($, e, next) => {
    await countCall($, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A real answer sets off the fireworks (with a bulb after a hard task); anything else but an
  // interrupt gets the storm. The hand-offs are worked out from the clock on each frame.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const t = await $.clock.now()
    const startedAt = (await read($, mood)) === 'working' ? await read($, moodAt) : t
    const solved = !e.isAborted && e.reason === 'answer'
    await update($, eureka, () => solved && t - startedAt >= HARD_SECONDS * 1000)
    await update($, loopSince, () => null)
    await setMood($, e.isAborted ? 'idle' : solved ? 'done' : 'error')
    return next(e)
  })

  // The band above the prompt: the spark on the left, a battery per usage window beside it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    svgBand = e.surface !== 'terminal'
    const { Box, Text } = $.ui.resolve(e)
    // What the mods beneath draw stays, under the spark's row: this band is shared.
    const below = await next(e)
    const { rl, enterprise, wins } = await planOf($, cfg)
    const spent = enterprise ? await read($, cost) : null
    const t = await read($, minute)
    const stored = await read($, mood)
    const m: Mood = e.props.isWorking ? 'working' : stored === 'working' ? 'idle' : stored
    const tFrame = await read($, frame)
    // When the band's mood is not the stored one (the UI says "working" before turn.start
    // lands, or the turn ended before turn.complete ran) there is no start time: run a
    // free clock that stays under HARD_SECONDS rather than counting from the epoch.
    const elapsed = m === stored ? (tFrame - (await read($, moodAt))) / 1000 : (tFrame / 1000) % HARD_SECONDS
    const loopAt = await read($, loopSince)
    const { mood: shown, t: sceneT } =
      e.props.isWorking && loopAt !== null
        ? { mood: 'loop' as Mood, t: Math.max(0, (tFrame - loopAt) / 1000) }
        : sceneFor(m, Math.max(0, elapsed))
    const idea = shown === 'done' && (await read($, eureka))

    const meters = wins.map(w => {
      const lim = rl.find(l => l.kind === w.kind)
      const at = t ? resetAt(w, lim, t) : null
      return { ...w, ...leftOf(lim), has: !!lim, resets: lim && at !== null && t ? `resets in ${until(at - t)}` : 'no reading yet' }
    })

    if (e.surface !== 'desktop' && e.surface !== 'vscode') {
      const row = (
        <Box flexDirection="row" flexWrap="wrap" gap={3}>
          <Text bold color="#ffb547">{faceFor(shown, sceneT, idea)}</Text>
          {meters.map(w => (
            <Box key={w.kind} flexDirection="row" gap={1}>
              <Text bold>{w.label}</Text>
              <Text color={w.has ? (w.over ? '#ff5a5a' : charge(w.left)) : undefined} dimColor={!w.has}>{`[${cellsText(w.left, w.over)}]`}</Text>
              <Text bold>{w.text}</Text>
              <Text dimColor>{w.resets}</Text>
            </Box>
          ))}
          {spent !== null ? <Text bold>{`${usd(spent)} this session`}</Text> : null}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {row}
          {below}
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })

    const row = (
      <Box flexDirection="row" alignItems="center" gap={2} paddingX={1}>
        <Svg
          source={sceneSvg(shown, sceneT, idea)}
          alt={`The spark is ${idea ? 'having a eureka moment' : ALT[shown]}`}
          width={SCENE_WIDTH}
          height={SCENE_HEIGHT}
        />
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" gap={3}>
          {meters.map(w => (
            <Box key={w.kind} flexDirection="row" alignItems="center" gap={1}>
              <Svg source={batterySvg(w.left, w.over)} alt={`${w.label}: ${w.text}`} width={BATTERY.width} height={BATTERY.height} />
              <Text bold>{`${w.label} ${w.text}`}</Text>
              <Text dimColor>{w.resets}</Text>
            </Box>
          ))}
          {spent !== null ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text bold>{usd(spent)}</Text>
              <Text dimColor>this session</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })

  // Beside the model picker: the cache bolt and the context capsule.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const { ttlMs } = await planOf($, cfg)
    const cache = cacheOf(await read($, cacheAt), await read($, now), ttlMs)
    const c = await read($, ctx)
    const pct = c?.percent
    const ctxLabel = pct === undefined ? 'ctx –' : `ctx ${pct}%${c?.tokens ? ` · ${tok(c.tokens)}/${tok(c.window)}` : ''}`
    // The engine's own drawing here (the mode labels, or another mod's take on them) stays beside ours.
    const below = await next(e)

    // SessionMode is raised on the terminal and desktop alone.
    if (e.surface !== 'desktop') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color={cache.warm ? cache.color : undefined} dimColor={!cache.warm}>{`ϟ ${cache.label}`}</Text>
          <Text dimColor>·</Text>
          <Text dimColor>{ctxLabel}</Text>
          {below}
        </Box>
      )
    }
    const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg source={boltSvg(cache.color)} alt="prompt cache" width={BOLT.width} height={BOLT.height} />
        <Text color={cache.warm ? cache.color : undefined} dimColor={!cache.warm}>{cache.label}</Text>
        <Text dimColor>·</Text>
        <Svg source={pillSvg(pct ?? 0)} alt="context used" width={PILL.width} height={PILL.height} />
        <Text dimColor>{ctxLabel}</Text>
        {below}
      </Box>
    )
  })
}
