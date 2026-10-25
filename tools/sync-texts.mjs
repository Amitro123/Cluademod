// Copies shared/texts.ts into each mod that writes or reads that wording (a mod can import nothing
// outside its folder). `--check` only reports a copy that differs, and exits 1.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODS = ['followups', 'goal-run', 'brain-hud']
const source = readFileSync(join(root, 'shared/texts.ts'), 'utf8')
const copy = `// GENERATED from shared/texts.ts by tools/sync-texts.mjs: edit that file, not this one.\n${source}`
const check = process.argv.includes('--check')
let stale = 0
for (const mod of MODS) {
  const target = join(root, 'plugins', mod, 'hooks/texts.ts')
  const now = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (now === copy) continue
  if (check) {
    console.error(`stale: plugins/${mod}/hooks/texts.ts (run node tools/sync-texts.mjs)`)
    stale++
  } else {
    writeFileSync(target, copy)
    console.log(`wrote plugins/${mod}/hooks/texts.ts`)
  }
}
process.exit(stale ? 1 : 0)
