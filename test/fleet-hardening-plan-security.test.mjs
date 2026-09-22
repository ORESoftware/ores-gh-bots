import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  applyFleetHardeningPlan,
  buildFleetHardeningPlan,
  fleetHardeningDigest,
  fleetHardeningPlanDigest,
  repositoryInHardeningScope,
  validateFleetHardeningCanaryReceipt,
  validateFleetHardeningPlan,
} from '../packages/github/src/index.mjs';

const HEAD = 'a'.repeat(40);
const BRANCH_HEAD = 'b'.repeat(40);
const IMPLEMENTATION = `sha256:${'c'.repeat(64)}`;
const canonicalText = (value) => `${String(value).replace(/\r\n/gu, '\n').replace(/\s+$/u, '')}\n`;
const contentDigest = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;

function fleet() {
  return {
    api_version: 'ores.dev/fleet-hardening/v1',
    central: { policy_repository: 'ORESoftware/ores-gh-bots' },
    defaults: {
      policy_repository: '.github',
      policy_path: 'policy/ores-fleet-hardening.v1.json',
      repository_policy_path: '.ores/repository-hardening.v1.json',
      repository_scope: {
        include: ['svc-*'],
        exclude_name_patterns: ['-archive$'],
        skip_archived: true,
        skip_disabled: true,
        skip_forks: true,
      },
      required_capabilities: ['security'],
      required_checks: ['ores-review/gate'],
      repository_roles: ['api-server.rs'],
      sql: {},
      infrastructure: {},
      observability: {},
      dependency_management: {},
      promotion: { strategy: 'test-org-first' },
    },
    organizations: [
      {
        name: 'example-test',
        namespace: 'example',
        environment: 'test',
        production_organization: 'example',
      },
      {
        name: 'example',
        namespace: 'example',
        environment: 'production',
        test_organization: 'example-test',
      },
    ],
  };
}

function planFor(fleetValue = fleet()) {
  const content = canonicalText('{"ok":true}');
  const plan = {
    schema: 'ores.fleet-hardening-plan.v1',
    source_revision: HEAD,
    implementation_sha256: IMPLEMENTATION,
    config_sha256: fleetHardeningDigest(fleetValue),
    organization: 'example-test',
    environment: 'test',
    include_repositories: true,
    operation_count: 1,
    operations: [{
      repository: 'example-test/svc-api',
      default_branch: 'main',
      expected_head_sha: HEAD,
      path: '.ores/repository-hardening.v1.json',
      content,
      content_sha256: contentDigest(content),
      previous_blob_sha: null,
    }],
  };
  return plan;
}

function validate(plan, fleetValue = fleet()) {
  return validateFleetHardeningPlan(plan, {
    expectedDigest: fleetHardeningPlanDigest(plan),
    fleet: fleetValue,
    implementationDigest: IMPLEMENTATION,
    expectedEnvironment: 'test',
  });
}

test('repository scope excludes forks, archived, disabled, non-includes and exclusion matches', () => {
  const scope = fleet().defaults.repository_scope;
  assert.equal(repositoryInHardeningScope(scope, { name: 'svc-api' }), true);
  assert.equal(repositoryInHardeningScope(scope, { name: 'svc-api', fork: true }), false);
  assert.equal(repositoryInHardeningScope(scope, { name: 'svc-api', archived: true }), false);
  assert.equal(repositoryInHardeningScope(scope, { name: 'svc-api', disabled: true }), false);
  assert.equal(repositoryInHardeningScope(scope, { name: 'web-ui' }), false);
  assert.equal(repositoryInHardeningScope(scope, { name: 'svc-old-archive' }), false);
});

test('blank organization fails closed before GitHub discovery', async () => {
  let calls = 0;
  const client = { async request() { calls += 1; throw new Error('must not call'); } };
  await assert.rejects(
    buildFleetHardeningPlan(client, 'token', fleet(), {
      organizationName: '',
      expectedEnvironment: 'test',
      sourceRevision: HEAD,
      implementationDigest: IMPLEMENTATION,
    }),
    /one explicit --organization/,
  );
  assert.equal(calls, 0);
});

