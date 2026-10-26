# payments

## [2026-08-14] [test fixture] Refund retry attempted a duplicate refund
Attach an idempotency key to any payment API call before allowing a retry, and check operation status before retrying on ambiguous failures.
Source: mistake log entry [2026-08-14 22:05] [test fixture] Refund retry attempted a duplicate refund

## [2026-08-14] [test fixture] Subscription renewal retry duplicated a charge
Attach an idempotency key to any payment API call before allowing a retry, including scheduled/background jobs.
Source: mistake log entry [2026-08-14 22:03] [test fixture] Subscription renewal retry duplicated a charge

## [2026-08-14] [test fixture] Checkout payment retry duplicated a charge
Attach an idempotency key to any payment API call before allowing a timeout-triggered retry.
Source: mistake log entry [2026-08-14 22:01] [test fixture] Checkout payment retry duplicated a charge
