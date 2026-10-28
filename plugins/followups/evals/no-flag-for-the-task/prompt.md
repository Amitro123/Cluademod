---
description: The bug is the task itself. Claude answers it and doesn't flag it as a follow-up.
tags: [smoke]
max_turns: 8
---

Why does `applyDiscount(100, 20)` return -1900? Show the fixed line.

```js
export function applyDiscount(price, percent) {
  // percent is 0-100
  return price - price * percent;
}
```
