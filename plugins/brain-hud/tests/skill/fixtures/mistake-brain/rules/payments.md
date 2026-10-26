# Payments rules

- Attach an idempotency key to any payment API call (charge, refund, renewal) before allowing a retry on timeout, failure, or ambiguous status — do not rely on the caller (including scheduled/background jobs) to dedupe after the fact.
