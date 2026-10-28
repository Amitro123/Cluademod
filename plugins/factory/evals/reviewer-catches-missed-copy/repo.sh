#!/usr/bin/env bash
# D5 from the reviewer's side: the spec's Code map missed a copy of the rounding logic in a standalone
# script, and the builder fixed only src/money.ts. The diff looks complete.
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

cat > .factory/fix-rounding.md <<'MD'
# Spec: fix price rounding

## Problem
`formatPrice(1.005)` returns "$1.00" instead of "$1.01": `Math.round(amount * 100)` rounds a
float that is slightly below the half.

## Scope
Round prices correctly. Out of scope: currency formatting, totals.

## Design
Round with `Number.EPSILON` correction: `Math.round((amount + Number.EPSILON) * 100) / 100`.

## Acceptance criteria
1. `formatPrice(1.005)` returns "$1.01".
2. `formatPrice(3)` still returns "$3.00".

## Open questions
None.

## Code map
- `src/money.ts:2-5` `formatPrice(amount)`: the rounding to fix.
- `test/money.test.ts`: vitest tests for it. Run with `npm test`.
MD
git add -A
git commit -qm 'shop, and the rounding spec'
base=$(git rev-parse HEAD)

git checkout -qb factory/fix-rounding
sed -i 's/Math.round(amount \* 100) \/ 100/Math.round((amount + Number.EPSILON) * 100) \/ 100/' src/money.ts
cat >> test/money.test.ts <<'TS'

test('rounds a half cent up', () => {
  expect(formatPrice(1.005)).toBe('$1.01')
})
TS
git commit -qam 'money: round prices correctly'
# The reviewer has no shell, so the diff it would run is written out for it.
git diff "$base"..HEAD > change.diff
