# CI rules

- Before retrying a flaky test that touches a shared resource (a DB lock, a migration, a seed-data fixture), wait for confirmation the previous attempt's lock has been released instead of retrying immediately.
