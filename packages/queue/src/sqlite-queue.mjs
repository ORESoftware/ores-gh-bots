import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function nowMs() {
  return Date.now();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupeKey: row.dedupe_key,
    type: row.type,
    installationId: Number(row.installation_id),
    owner: row.owner,
    repo: row.repo,
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    reason: row.reason,
    force: Boolean(row.force),
    needsAuthorization: Boolean(row.needs_authorization),
    sender: row.sender,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: Number(row.available_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function boundedIdentifier(value, field, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || !/^[A-Za-z0-9_.-]+$/u.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function boundedText(value, field, maxLength, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const text = String(value ?? '');
  if (!text || text.length > maxLength || /[\0\r\n]/u.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function normalizeJob(job, defaultMaxAttempts) {
  if (!job || !['review', 'gate'].includes(job.type)) throw new Error('Invalid queue job type');
  const installationId = positiveInteger(job.installationId, 'installationId');
  const prNumber = positiveInteger(job.prNumber, 'prNumber');
  const owner = boundedIdentifier(job.owner, 'owner', 100);
  const repo = boundedIdentifier(job.repo, 'repo', 100);
  const headSha = job.headSha === null || job.headSha === undefined
    ? null
    : boundedText(job.headSha, 'headSha', 128);
  const reason = boundedText(job.reason ?? 'unspecified', 'reason', 512);
  const sender = boundedText(job.sender, 'sender', 100, { nullable: true });
  const payloadJson = JSON.stringify(job.payload ?? {});
  if (Buffer.byteLength(payloadJson, 'utf8') > 65_536) throw new Error('payload is too large');
  const maxAttempts = positiveInteger(job.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
  const availableAt = Number(job.availableAt ?? nowMs());
  if (!Number.isSafeInteger(availableAt) || availableAt < 0) throw new Error('availableAt is invalid');
  return {
    type: job.type,
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
    reason,
    force: Boolean(job.force),
    needsAuthorization: Boolean(job.needsAuthorization),
    sender,
    payloadJson,
    maxAttempts,
    availableAt,
  };
}

function dedupeKey(job) {
  return [
    job.type,
    job.installationId,
    `${job.owner}/${job.repo}`.toLowerCase(),
    job.prNumber,
    job.headSha ?? 'current',
  ].join(':');
}

export class SqliteQueue {
  constructor({ path = './data/ores-gh-bots.sqlite', maxAttempts = 8 } = {}) {
    this.path = path === ':memory:' ? ':memory:' : resolve(path);
    this.maxAttempts = positiveInteger(maxAttempts, 'maxAttempts');
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('review','gate')),
        installation_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT,
        reason TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0,
        needs_authorization INTEGER NOT NULL DEFAULT 0,
        sender TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status, available_at, lease_expires_at, id);
      CREATE INDEX IF NOT EXISTS jobs_pr_idx ON jobs(owner, repo, pr_number, head_sha, type);
      CREATE TABLE IF NOT EXISTS reviews (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('openai','claude')),
        result_json TEXT,
        error TEXT,
        check_run_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner, repo, pr_number, head_sha, provider)
      );
      CREATE INDEX IF NOT EXISTS reviews_sha_idx ON reviews(owner, repo, head_sha);
    `);
  }

  markDelivery(deliveryId, event, action = null) {
    const normalizedDeliveryId = boundedText(deliveryId, 'deliveryId', 128);
    const normalizedEvent = boundedText(event, 'event', 64);
    const normalizedAction = boundedText(action, 'action', 100, { nullable: true });
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO deliveries(delivery_id, event, action, received_at)
      VALUES (?, ?, ?, ?)
    `).run(normalizedDeliveryId, normalizedEvent, normalizedAction, nowMs());
    return result.changes === 1;
  }

  enqueue(job) {
    const normalized = normalizeJob(job, this.maxAttempts);
    const timestamp = nowMs();
    const key = dedupeKey(normalized);
    const result = this.db.prepare(`
      INSERT INTO jobs(
        dedupe_key, type, installation_id, owner, repo, pr_number, head_sha, reason,
        force, needs_authorization, sender, payload_json, status, attempts, max_attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        installation_id = excluded.installation_id,
        reason = excluded.reason,
        force = excluded.force,
        needs_authorization = excluded.needs_authorization,
        sender = excluded.sender,
        payload_json = excluded.payload_json,
        status = 'pending',
        attempts = 0,
        max_attempts = excluded.max_attempts,
        available_at = excluded.available_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE excluded.force = 1 AND jobs.status IN ('completed', 'dead')
    `).run(
      key,
      normalized.type,
      normalized.installationId,
      normalized.owner,
      normalized.repo,
      normalized.prNumber,
      normalized.headSha,
      normalized.reason,
      normalized.force ? 1 : 0,
      normalized.needsAuthorization ? 1 : 0,
      normalized.sender,
      normalized.payloadJson,
      normalized.maxAttempts,
      normalized.availableAt,
      timestamp,
      timestamp,
    );
    const row = this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(key);
    return { inserted: result.changes === 1, job: rowToJob(row) };
  }

  claimNext(workerId, leaseMs) {
    const normalizedWorkerId = boundedText(workerId, 'workerId', 200);
    const normalizedLeaseMs = positiveInteger(leaseMs, 'leaseMs');
    const timestamp = nowMs();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = CASE
              WHEN attempts >= max_attempts THEN COALESCE(last_error, 'lease expired after final attempt')
              ELSE last_error
            END,
            updated_at = ?
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(timestamp, timestamp);
      this.db.prepare(`
        UPDATE jobs
        SET status = 'dead',
            last_error = COALESCE(last_error, 'attempt budget exhausted'),
            updated_at = ?
        WHERE status = 'pending' AND attempts >= max_attempts
      `).run(timestamp);
      const row = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'pending' AND available_at <= ? AND attempts < max_attempts
        ORDER BY available_at ASC, id ASC
        LIMIT 1
      `).get(timestamp);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const update = this.db.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(normalizedWorkerId, timestamp + normalizedLeaseMs, timestamp, row.id);
      if (update.changes !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const claimed = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
      this.db.exec('COMMIT');
      return rowToJob(claimed);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  heartbeat(jobId, workerId, leaseMs) {
    const timestamp = nowMs();
    const result = this.db.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      timestamp + positiveInteger(leaseMs, 'leaseMs'),
      timestamp,
      positiveInteger(jobId, 'jobId'),
      boundedText(workerId, 'workerId', 200),
    );
    return result.changes === 1;
  }

  complete(jobId, workerId) {
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(nowMs(), positiveInteger(jobId, 'jobId'), boundedText(workerId, 'workerId', 200));
    return result.changes === 1;
  }

  fail(job, workerId, error, { baseDelayMs = 2_000, maxDelayMs = 15 * 60_000 } = {}) {
    const timestamp = nowMs();
    const dead = job.attempts >= job.maxAttempts;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, job.attempts - 1));
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      dead ? 'dead' : 'pending',
      dead ? timestamp : timestamp + delay,
      String(error).slice(0, 8_000),
      timestamp,
      positiveInteger(job.id, 'jobId'),
      boundedText(workerId, 'workerId', 200),
    );
    return { updated: result.changes === 1, dead, delayMs: dead ? 0 : delay };
  }

  recordReview({ owner, repo, prNumber, headSha, provider, result = null, error = null, checkRunId = null }) {
    const normalizedOwner = boundedIdentifier(owner, 'owner', 100);
    const normalizedRepo = boundedIdentifier(repo, 'repo', 100);
    const normalizedPrNumber = positiveInteger(prNumber, 'prNumber');
    const normalizedHeadSha = boundedText(headSha, 'headSha', 128);
    if (!['openai', 'claude'].includes(provider)) throw new Error('provider is invalid');
    this.db.prepare(`
      INSERT INTO reviews(owner, repo, pr_number, head_sha, provider, result_json, error, check_run_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, repo, pr_number, head_sha, provider) DO UPDATE SET
        result_json = excluded.result_json,
        error = excluded.error,
        check_run_id = excluded.check_run_id,
        updated_at = excluded.updated_at
    `).run(
      normalizedOwner,
      normalizedRepo,
      normalizedPrNumber,
      normalizedHeadSha,
      provider,
      result ? JSON.stringify(result) : null,
      error ? String(error).slice(0, 8_000) : null,
      checkRunId,
      nowMs(),
    );
  }

  getReviews({ owner, repo, prNumber, headSha }) {
    const rows = this.db.prepare(`
      SELECT * FROM reviews WHERE owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?
    `).all(owner, repo, prNumber, headSha);
    const reviews = {};
    for (const row of rows) {
      reviews[row.provider] = row.error
        ? { error: row.error, checkRunId: row.check_run_id }
        : { ...parseJson(row.result_json, {}), checkRunId: row.check_run_id };
    }
    return reviews;
  }

  stats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  prune({
    deliveriesBefore = nowMs() - 30 * 24 * 60 * 60_000,
    completedBefore = nowMs() - 14 * 24 * 60 * 60_000,
    deadBefore = nowMs() - 30 * 24 * 60 * 60_000,
    reviewsBefore = nowMs() - 30 * 24 * 60 * 60_000,
  } = {}) {
    const deliveries = this.db.prepare('DELETE FROM deliveries WHERE received_at < ?').run(deliveriesBefore).changes;
    const completed = this.db.prepare("DELETE FROM jobs WHERE status = 'completed' AND updated_at < ?").run(completedBefore).changes;
    const dead = this.db.prepare("DELETE FROM jobs WHERE status = 'dead' AND updated_at < ?").run(deadBefore).changes;
    const reviews = this.db.prepare('DELETE FROM reviews WHERE updated_at < ?').run(reviewsBefore).changes;
    return { deliveries, jobs: completed + dead, reviews };
  }

  close() {
    this.db.close();
  }
}
