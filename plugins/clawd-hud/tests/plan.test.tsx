import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PERSONAL = [
  { kind: 'five_hour', percentUsed: 34 },
  { kind: 'seven_day', percentUsed: 12 },
]
const ENTERPRISE = [
  { kind: 'seven_day', percentUsed: 41 },
  { kind: 'spend_limit', percentUsed: 63 },
]

// What the engine answers beneath the plugin: its clock, the session's usage, the UI's side calls.
function usage(on: On, rateLimits: { kind: string; percentUsed: number }[], usd = 1.5) {
  mock.clock(on, { now: Date.UTC(2026, 9, 9, 12) })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits, cost: { usd } } }) as never)
  on('session.start', () => ({ cwd: '.' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  // What sits beneath clawd-hud: another mod's band, or the engine's own mode labels.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'AbovePrompt' ? 'another mod band' : 'engine modes'}</Text>
  })
}

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.session.start({ cwd: '.' } as never)
  const ui = await $.ui.mount({
    plugin: 'clawd-hud',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} } as never,
  })
  return (await ui.findAll({ type: 'Text' })).map(t => String((t as { text?: string }).text ?? JSON.stringify(t))).join(' | ')
}

describe('plan', () => {
  test('auto: a spend limit switches to the enterprise windows and shows cost', async ($, on) => {
    usage(on, ENTERPRISE)
    const text = await band($)
    expect(text).toMatch(/7d/)
    expect(text).toMatch(/mo/)
    expect(text).toMatch(/37% left/)
    expect(text).toMatch(/\$1\.50 this session/)
    expect(text).not.toMatch(/5h/)
  })

  test('a spend cap past 100% reads "over by"', async ($, on) => {
    usage(on, [{ kind: 'seven_day', percentUsed: 41 }, { kind: 'spend_limit', percentUsed: 112 }])
    expect(await band($)).toMatch(/over by 12%/)
  })

  test('the desktop band draws the spark and enterprise batteries', async ($, on) => {
    usage(on, ENTERPRISE)
    const text = await band($, 'desktop')
    expect(text).toMatch(/7d 59% left/)
    expect(text).toMatch(/mo 37% left/)
  })

  test('auto: a personal account keeps 5h + 7d and no cost', async ($, on) => {
    usage(on, PERSONAL)
    const text = await band($)
    expect(text).toMatch(/5h/)
    expect(text).toMatch(/7d/)
    expect(text).not.toMatch(/this session/)
  })

  test('plan=enterprise forces the enterprise windows', { options: { plan: 'enterprise' } }, async ($, on) => {
    usage(on, PERSONAL)
    const text = await band($)
    expect(text).toMatch(/mo/)
    expect(text).not.toMatch(/5h/)
  })

  test('the monthly cap without a reset time counts down to the 1st of next month', async ($, on) => {
    usage(on, ENTERPRISE)
    expect(await band($)).toMatch(/resets in 2[123]d/)
  })
})

async function cacheLabel($: Engine, rateLimits: { kind: string; percentUsed: number }[]) {
  await $.session.start({ cwd: '.' } as never)
  await $.session.measure({ context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits, changed: ['context'] } as never)
  const ui = await $.ui.mount({ plugin: 'clawd-hud', surface: 'terminal', component: 'SessionMode', props: { modes: [] } as never })
  return (await ui.findAll({ type: 'Text' })).map(t => JSON.stringify(t)).join(' | ')
}

describe('cache timer', () => {
  test('auto TTL is 5 minutes on enterprise', async ($, on) => {
    usage(on, ENTERPRISE)
    on('session.measure', ($, e) => ({ changed: e.changed }) as never)
    expect(await cacheLabel($, ENTERPRISE)).toMatch(/cache 5:00/)
  })

  test('auto TTL is 1 hour on personal', async ($, on) => {
    usage(on, PERSONAL)
    on('session.measure', ($, e) => ({ changed: e.changed }) as never)
    expect(await cacheLabel($, PERSONAL)).toMatch(/cache 60:00/)
  })
})

describe('sharing its sites', () => {
  test('the band keeps what the mods beneath it draw, on both surfaces', async ($, on) => {
    usage(on, PERSONAL)
    expect(await band($, 'terminal')).toMatch(/another mod band/)
  })

  test('the desktop band keeps it too', async ($, on) => {
    usage(on, PERSONAL)
    expect(await band($, 'desktop')).toMatch(/another mod band/)
  })

  test("beside the model picker, the engine's own drawing stays", async ($, on) => {
    usage(on, PERSONAL)
    on('session.measure', ($, e) => ({ changed: e.changed }) as never)
    const text = await cacheLabel($, PERSONAL)
    expect(text).toMatch(/cache 60:00/)
    expect(text).toMatch(/engine modes/)
  })
})
