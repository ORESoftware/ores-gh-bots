import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_NAME,
  INACTIVE_DIGEST,
  validateKubernetesImagePins,
} from '../scripts/verify-k8s-image-pins.mjs';

const REAL_DIGEST = `sha256:${'a'.repeat(64)}`;

function fixtures({ baseDigest = INACTIVE_DIGEST, canaryDigest = INACTIVE_DIGEST, productionDigest = INACTIVE_DIGEST } = {}) {
  return {
    base: `containers:\n  - image: ${IMAGE_NAME}@${baseDigest}\n`,
    canary: `images:\n  - name: ${IMAGE_NAME}\n    digest: ${canaryDigest}\n`,
    production: `images:\n  - name: ${IMAGE_NAME}\n    digest: ${productionDigest}\n`,
  };
}

test('checked-in inactive digest sentinel is immutable but not activation evidence', () => {
  const repository = validateKubernetesImagePins(fixtures());
  assert.equal(repository.ok, true, repository.errors.join('; '));

  const activation = validateKubernetesImagePins(fixtures(), { activation: true });
  assert.equal(activation.ok, false);
  assert.match(activation.errors.join('\n'), /canary overlay still uses the inactive/);
  assert.match(activation.errors.join('\n'), /production overlay still uses the inactive/);
});

test('activation accepts independently pinned real overlay digests', () => {
  const result = validateKubernetesImagePins(fixtures({
    canaryDigest: REAL_DIGEST,
    productionDigest: `sha256:${'b'.repeat(64)}`,
  }), { activation: true });
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('mutable tags and newTag transformers fail closed', () => {
  const tagged = fixtures();
  tagged.base = `containers:\n  - image: ${IMAGE_NAME}:latest\n`;
  tagged.production = `images:\n  - name: ${IMAGE_NAME}\n    newTag: v0.1.0\n`;
  const result = validateKubernetesImagePins(tagged);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /mutable ores-gh-bots image tag\/newTag is forbidden/);
  assert.match(result.errors.join('\n'), /base Deployment must use an immutable sha256 digest/);
});

test('short or malformed digests cannot satisfy the deployment contract', () => {
  const malformed = fixtures();
  malformed.canary = `images:\n  - name: ${IMAGE_NAME}\n    digest: sha256:deadbeef\n`;
  const result = validateKubernetesImagePins(malformed);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /canary overlay must set a full sha256 digest/);
});
