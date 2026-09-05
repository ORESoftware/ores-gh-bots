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
  const lines = source.split('\n');
  const bodies = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;

    const runIndent = match[1].length;
    const suffix = match[2].trim();
    if (suffix !== '' && !/^[>|]/u.test(suffix)) {
      bodies.push(suffix);
      continue;
    }

    const body = [];
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
