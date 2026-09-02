import { createServer } from 'node:http';
import {
  CHECK_NAMES,
  ownerIsAllowed,
  redactText,
  routeWebhookEvent,
  verifyWebhookSignature,
} from '../../../packages/core/src/index.mjs';

function json(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body exceeds configured limit');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function singleHeader(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : '';
  return String(value ?? '');
}

function validEventHeader(value) {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function validDeliveryHeader(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export function createWebhookServer({ config, queue, logger, metrics, readiness = () => true }) {
  const eventPolicy = {
    ownAppIds: {
      [CHECK_NAMES.openai]: config.apps.openai.id,
      [CHECK_NAMES.claude]: config.apps.claude.id,
      [CHECK_NAMES.gate]: config.apps.gate.id,
    },
    requiredCiContexts: config.review.requiredCiContexts,
  };

  const server = createServer({
    headersTimeout: config.server.headersTimeoutMs,
    requestTimeout: config.server.requestTimeoutMs,
    keepAliveTimeout: config.server.keepAliveTimeoutMs,
    maxHeaderSize: config.server.maxHeaderBytes,
  }, async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const ready = Boolean(readiness());
        return json(response, ready ? 200 : 503, { ready });
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const data = metrics.render();
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4',
          'content-length': Buffer.byteLength(data),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(data);
      }
      if (request.method !== 'POST' || url.pathname !== config.server.webhookPath) {
        return json(response, 404, { error: 'not_found' });
      }

      const rawBody = await readBody(request, config.server.bodyLimitBytes);
      const signature = singleHeader(request.headers['x-hub-signature-256']);
      if (!verifyWebhookSignature({ secret: config.github.webhookSecret, body: rawBody, signature })) {
        metrics.increment('ores_webhooks_rejected_total', { reason: 'signature' });
        return json(response, 401, { error: 'invalid_signature' });
      }

      const event = singleHeader(request.headers['x-github-event']);
      const deliveryId = singleHeader(request.headers['x-github-delivery']);
      if (!validEventHeader(event) || !validDeliveryHeader(deliveryId)) {
        metrics.increment('ores_webhooks_rejected_total', { reason: 'headers' });
        return json(response, 400, { error: 'invalid_github_headers' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        metrics.increment('ores_webhooks_rejected_total', { reason: 'json' });
        return json(response, 400, { error: 'invalid_json' });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        metrics.increment('ores_webhooks_rejected_total', { reason: 'payload' });
        return json(response, 400, { error: 'invalid_payload' });
      }
      if (event === 'ping') return json(response, 200, { ok: true, zen: payload.zen ?? null });

      const owner = payload.repository?.owner?.login ?? payload.organization?.login ?? payload.installation?.account?.login;
      if (!ownerIsAllowed(config, owner)) {
        metrics.increment('ores_webhooks_rejected_total', { reason: 'owner' });
        logger.warn('rejected webhook for non-allowlisted owner', { event, owner: redactText(owner) });
        return json(response, 403, { error: 'owner_not_allowed' });
      }

      const jobs = routeWebhookEvent({ event, payload, policy: eventPolicy });
      const accepted = queue.acceptDelivery(deliveryId, event, payload.action ?? null, jobs);
      if (!accepted.firstDelivery) {
        metrics.increment('ores_webhooks_duplicate_total', { event });
        return json(response, 202, { accepted: true, duplicate: true, jobs: 0 });
      }

      metrics.increment('ores_webhooks_total', { event, action: payload.action ?? 'none' });
      metrics.increment('ores_jobs_enqueued_total', { event }, accepted.inserted);
      logger.info('accepted webhook', {
        event,
        action: payload.action,
        deliveryId,
        jobs: jobs.length,
        inserted: accepted.inserted,
      });
      return json(response, 202, {
        accepted: true,
        duplicate: false,
        jobs: jobs.length,
        inserted: accepted.inserted,
      });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      metrics.increment('ores_http_errors_total', { status });
      logger.error('webhook server error', { status, error: redactText(error?.stack ?? error) });
      return json(response, status, { error: status === 500 ? 'internal_error' : error.message });
    }
  });

  server.maxHeadersCount = config.server.maxHeadersCount;
  server.maxRequestsPerSocket = config.server.maxRequestsPerSocket;
  return server;
}