test('reviewed plan rejects fleet config drift', () => {
  const original = fleet();
  const plan = planFor(original);
  const changed = fleet();
  changed.defaults.required_checks = ['ores-review/gate', 'ci/verify'];
  assert.throws(
    () => validateFleetHardeningPlan(plan, {
      expectedDigest: fleetHardeningPlanDigest(plan),
      fleet: changed,
      implementationDigest: IMPLEMENTATION,
      expectedEnvironment: 'test',
    }),
    /config drifted/,
  );
});

test('reviewed plan rejects implementation drift', () => {
  const plan = planFor();
  assert.throws(
    () => validateFleetHardeningPlan(plan, {
      expectedDigest: fleetHardeningPlanDigest(plan),
      fleet: fleet(),
      implementationDigest: `sha256:${'d'.repeat(64)}`,
      expectedEnvironment: 'test',
    }),
    /implementation drifted/,
  );
});

test('apply argument cannot substitute a different digest after validation', async () => {
  const plan = planFor();
  const validated = validate(plan);
  let calls = 0;
  await assert.rejects(
    applyFleetHardeningPlan(
      { async request() { calls += 1; throw new Error('must not call'); } },
      async () => 'token',
      validated,
      { planDigest: `sha256:${'e'.repeat(64)}`, changeTicket: 'HARDEN-1' },
    ),
    /does not match the validated reviewed plan/,
  );
  assert.equal(calls, 0);
});

test('existing deterministic branch is rejected when it contains an unreviewed path', async () => {
  const plan = planFor();
  const validated = validate(plan);
  const digest = fleetHardeningPlanDigest(plan);
  const client = {
    async request(method, path) {
      assert.equal(method, 'GET');
      if (path.includes('/git/ref/heads/')) return { data: { object: { sha: BRANCH_HEAD } } };
      if (path.includes('/compare/')) {
        return { data: { files: [
          { filename: '.ores/repository-hardening.v1.json' },
          { filename: '.github/workflows/evil.yml' },
        ] } };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  await assert.rejects(
    applyFleetHardeningPlan(client, async () => 'token', validated, { planDigest: digest, changeTicket: 'HARDEN-2' }),
    /contains changes outside the reviewed plan/,
  );
});

test('exact existing proposal branch and open PR are reused without writes', async () => {
  const plan = planFor();
  const validated = validate(plan);
  const digest = fleetHardeningPlanDigest(plan);
  const content = plan.operations[0].content;
  let writes = 0;
  const client = {
    async request(method, path) {
      if (method !== 'GET') writes += 1;
      if (path.includes('/compare/')) {
        return { data: { files: [{ filename: '.ores/repository-hardening.v1.json' }] } };
      }
      if (path.includes('/git/ref/heads/')) {
        if (path.endsWith('/main')) return { data: { object: { sha: HEAD } } };
        return { data: { object: { sha: BRANCH_HEAD } } };
      }
      if (path.includes('/contents/')) {
        return { data: {
          type: 'file',
          sha: 'blob',
          path: '.ores/repository-hardening.v1.json',
          content: Buffer.from(content).toString('base64'),
        } };
      }
      if (path.includes('/pulls?state=open')) {
        return { data: [{ number: 12, html_url: 'https://github.test/example-test/svc-api/pull/12' }] };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const result = await applyFleetHardeningPlan(client, async () => 'token', validated, {
    planDigest: digest,
    changeTicket: 'HARDEN-3',
  });
  assert.equal(result.ok, true);
  assert.equal(result.ledger[0].action, 'reused');
  assert.equal(result.ledger[0].pull_request, 12);
  assert.equal(writes, 0);
});

test('production canary receipt must match configured test-production pair', () => {
  const fleetValue = fleet();
  const receipt = {
    schema: 'ores.fleet-hardening-canary.v1',
    status: 'passed',
    test_organization: 'wrong-test',
    production_organization: 'example',
    config_sha256: fleetHardeningDigest(fleetValue),
    pull_request: 9,
    head_sha: HEAD,
  };
  assert.throws(
    () => validateFleetHardeningCanaryReceipt(receipt, {
      expectedDigest: fleetHardeningDigest(receipt),
      fleet: fleetValue,
      productionOrganization: 'example',
    }),
    /test organization does not match production pairing/,
  );
});
