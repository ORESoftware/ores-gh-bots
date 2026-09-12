#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { classifyWorkflowEvidence } from '../packages/core/src/admission.mjs';

const MAX_EVIDENCE_BYTES = 1_048_576;

function usage() {
  console.error('Usage: npm run ci:classify -- PATH_TO_WORKFLOW_EVIDENCE.json');
}

async function readEvidence(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error(`workflow evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length > 0) {
  usage();
  process.exitCode = 2;
} else {
  const evidence = await readEvidence(path);
  console.log(JSON.stringify(classifyWorkflowEvidence(evidence), null, 2));
}
