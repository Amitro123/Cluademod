# PARA classification — worked examples

Supplement to the decision tree in `router.md`. These are the ambiguous cases spelled out end-to-end.

The decision tree doesn't branch on entry `Type` — a `success`, `decision`, or `handoff` entry gets classified with exactly the same Project/Area/Resource/Archive questions as a `mistake` entry (see `router.md`'s intro). Examples 1-4 below all happen to be `mistake` entries because that's the type with the most historical examples to draw from, but the same reasoning applies unchanged to the other three types — see Example 5 for one worked non-mistake case.

Every PARA entry `router.md` writes carries its own `Added: YYYY-MM-DD HH:MM` field (see `router.md` step 4) — a per-entry timestamp independent of `MEMORY.md`'s per-file "last updated" date. It's what `dream.md` uses to tell a genuinely stale file apart from a stale file that just got one recent entry, and to notice when a burst of entries in a narrow time window hints a file should be split. None of the classification logic below depends on it — it's a freshness signal for `dream`, not a routing input.

## Example 1 — Project vs. Area

> Entry: "Used the wrong env var name for the payments API key while working on the checkout-v2 branch."

Tempting to call this a Project lesson because it happened while working on `checkout-v2`. But ask the router.md test question: *will this lesson matter once checkout-v2 ships?* Yes — the payments API will still exist and still use that env var name in every future project that touches it. → **Area**: `.agent-brain/shared/Areas/payments.md` (or `env-config.md` if there isn't yet a payments-specific area).

Contrast with: "Forgot that checkout-v2's feature flag defaults to off in staging." That fact is meaningless once checkout-v2 ships or gets deleted. → **Project**: `.agent-brain/shared/Projects/checkout-v2.md`.

## Example 2 — Area vs. Resource

> Entry A: "Our auth service returns HTTP 200 with an error field in the body on failed login, instead of a 4xx status."
> Entry B: "Trusted an HTTP 200 status code as success without checking the response body, and missed a failure."

These look similar but route differently. Entry A names a specific system (`our auth service`) — it's an **Area** lesson (`Areas/auth.md`): true about this codebase, not a universal law. Entry B, if it shows up independently against a *different* service later, is evidence of a general principle — that's when it becomes a **Resource** (`Resources/dont-trust-status-codes-alone.md`). Don't manufacture the Resource from a single Area instance; wait for it to actually recur across contexts (which `/brain-hud:mistake-brain dream` is well-positioned to notice, since it looks across all Areas at once).

## Example 3 — Archive

> Entry: "Deploy failed because the CDN provider had a regional outage."

Not a code problem, not something a rule can prevent, and the specific provider/outage won't recur in a way future guidance can act on. → **Archive**: `.agent-brain/shared/Archives/2026/2026-08-cdn-outage.md`. Still worth keeping — if it ever happens again, it stops looking like a fluke — but it shouldn't clutter Areas where it would look like an actionable, recurring problem.

## Example 4 — Genuinely spans two categories

> Entry: "In the checkout-v2 branch, retried a failed payment call without idempotency, causing a double charge."

This is simultaneously a Project fact (happened in checkout-v2) and hints at a general principle (retries need idempotency keys). Per router.md: route to the more specific bucket first — **Project**, `Projects/checkout-v2.md` — and let it prove itself general later. If the same root cause (retrying non-idempotent operations) shows up again in a different project or area, that's when `/brain-hud:mistake-brain promote` or `/brain-hud:mistake-brain dream` should surface it as a Resource/rule candidate, not before.

## Example 5 — a non-mistake type (Area)

> Entry: `Type: decision` — "Chose polling over a webhook for the CI status check because no public endpoint was reachable in this environment."

Same test as Example 1: is this tied to a specific piece of work that ends when the work ends, or a domain the agent will keep coming back to? CI status checking isn't specific to any one project — it'll come up again the next time a CI-integration decision needs making, in whatever project is current then. → **Area**: `.agent-brain/shared/Areas/ci.md`. The `Type` field didn't change the reasoning at all — only the field being routed (`Rationale`, per `format-spec.md`'s `decision` template) differs from a `mistake` entry's `Root cause`.
