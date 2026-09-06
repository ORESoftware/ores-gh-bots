import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const WORKFLOW_DIRECTORY = new URL('../.github/workflows/', import.meta.url);
const IMMUTABLE_ACTION_REVISION = /^[0-9a-f]{40}$/iu;
const PROHIBITED_FLEET_TOKEN_NAMES = /\b(?:FLEET_PR_TOKEN|GITHUB_PAT|GH_PAT|PERSONAL_ACCESS_TOKEN)\b/u;
const UNTRUSTED_EXPRESSION_IN_SHELL = /\$\{\{\s*(?:inputs\.|github\.event\.(?:inputs\.|pull_request\.(?:title|body|head\.ref)|issue\.(?:title|body)|comment\.body))/u;

async function loadWorkflows() {
  const names = (await readdir(WORKFLOW_DIRECTORY))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();

  return Promise.all(names.map(async (name) => ({
    name,
    source: await readFile(new URL(name, WORKFLOW_DIRECTORY), 'utf8'),
  })));
}

function indentationWidth(line) {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function shellBodies(source) {
  const lines = source.split(/\r?\n/u);
  const bodies = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*(?:-[ \t]+)?)(?:run|"run"|'run'):[ \t]*(.*)$/u.exec(lines[index]);
    if (!match) continue;

    // Include the sequence marker: sibling env/shell keys align with run,
    // not with the dash. Otherwise safe env values become shell source.
    const runIndent = match[1].length;
    const suffix = match[2].trim();
    // Quoted/plain inline scalars may continue on subsequent indented lines.
    const body = suffix !== '' && !/^[>|]/u.test(suffix) ? [suffix] : [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() !== '' && indentationWidth(line) <= runIndent) break;
      body.push(line);
      index = cursor;
    }
    bodies.push(body.join('\n'));
  }

  return bodies;
}

test('third-party workflow actions are pinned to immutable commit SHAs', async () => {
  for (const workflow of await loadWorkflows()) {
    for (const [lineNumber, line] of workflow.source.split('\n').entries()) {
      const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/u.exec(line);
      if (!match) continue;

      const reference = match[1];
      if (reference.startsWith('./') || reference.startsWith('docker://')) continue;

      const separator = reference.lastIndexOf('@');
      assert.notEqual(separator, -1, `${workflow.name}:${lineNumber + 1} action is missing a revision`);
      const revision = reference.slice(separator + 1);
      assert.match(
        revision,
        IMMUTABLE_ACTION_REVISION,
        `${workflow.name}:${lineNumber + 1} must pin ${reference.slice(0, separator)} to a 40-character commit SHA`,
      );
    }
  }
});

test('workflow shell bodies never interpolate attacker-controlled event text directly', async () => {
  for (const workflow of await loadWorkflows()) {
    for (const body of shellBodies(workflow.source)) {
      assert.doesNotMatch(
        body,
        UNTRUSTED_EXPRESSION_IN_SHELL,
        `${workflow.name} must pass event data through an env mapping or a file, never splice it into shell source`,
      );
    }
  }
});

test('fleet workflow authority never falls back to a personal access token', async () => {
  for (const workflow of await loadWorkflows()) {
    assert.doesNotMatch(
      workflow.source,
      PROHIBITED_FLEET_TOKEN_NAMES,
      `${workflow.name} must use a least-privilege GitHub App identity for cross-repository effects`,
    );
  }
});

// These fixtures exercise the guard itself, not only today's workflow contents.
// This is a block-style workflow regression scanner, not a general YAML parser.
const UNSAFE_INPUT = '${{ inputs.payload }}';
const UNSAFE_TITLE = '${{ github.event.pull_request.title }}';

for (const [name, source] of [
  ['list-leading inline run', `steps:\n  - run: echo "${UNSAFE_INPUT}"`],
  ['list-leading literal run', `steps:\n  - run: |\n      echo "${UNSAFE_TITLE}"`],
  ['list-leading folded run', `steps:\n  - run: >-\n      echo\n      "${UNSAFE_INPUT}"`],
  ['named-step run', `steps:\n  - name: example\n    run: echo "${UNSAFE_INPUT}"`],
  ['single-quoted run key', `steps:\n  - 'run': echo "${UNSAFE_INPUT}"`],
  ['double-quoted run key', `steps:\n  - "run": echo "${UNSAFE_INPUT}"`],
  ['inline scalar continuation', `steps:\n  - run: echo\n      "${UNSAFE_INPUT}"`],
  ['quoted scalar continuation', `steps:\n  - run: 'echo\n      ${UNSAFE_INPUT}'`],
  ['CRLF literal run', `steps:\r\n  - run: |+\r\n\r\n      echo "${UNSAFE_INPUT}"\r\n`],
]) {
  test(`shell-body guard detects ${name}`, () => {
    const bodies = shellBodies(source);
    assert.equal(bodies.length, 1, 'the shell step must not disappear');
    assert.match(bodies[0], UNTRUSTED_EXPRESSION_IN_SHELL);
  });
}

test('list-leading block stops before the sibling env mapping', () => {
  const bodies = shellBodies([
    'steps:',
    '  - run: |',
    '      echo "$PAYLOAD"',
    '    env:',
    `      PAYLOAD: ${UNSAFE_INPUT}`,
    '  - run: echo second',
  ].join('\n'));
  assert.deepEqual(bodies, ['      echo "$PAYLOAD"', 'echo second']);
  for (const body of bodies) assert.doesNotMatch(body, UNTRUSTED_EXPRESSION_IN_SHELL);
});

test('safe env mappings before a run remain outside shell source', () => {
  const bodies = shellBodies([
    'steps:',
    '  - env:',
    `      PAYLOAD: ${UNSAFE_INPUT}`,
    '    run: echo "$PAYLOAD"',
    '    shell: bash',
  ].join('\n'));
  assert.deepEqual(bodies, ['echo "$PAYLOAD"']);
  assert.doesNotMatch(bodies[0], UNTRUSTED_EXPRESSION_IN_SHELL);
});

test('adjacent shell steps are each inspected after a block boundary', () => {
  const bodies = shellBodies([
    'steps:',
    '  - run: |-',
    '      echo first',
    '',
    `  - run: echo "${UNSAFE_INPUT}"`,
    '  - name: third',
    '    run: echo third',
  ].join('\n'));
  assert.equal(bodies.length, 3);
  assert.match(bodies[1], UNTRUSTED_EXPRESSION_IN_SHELL);
  assert.equal(bodies[2], 'echo third');
});

test('non-shell steps and commented run keys do not create shell bodies', () => {
  assert.deepEqual(shellBodies('steps:\n  # - run: ignored\n  - uses: ./action\n'), []);
});
