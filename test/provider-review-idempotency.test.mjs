import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  attestationPublicationId,
  providerReviewAttemptId,
  providerReviewExternalId,
  providerReviewReceiptMarker,
  recoverProviderReviewFromCheck,
  reviewPublicationMarker,
  parseReviewPublicationMarkers,
} from '../packages/core/src/index.mjs';
import { ensureReviewAttemptCheck, findExactAppCheckRun } from '../packages/github/src/index.mjs';

const HEAD = 'a'.repeat(40);
const job = Object.freeze({
  id: 17,
  dedupeKey: `review:o/r:7:${HEAD}`,
  owner: 'O',
  repo: 'R',
  prNumber: 7,
  attempts: 1,
});

function check({ id = 41, appId = 101, externalId, headSha = HEAD, status = 'in_progress', conclusion = null, output = {} } = {}) {
  return {
    id,
    name: 'ores-review/openai',
    app: { id: appId },
    external_id: externalId,
    head_sha: headSha,
    status,
    conclusion,
    output,
  };
}

test('logical provider attempt is stable across queue retries but changes for a forced job', () => {
  const first = providerReviewAttemptId({ job, provider: 'openai', headSha: HEAD });
  const retry = providerReviewAttemptId({ job: { ...job, attempts: 8 }, provider: 'openai', headSha: HEAD });
  const forced = providerReviewAttemptId({
    job: { ...job, dedupeKey: `${job.dedupeKey}:force:12345678-1234-1234-1234-123456789abc` },
    provider: 'openai',
    headSha: HEAD,
  });
  assert.equal(first, retry);
  assert.notEqual(first, forced);
  assert.match(providerReviewExternalId({ job, provider: 'openai', headSha: HEAD }), new RegExp(`^openai:o/r#7@${HEAD}:attempt:[0-9a-f]{32}$`));
});

test('exact Check Run lookup ignores foreign Apps and stale heads', async () => {
  const externalId = providerReviewExternalId({ job, provider: 'openai', headSha: HEAD });
  const client = {
    async request(method, path) {
      assert.equal(method, 'GET');
      assert.match(path, /filter=all/u);
      return { data: { check_runs: [
        check({ id: 50, appId: 999, externalId }),
        check({ id: 51, appId: 101, externalId, headSha: 'b'.repeat(40) }),
        check({ id: 52, appId: 101, externalId }),
      ] } };
    },
  };
  const found = await findExactAppCheckRun(client, 'token', 'O', 'R', HEAD, 'ores-review/openai', {
    externalId,
    expectedAppId: 101,
  });
  assert.equal(found.id, 52);
});

test('duplicate exact trusted Check Runs fail closed', async () => {
  const externalId = providerReviewExternalId({ job, provider: 'openai', headSha: HEAD });
  const client = {
    async request() {
      return { data: { check_runs: [
        check({ id: 52, appId: 101, externalId }),
        check({ id: 53, appId: 101, externalId }),
      ] } };
    },
  };
  await assert.rejects(
    findExactAppCheckRun(client, 'token', 'O', 'R', HEAD, 'ores-review/openai', {
      externalId,
      expectedAppId: 101,
    }),
    /Duplicate trusted Check Runs/u,
  );
});

test('completed exact attempt is reused without creating another Check Run', async () => {
  const externalId = providerReviewExternalId({ job, provider: 'openai', headSha: HEAD });
  let writes = 0;
  const existing = check({
    id: 61,
    appId: 101,
    externalId,
    status: 'completed',
    conclusion: 'success',
    output: { summary: `${providerReviewReceiptMarker({ verdict: 'approve', risk: 'low', confidence: 0.93 })}\nLooks good.` },
  });
  const client = {
    async request(method) {
      if (method !== 'GET') writes += 1;
      return { data: { check_runs: [existing] } };
    },
  };
  const reused = await ensureReviewAttemptCheck({
    client,
    token: 'token',
    owner: 'O',
    repo: 'R',
    headSha: HEAD,
    name: 'ores-review/openai',
    externalId,
    expectedAppId: 101,
    summary: 'reviewing',
  });
  assert.equal(reused.id, 61);
  assert.equal(reused.reusedCompleted, true);
  assert.equal(writes, 0);
  const recovered = recoverProviderReviewFromCheck(reused);
  assert.equal(recovered.verdict, 'approve');
  assert.equal(recovered.confidence, 0.93);
  assert.equal(recovered.checkRunId, 61);
});

test('malformed or conclusion-mismatched provider receipt never recovers', () => {
  assert.equal(recoverProviderReviewFromCheck(check({ status: 'completed', conclusion: 'success', output: { summary: 'plain text' } })), null);
  const marker = providerReviewReceiptMarker({ verdict: 'request_changes', risk: 'high', confidence: 0.8 });
  assert.equal(recoverProviderReviewFromCheck(check({ status: 'completed', conclusion: 'success', output: { summary: `${marker}\nBlocked.` } })), null);
});

test('attestation publication identity binds both provider Check Run ids', () => {
  const base = {
    owner: 'O', repo: 'R', prNumber: 7, headSha: HEAD,
    reviews: { openai: { checkRunId: 101 }, claude: { checkRunId: 202 } },
  };
  const id = attestationPublicationId(base);
  assert.match(id, /^[0-9a-f]{32}$/u);
  assert.equal(id, attestationPublicationId(base));
  assert.notEqual(id, attestationPublicationId({ ...base, reviews: { ...base.reviews, claude: { checkRunId: 203 } } }));
  const marker = reviewPublicationMarker({ publicationId: id, headSha: HEAD });
  assert.deepEqual(parseReviewPublicationMarkers(marker), [{ id, headSha: HEAD }]);
});

test('offload workflow carries the durable logical attempt id into the runner', async () => {
  const workflow = await readFile(new URL('../.github/workflows/review-dispatch.yml', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../apps/runner/src/main.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /attempt_id:/u);
  assert.match(workflow, /REVIEW_ATTEMPT_ID: \$\{\{ inputs\.attempt_id \}\}/u);
  assert.match(workflow, /inputs\.attempt_id/u);
  assert.match(runner, /cli\.env\.REVIEW_ATTEMPT_ID/u);
  assert.match(runner, /attemptId,/u);
});
