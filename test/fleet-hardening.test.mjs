import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSqlNamespace,
  organizationPolicyDocument,
  upsertRepositoryTextFile,
  validateHardeningFleet,
} from '../packages/github/src/hardening.mjs';

const fleet = {
  api_version: 'ores.dev/fleet-hardening/v1',
  central: { policy_repository: 'ORESoftware/ores-gh-bots' },
  defaults: {
    policy_repository: '.github',
    policy_path: 'policy/ores-fleet-hardening.v1.json',
    repository_scope: { include: ['*'], exclude: ['*-archive'] },
    required_capabilities: ['security', 'sql-namespaces'],
    required_checks: ['ores-review/gate'],
    repository_roles: ['interfaces', 'lib-core', 'infra', 'e2e'],
    sql: { registry_repository: 'declarative-migrations/declarative-postgres-migrate.rs' },
    infrastructure: { k8s_cluster_repository: 'ORESoftware/k8s-cluster' },
    observability: { repository: 'ores-otel/ores-otel' },
    dependency_management: { repository: 'zed-pkg/zed-cli' },
    promotion: { strategy: 'test-org-first' },
  },
  organizations: [{ name: 'chapter-publishing', namespace: 'chapter_publishing' }],
};

test('SQL namespaces are deterministic, portable, and bounded', () => {
  assert.equal(normalizeSqlNamespace('3FA-app'), 'org_3fa_app');
  assert.equal(normalizeSqlNamespace('Chapter Publishing Test'), 'chapter_publishing_test');
  assert.ok(normalizeSqlNamespace('x'.repeat(100)).length <= 63);
});

test('fleet validation rejects duplicate organization identities', () => {
  assert.throws(() => validateHardeningFleet({
    ...fleet,
    organizations: [{ name: 'A' }, { name: 'a' }],
  }), /Duplicate organization/);
});

test('organization policy merges defaults with namespace-specific settings', () => {
  const policy = organizationPolicyDocument(fleet, {
    name: 'chapter-publishing',
    namespace: 'chapter_publishing',
    infrastructure: { namespace: 'chapter-publishing' },
  });
  assert.equal(policy.metadata.sql_namespace, 'chapter_publishing');
  assert.equal(policy.spec.infrastructure.namespace, 'chapter-publishing');
  assert.equal(policy.spec.infrastructure.k8s_cluster_repository, 'ORESoftware/k8s-cluster');
});

test('file upsert is idempotent when canonical text is unchanged', async () => {
  const client = {
    async request(method) {
      assert.equal(method, 'GET');
      return { data: { type: 'file', sha: 'abc', path: 'policy.json', content: Buffer.from('{"ok":true}\n').toString('base64') } };
    },
  };
  const result = await upsertRepositoryTextFile(client, 'token', {
    owner: 'o', repo: 'r', path: 'policy.json', content: '{"ok":true}', message: 'x', dryRun: false,
  });
  assert.equal(result.action, 'unchanged');
});
