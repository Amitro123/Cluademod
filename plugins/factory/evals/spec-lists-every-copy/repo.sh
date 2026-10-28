#!/usr/bin/env bash
# D5: the rounding bug lives in src/money.ts and, under another name, in a standalone script.
set -euo pipefail
git init -q .
git config user.email eval@example.com
git config user.name eval
mkdir -p src scripts test .factory

cat > src/money.ts <<'TS'
// Prices are stored as numbers of dollars.
export function formatPrice(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  return `$${rounded.toFixed(2)}`
}

export function total(items: { price: number; qty: number }[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0)
}
TS

cat > src/cart.ts <<'TS'
import { formatPrice, total } from './money.js'

export function cartLine(items: { price: number; qty: number }[]): string {
  return `Total: ${formatPrice(total(items))}`
}
TS

cat > scripts/export-csv.js <<'JS'
#!/usr/bin/env node
// Nightly export of orders for accounting. Runs standalone (no build step), so it can't import src/.
const fs = require('fs')

function toCents(dollars) {
  return Math.round(dollars * 100)
}

const orders = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const o of orders) console.log(`${o.id},${(toCents(o.amount) / 100).toFixed(2)}`)
JS

cat > test/money.test.ts <<'TS'
import { test, expect } from 'vitest'
import { formatPrice } from '../src/money.js'

test('formats dollars', () => {
  expect(formatPrice(3)).toBe('$3.00')
})
TS

printf '{ "name": "shop", "scripts": { "test": "vitest run" } }\n' > package.json
git add -A
git commit -qm 'shop'
