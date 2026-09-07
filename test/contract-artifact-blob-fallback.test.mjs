import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepositoryTextFileAtCommit } from '../packages/github/src/contract-artifacts.mjs';

const headSha = 'a'.repeat(40);
const blobSha = 'b'.repeat(40);
const artifactPath = 'contracts/evidence/large-report.json';

function fallbackClient(blobOverrides = {}) {
  const text = '{"large":true}\n';
  const bytes = Buffer.from(text, 'utf8');
  const calls = [];
  return {
    text,
    calls,
    async request(method, path) {
      calls.push({ method, path });
      if (path.includes('/contents/')) {
        return {
          data: {
            type: 'file',
            path: artifactPath,
            sha: blobSha,
            size: bytes.length,
            encoding: 'none',
            content: '',
          },
        };
      }
      if (path.endsWith(`/git/blobs/${blobSha}`)) {
        return {
          data: {
            sha: blobSha,
            size: bytes.length,
            encoding: 'base64',
            content: bytes.toString('base64'),
            ...blobOverrides,
          },
        };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

test('falls back from Contents metadata to the immutable Git blob', async () => {
  const client = fallbackClient();
  const result = await fetchRepositoryTextFileAtCommit(
    client,
    'token',
    'O',
    'R',
    artifactPath,
    headSha,
    { maxBytes: 5 * 1024 * 1024 },
  );
  assert.equal(result.text, client.text);
  assert.equal(result.blobSha, blobSha);
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0].path, new RegExp(`\\?ref=${headSha}$`, 'u'));
  assert.equal(client.calls[1].path, `/repos/O/R/git/blobs/${blobSha}`);
});

test('rejects a Git blob identity mismatch', async () => {
  const client = fallbackClient({ sha: 'c'.repeat(40) });
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      client,
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 5 * 1024 * 1024 },
    ),
    (error) => error?.code === 'contract_artifact_blob_mismatch',
  );
});

test('rejects Git blob size and encoding mismatches', async () => {
  const wrongSize = fallbackClient({ size: 1 });
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      wrongSize,
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 5 * 1024 * 1024 },
    ),
    (error) => error?.code === 'contract_artifact_blob_size_mismatch',
  );

  const wrongEncoding = fallbackClient({ encoding: 'utf-8' });
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      wrongEncoding,
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 5 * 1024 * 1024 },
    ),
    (error) => error?.code === 'contract_artifact_blob_encoding_invalid',
  );
});
