# Fixture entries — mistake-brain promote-gate validation

These 6 entries were originally written directly into the real `MISTAKES.md` to exercise `/mistake-brain promote`'s approval gate end-to-end (both the interactive-confirm branch and the `AGENT_AUTO_IMPROVE=1` branch) during initial development. Relocated here on review, since production-facing files (`MISTAKES.md`, `CLAUDE.md`, `.claude/rules/`, `.agent-brain/`) shouldn't contain synthetic data. Format and content are otherwise unchanged from the original exercise — same dates, same `[test fixture]` titles, same root-cause phrasing (needed for `check_repetition.py`'s clustering to still make sense as a worked example).

One correction from the original run, noted here rather than silently: the CI cluster was originally promoted to `CLAUDE.md`'s Rules section, which contradicted `promote.md`'s own scope rubric (a rule naming a specific system — "the CI retry wrapper" — is Area-scoped, same as payments, not global). See `../mistake-brain-skill.md`-equivalent commentary in the real `MISTAKES.md` (2026-08-14 23:10 entry) for the full account. Below, both clusters are shown with their *corrected* `PARA route` — Area-scoped, pointing at `rules/payments.md` and `rules/ci.md` in this same fixtures directory.

## [2026-08-14 22:14] [test fixture] E2E test retry hit a locked seed-data fixture
- **What happened:** An E2E test retried by the CI wrapper failed again because the seed-data fixture it needed was still locked by the previous (still-cleaning-up) attempt.
- **Root cause:** The CI retry wrapper retries a failed test immediately without checking whether a shared resource lock (the seed-data fixture lock) from the previous attempt has been released.
- **Consequence:** Another wasted CI cycle before the real underlying failure was investigated.
- **Prevention rule:** Before retrying a flaky test that touches a shared resource, wait for confirmation the previous attempt's lock has been released.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/ci.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/ci.md)

## [2026-08-14 22:12] [test fixture] Migration test retry collided with in-progress migration
- **What happened:** The CI retry wrapper retried a failed migration test while the prior attempt's migration was still rolling back, causing a schema-lock collision.
- **Root cause:** The CI retry wrapper retries a failed test immediately without checking whether a shared resource lock (here, the migration lock) from the previous attempt has been released.
- **Consequence:** The retry also failed, doubling the time to get a real signal on the original failure.
- **Prevention rule:** Before retrying a flaky test that touches a shared resource, wait for confirmation the previous attempt's lock has been released.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/ci.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/ci.md)

## [2026-08-14 22:10] [test fixture] Integration test retried into a stale DB lock
- **What happened:** A flaky integration test was retried automatically by the CI retry wrapper, but the previous attempt's DB transaction lock hadn't been released yet, causing a lock-timeout failure on the retry too.
- **Root cause:** The CI retry wrapper retries a failed test immediately without checking whether a shared resource lock from the previous attempt has been released.
- **Consequence:** Wasted CI minutes; had to re-run the whole job manually with a longer delay.
- **Prevention rule:** Before retrying a flaky test that touches a shared resource, wait for confirmation the previous attempt's lock has been released.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/ci.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/ci.md)

## [2026-08-14 22:05] [test fixture] Refund retry attempted a duplicate refund
- **What happened:** A refund call that appeared to fail (but had actually succeeded server-side) was retried, issuing a second refund.
- **Root cause:** Retried a payment API call after an ambiguous failure without an idempotency key, so the gateway could not tell the retry was the same request.
- **Consequence:** Over-refunded a customer; required manual finance reconciliation.
- **Prevention rule:** Attach an idempotency key to any payment API call before allowing a retry, and check operation status before retrying on ambiguous failures.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/payments.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/payments.md)

## [2026-08-14 22:03] [test fixture] Subscription renewal retry duplicated a charge
- **What happened:** A renewal job retried a failed subscription charge and the customer was billed twice for the same period.
- **Root cause:** Retried a payment API call after a failure without an idempotency key, identical to the checkout case but in the renewal job.
- **Consequence:** Customer flagged the double charge; had to be reconciled and refunded.
- **Prevention rule:** Attach an idempotency key to any payment API call before allowing a retry, including scheduled/background jobs.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/payments.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/payments.md)

## [2026-08-14 22:01] [test fixture] Checkout payment retry duplicated a charge
- **What happened:** After a timeout on the payment gateway call during checkout, the request was retried automatically and the customer was charged twice.
- **Root cause:** Retried a payment API call after a timeout without attaching an idempotency key, so the gateway processed it as a new charge.
- **Consequence:** Customer had to be refunded manually; support ticket opened.
- **Prevention rule:** Attach an idempotency key to any payment API call before allowing a timeout-triggered retry.
- **PARA route:** Area: tests/fixtures/mistake-brain/agent-brain/claude/Areas/payments.md
- **Status:** promoted (tests/fixtures/mistake-brain/rules/payments.md)
