# Worker supervision and readiness

Tracking: DEN-3793. This is an operational hardening slice, not fleet activation.

The pool is healthy only while every configured worker is running, no fatal
infrastructure failure has occurred, and shutdown has not started. The HTTP
`/readyz` endpoint combines this state with application startup readiness.

A failed queue claim, heartbeat exception, lost lease, or failed durable queue
write makes the whole pool unhealthy immediately and stops new claims. A normal
review-engine error still follows the existing durable job retry policy. The
supervisor does not restart workers or make additional model calls in process;
the container runtime owns process restarts.

The first fatal failure starts orderly shutdown with a nonzero process exit
status. Active engines are allowed to drain; SQLite is closed only after all
workers settle. Shutdown is idempotent and has a 30-second deadline. If that
expires, the process exits without acknowledging outstanding jobs, allowing the
existing lease-expiry recovery mechanism to recover them after restart.

Heartbeat callbacks catch database exceptions rather than throwing into the
process event loop. After a heartbeat failure, the stale worker neither completes
nor reschedules that job, even if its engine subsequently returns.

## Validation

`node --test test/worker-supervision.test.mjs` exercises queue failures, lost
leases, heartbeat exceptions, sibling drain, healthy retries, pre-aborted startup,
invalid concurrency, callback errors, and the actual HTTP readiness endpoint.

## Remaining controls

This change is not a distributed publication fence: an already-running engine
may have made GitHub writes before heartbeat loss was detected. Fencing each
external write, repairing stale checks, and the failure-injection canary remain
separate DEN-3793 work. SQLite migrations/backups, HTTP retry bounds, and
Kubernetes deployment hardening are not completed by this slice. Keep fleet
rulesets and production activation gated on independent reviews and canary proof.
