# Operations

## Health endpoints

- `GET /healthz`: process is alive.
- `GET /readyz`: queue is open and required configuration is present.
- `GET /metrics`: Prometheus text metrics.

## Manual review

A repository collaborator with write-or-higher permission can comment `/ores-review` on a pull request. `/ores-review gate` reevaluates only the aggregate gate.

## Recovery

The reconciler periodically enumerates App installations, installed repositories, and open pull requests. It queues a review when the current SHA is missing either provider result and queues a gate repair when provider results exist but the gate is missing or stale.

## Queue

SQLite runs in WAL mode. Production uses a single orchestrator replica and a persistent volume. Horizontal scaling requires replacing the queue adapter with a shared transactional backend.
