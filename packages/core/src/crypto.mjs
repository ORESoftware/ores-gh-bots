import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function verifyWebhookSignature({ secret, body, signature }) {
  if (!secret || !signature || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signature, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createGitHubAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (!appId || !privateKey) throw new Error('GitHub App ID and private key are required');
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}
