#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const IMAGE_NAME = 'ghcr.io/oresoftware/ores-gh-bots';
export const INACTIVE_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function firstMatch(source, pattern) {
  return pattern.exec(source)?.[1] ?? null;
}

export function inspectKubernetesImagePins({ base, canary, production }) {
  const baseImage = firstMatch(
    base,
    /^\s*image:\s*(ghcr\.io\/oresoftware\/ores-gh-bots(?:@sha256:[0-9a-f]{64}|:[^\s#]+))\s*$/mu,
  );
  const overlayDigest = (source) => firstMatch(source, /^\s*digest:\s*(sha256:[0-9a-f]{64})\s*$/mu);
  const overlayName = (source) => firstMatch(source, /^\s*-\s+name:\s*(ghcr\.io\/oresoftware\/ores-gh-bots)\s*$/mu);

  return {
    baseImage,
    baseDigest: baseImage?.startsWith(`${IMAGE_NAME}@`) ? baseImage.slice(IMAGE_NAME.length + 1) : null,
    canaryName: overlayName(canary),
    canaryDigest: overlayDigest(canary),
    productionName: overlayName(production),
    productionDigest: overlayDigest(production),
    hasMutableTag: [base, canary, production].some((source) => (
      /ghcr\.io\/oresoftware\/ores-gh-bots:[^\s#]+/u.test(source) || /^\s*newTag:\s*/mu.test(source)
    )),
  };
}

export function validateKubernetesImagePins(inputs, { activation = false } = {}) {
  const result = inspectKubernetesImagePins(inputs);
  const errors = [];

  if (result.hasMutableTag) errors.push('mutable ores-gh-bots image tag/newTag is forbidden');
  if (!result.baseDigest || !DIGEST.test(result.baseDigest)) errors.push('base Deployment must use an immutable sha256 digest');
  for (const environment of ['canary', 'production']) {
    const name = result[`${environment}Name`];
    const digest = result[`${environment}Digest`];
    if (name !== IMAGE_NAME) errors.push(`${environment} overlay must transform ${IMAGE_NAME}`);
    if (!digest || !DIGEST.test(digest)) errors.push(`${environment} overlay must set a full sha256 digest`);
    if (activation && digest === INACTIVE_DIGEST) errors.push(`${environment} overlay still uses the inactive all-zero digest sentinel`);
  }
  if (activation && result.baseDigest === INACTIVE_DIGEST) {
    // The overlays replace the base image, so the base sentinel is intentionally
    // allowed during activation. It exists to make direct base application fail closed.
  }

  return { ok: errors.length === 0, errors, ...result };
}

async function loadRepositoryInputs() {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  return {
    base: await read('deploy/kubernetes/base/deployment.yaml'),
    canary: await read('deploy/kubernetes/overlays/canary/kustomization.yaml'),
    production: await read('deploy/kubernetes/overlays/production/kustomization.yaml'),
  };
}

async function main() {
  const activation = process.argv.slice(2).includes('--activation');
  const result = validateKubernetesImagePins(await loadRepositoryInputs(), { activation });
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }
  const state = [result.canaryDigest, result.productionDigest].includes(INACTIVE_DIGEST)
    ? 'inactive-sentinel'
    : 'deployable-digests';
  console.log(`kubernetes image pins ok (${state})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
