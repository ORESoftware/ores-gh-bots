# GitHub Actions integration

`GHA_MODE` supports:

- `disabled`: no Actions interaction.
- `supplemental`: provider reviews run in the orchestrator; configured external CI contexts are included in the aggregate gate. When an Actions dispatcher credential is configured, the central review workflow is also dispatched as an independent recovery/audit lane.
- `offload`: the orchestrator dispatches `review-dispatch.yml` in the central repository. The restricted Actions App is preferred; `GHA_DISPATCH_TOKEN` is an explicit fallback.

The central workflow accepts only repository, pull-request number, installation ID, and head SHA. The runner re-fetches the PR and refuses to review if the SHA changed.

Any required workflow must include `merge_group` when merge queues are used.
