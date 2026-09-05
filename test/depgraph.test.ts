import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  disturbanceSet,
  parseGitmodules,
  parseZpkgToml,
  repoFromGitUrl,
  resolveZedDep,
} from '../src/depgraph.ts';
import { disturbedSince } from '../src/reconcile.ts';

describe('zpkg manifest parsing', () => {
  test('reads sections, plain values and inline tables', () => {
    const t = parseZpkgToml(`
# a comment
[package]
name = "sonus-auris-cli"
version = "0.3.1"

[dependencies]
sonus-auris-lib = { version = "1.2.3", features = ["x"] }
zed-sync = "0.4.0"
opto-sync-clients = { repo = "opto-sync/opto-sync-clients", version = "2.0.0" }
`);
    assert.equal(t.package?.name, 'sonus-auris-cli');
    assert.equal(t.dependencies?.['sonus-auris-lib'], '1.2.3');
    assert.equal(t.dependencies?.['zed-sync'], '0.4.0');
  });

  test('trailing comments do not leak into values', () => {
    const t = parseZpkgToml('[dependencies]\nfoo = "1.0.0" # pinned deliberately\n');
    assert.equal(t.dependencies?.foo, '1.0.0');
  });

  test('empty input yields no sections', () => {
    assert.deepEqual(parseZpkgToml(''), {});
  });
});

describe('git remotes and submodules', () => {
  test('parses .gitmodules', () => {
    const mods = parseGitmodules(`
[submodule "apps/web"]
	path = apps/web
	url = git@github.com:sonus-auris/sonus-auris-web-server.rs.git
[submodule "apps/api"]
	path = apps/api
	url = https://github.com/sonus-auris/sonus-auris-api-server.rs
`);
    assert.equal(mods.length, 2);
    assert.equal(mods[0]?.path, 'apps/web');
  });

  test('extracts owner/repo from every remote spelling we use', () => {
    assert.equal(repoFromGitUrl('git@github.com:zed-pkg/zed-lib.git'), 'zed-pkg/zed-lib');
    assert.equal(repoFromGitUrl('https://github.com/zed-pkg/zed-lib'), 'zed-pkg/zed-lib');
    assert.equal(repoFromGitUrl('https://github.com/zed-pkg/zed-lib.git'), 'zed-pkg/zed-lib');
    assert.equal(repoFromGitUrl('ssh://git@github.com/zed-pkg/zed-lib.git'), 'zed-pkg/zed-lib');
    assert.equal(repoFromGitUrl('not a url'), null);
  });

  test('repo names containing dots survive', () => {
    assert.equal(
      repoFromGitUrl('git@github.com:sonus-auris/sonus-auris-web-server.rs.git'),
      'sonus-auris/sonus-auris-web-server.rs',
    );
  });
});

describe('dependency resolution and disturbance', () => {
  const known = new Set(['zed-pkg/zed-lib', 'zed-pkg/zed-cli', 'sonus-auris/sonus-auris-lib']);

  test('an explicit repo spec wins', () => {
    assert.equal(resolveZedDep('anything', 'zed-pkg/zed-lib', known), 'zed-pkg/zed-lib');
  });

  test('falls back to matching the package name to a repo name', () => {
    assert.equal(resolveZedDep('zed-cli', '1.0.0', known), 'zed-pkg/zed-cli');
  });

  test('an unknown dependency resolves to nothing rather than a guess', () => {
    assert.equal(resolveZedDep('some-third-party-crate', '1.0.0', known), null);
  });

  test('self-edges are dropped', () => {
    const g = buildGraph([{ from: 'o/a', to: 'o/a', kind: 'zed', spec: null }]);
    assert.deepEqual(g.dependenciesOf('o/a'), []);
  });

  test('disturbance reaches dependents-of-dependents but not the repo itself', () => {
    const g = buildGraph([
      { from: 'o/cli', to: 'o/lib', kind: 'zed', spec: null },
      { from: 'o/app', to: 'o/cli', kind: 'zed', spec: null },
      { from: 'o/lib', to: 'o/core', kind: 'zed', spec: null },
    ]);
    const set = disturbanceSet(g, 'o/lib');
    assert.ok(set.includes('o/core'), 'direct dependency');
    assert.ok(set.includes('o/cli'), 'direct dependent');
    assert.ok(set.includes('o/app'), 'dependent of dependent');
    assert.ok(!set.includes('o/lib'), 'never itself');
  });

  test('only neighbours pushed AFTER the PR last moved count as disturbance', () => {
    const g = buildGraph([{ from: 'o/cli', to: 'o/lib', kind: 'zed', spec: null }]);
    const pushed = new Map([
      ['o/lib', '2026-08-22T00:00:00Z'],
      ['o/other', '2026-08-23T00:00:00Z'],
    ]);
    assert.deepEqual(disturbedSince(g, 'o/cli', '2026-08-21T00:00:00Z', pushed), ['o/lib']);
    assert.deepEqual(disturbedSince(g, 'o/cli', '2026-08-22T12:00:00Z', pushed), []);
  });

  test('a neighbour with no recorded push is not treated as disturbance', () => {
    const g = buildGraph([{ from: 'o/cli', to: 'o/lib', kind: 'zed', spec: null }]);
    assert.deepEqual(disturbedSince(g, 'o/cli', '2026-08-01T00:00:00Z', new Map()), []);
  });
});
