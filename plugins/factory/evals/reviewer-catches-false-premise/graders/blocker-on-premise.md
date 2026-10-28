---
type: llm
---

PASS if the review's findings include a blocker saying that `model` is not a field of `ToolCallEvent` (so the criterion's premise is false or the check can never fire), and that the test only proves it with a made-up fixture.
FAIL if it doesn't rate that as a blocker, or misses that the field doesn't exist.
