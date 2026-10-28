---
type: llm
focus: { source: file, path: .factory/fix-rounding.md }
---

PASS if the spec names scripts/export-csv.js (or its toCents function) as a second copy of the same rounding logic and says plainly whether it is in or out of this change's scope.
FAIL if it doesn't mention that copy, or mentions it without saying whether the change covers it.
