# Workflow evidence identity

The Actions collector binds job evidence to the observed run ID, attempt,
repository and head commit. It fetches attempt-specific jobs sequentially after
reading the run, and refuses incomplete pagination or duplicate job IDs.
A concurrent rerun therefore cannot replace the selected attempt's job list.

Call `classifyWorkflowRun` with `{ expectedHeadSha: candidateSha }` when qualifying
a candidate. A malformed or mismatching full commit is rejected. Omitting that
option classifies the observed run only; it does not establish candidate freshness.
The result describes that observed attempt, not a promise that no later rerun exists.

Cross-organization carrier runs have their own head commit. Their run identity
must not be confused with the source candidate identity: use a separately verified
source checkout/artifact receipt before attributing carrier results to product code.
These checks do not override branch protection, review requirements, or the need
to verify that all required workflows and runtime lanes actually executed.
