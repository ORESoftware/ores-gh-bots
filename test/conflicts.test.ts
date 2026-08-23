import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDE_PICKING_STRATEGIES,
  SidePickingRejected,
  assertNotSidePicking,
  buildDossier,
  contextDepth,
  overlappingPulls,
  renderDossier,
} from '../src/conflicts.ts';
import { CONFLICT_CONTEXT_COMMITS_MAX, CONFLICT_CONTEXT_COMMITS_MIN } from '../src/config.ts';
import { NOW } from './helpers.ts';

describe('never pick a side', () => {
  test('every side-picking strategy is rejected', () => {
    for (const s of SIDE_PICKING_STRATEGIES) {
      assert.throws(() => assertNotSidePicking(s), SidePickingRejected, `${s} should be rejected`);
    }
  });

  test('rejection is case- and spacing-insensitive', () => {
    for (const s of ['OURS', '  theirs ', 'git merge -X ours', '--strategy-option=THEIRS']) {
      assert.throws(() => assertNotSidePicking(s), SidePickingRejected, `${s} should be rejected`);
    }
  });

  test('legitimate strategies pass', () => {
    for (const s of ['recursive', 'ort', 'resolve', 'octopus']) {
      assert.doesNotThrow(() => assertNotSidePicking(s));
    }
  });

  test('the error explains why, not just that', () => {
    try {
      assertNotSidePicking('ours');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof SidePickingRejected);
      assert.match(err.message, /conceptually with full context/);
    }
  });
});

describe('conflict dossier', () => {
  test('context depth stays inside the 3-10 commit window', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 0, 0],
      [500, 90, 90],
      [12, 3, 4],
    ];
    for (const [f, d, p] of cases) {
      const depth = contextDepth(f, d, p);
      assert.ok(depth >= CONFLICT_CONTEXT_COMMITS_MIN, `${depth} below floor`);
      assert.ok(depth <= CONFLICT_CONTEXT_COMMITS_MAX, `${depth} above ceiling`);
    }
  });

  test('a quiet conflict asks for the floor, an entangled one for the ceiling', () => {
    assert.equal(contextDepth(1, 0, 0), CONFLICT_CONTEXT_COMMITS_MIN);
    assert.equal(contextDepth(40, 5, 6), CONFLICT_CONTEXT_COMMITS_MAX);
  });

  test('depth is monotonic in entanglement', () => {
    let prev = 0;
    for (const files of [0, 2, 5, 10, 20, 40]) {
      const d = contextDepth(files, 0, 0);
      assert.ok(d >= prev, 'depth must not decrease as entanglement grows');
      prev = d;
    }
  });

  test('rendered dossier instructs and never resolves', () => {
    const d = buildDossier({
      repo: 'zed-pkg/zed-lib',
      prNumber: 42,
      headRef: 'feat/x',
      baseRef: 'main',
      touchedFiles: ['src/a.ts', 'src/b.ts'],
      disturbedBy: ['zed-pkg/zed-cli'],
      relatedPulls: [41],
      now: NOW,
    });
    const md = renderDossier(d);
    assert.match(md, /Semantic merge required/);
    assert.match(md, /Do not run `-X ours`\/`-X theirs`/);
    assert.match(md, /zed-pkg\/zed-cli/);
    assert.match(md, /#41/);
    assert.match(md, new RegExp(`last \\*\\*${d.contextCommits} commits\\*\\*`));
    assert.ok(!/resolved automatically|auto-resolved/i.test(md));
  });

  test('long file lists are truncated with an honest remainder count', () => {
    const files = Array.from({ length: 55 }, (_, i) => `src/f${i}.ts`);
    const md = renderDossier(
      buildDossier({
        repo: 'o/r', prNumber: 1, headRef: 'h', baseRef: 'main',
        touchedFiles: files, disturbedBy: [], relatedPulls: [], now: NOW,
      }),
    );
    assert.match(md, /and 15 more/);
    assert.match(md, /\*\*Files in this PR\*\* \(55\)/);
  });
});

describe('same-repo PR interaction', () => {
  test('finds PRs touching overlapping files and excludes itself', () => {
    const self = { number: 3, files: ['a.ts', 'b.ts'] };
    const others = [
      { number: 3, files: ['a.ts'] },
      { number: 4, files: ['b.ts', 'c.ts'] },
      { number: 5, files: ['z.ts'] },
      { number: 2, files: ['a.ts'] },
    ];
    assert.deepEqual(overlappingPulls(self, others), [2, 4]);
  });

  test('no overlap yields no related pulls', () => {
    assert.deepEqual(overlappingPulls({ number: 1, files: ['a'] }, [{ number: 2, files: ['b'] }]), []);
  });
});
