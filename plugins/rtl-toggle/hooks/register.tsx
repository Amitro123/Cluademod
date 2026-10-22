import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { toRtl } from './rtl'

// Session-scoped toggle state (NOT a module-level variable, which would be
// lost on hot reload). Declared in ../types/index.d.ts under 'rtl-toggle'.
const rtlEnabled = atom({ plugin: 'rtl-toggle', key: 'enabled' } as const, false)

// The live claude-code.d.ts exposes no layout-level direction prop on Box,
// Text or Markdown, so affected lines get a leading RLM instead (see rtl.ts).

const statusText = (enabled: boolean) => (enabled ? 'RTL: on (עברית: פעיל)' : 'RTL: off (עברית: כבוי)')

export const register: Register = on => {
  // `/rtl` works on every surface, including those that draw no band above the
  // prompt (VS Code, mobile): `/rtl` toggles, `/rtl on|off` sets, `/rtl status` reports.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rtl',
      description: 'Toggle RTL layout for mixed Hebrew/Arabic and English messages',
      argumentHint: '[on|off|status]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'rtl' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'status') return { text: statusText(await read($, rtlEnabled)) }
    if (arg && arg !== 'on' && arg !== 'off' && arg !== 'toggle') {
      return { text: `Unknown argument "${arg}". Usage: /rtl [on|off|status]` }
    }
    await update($, rtlEnabled, v => (arg === 'on' ? true : arg === 'off' ? false : !v))
    return { text: statusText(await read($, rtlEnabled)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Compose with whatever sits beneath (surveys, other mods) instead of
    // replacing it: a hook that answers without `next` suppresses them.
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const enabled = await read($, rtlEnabled)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {below}
        <Box justifyContent="flex-end">
          <Button
            key="rtl-toggle"
            label={enabled ? 'עברית: פעיל' : 'עברית: כבוי'}
            variant="primary"
            onPress={() => update($, rtlEnabled, v => !v)}
          />
        </Box>
      </Box>
    )
  })

  for (const component of ['UserMessage', 'AssistantMessage'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      if (!(await read($, rtlEnabled))) return next(e)

      return next({ ...e, props: { ...e.props, text: toRtl(e.props.text, { tableCells: e.surface !== 'terminal' }) } })
    })
  }
}
