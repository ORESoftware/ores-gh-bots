import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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

function dedupeKey(job) {
  const stable = [job.type, `${job.owner}/${job.repo}`.toLowerCase(), job.prNumber, job.headSha ?? 'current'].join(':');
  return job.force ? `${stable}:force:${randomUUID()}` : stable;
}

export class SqliteQueue {
  constructor({ path = './data/ores-gh-bots.sqlite', maxAttempts = 8 } = {}) {
    this.path = path === ':memory:' ? ':memory:' : resolve(path);
    this.maxAttempts = maxAttempts;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
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
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO deliveries(delivery_id, event, action, received_at)
      VALUES (?, ?, ?, ?)
    `).run(deliveryId, event, action, nowMs());
    return result.changes === 1;
  }

  enqueue(job) {
    if (!job?.installationId || !job.owner || !job.repo || !job.prNumber || !['review', 'gate'].includes(job.type)) {
      throw new Error('Invalid queue job');
    }
    const timestamp = nowMs();
    const key = dedupeKey(job);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO jobs(
        dedupe_key, type, installation_id, owner, repo, pr_number, head_sha, reason,
        force, needs_authorization, sender, payload_json, status, attempts, max_attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(
      key,
      job.type,
      Number(job.installationId),
      String(job.owner),
      String(job.repo),
      Number(job.prNumber),
      job.headSha ?? null,
      String(job.reason ?? 'unspecified'),
      job.force ? 1 : 0,
      job.needsAuthorization ? 1 : 0,
      job.sender ?? null,
      JSON.stringify(job.payload ?? {}),
      Number(job.maxAttempts ?? this.maxAttempts),
      Number(job.availableAt ?? timestamp),
      timestamp,
      timestamp,
    );
    const row = result.changes === 1
      ? this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid)
      : this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(key);
    return { inserted: result.changes === 1, job: rowToJob(row) };
  }

  claimNext(workerId, leaseMs) {
    const timestamp = nowMs();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE jobs
        SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(timestamp, timestamp);
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
      `).run(workerId, timestamp + leaseMs, timestamp, row.id);
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
    `).run(timestamp + leaseMs, timestamp, jobId, workerId);
    return result.changes === 1;
  }

  complete(jobId, workerId) {
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(nowMs(), jobId, workerId);
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
    `).run(dead ? 'dead' : 'pending', dead ? timestamp : timestamp + delay, String(error).slice(0, 8_000), timestamp, job.id, workerId);
    return { updated: result.changes === 1, dead, delayMs: dead ? 0 : delay };
  }

  recordReview({ owner, repo, prNumber, headSha, provider, result = null, error = null, checkRunId = null }) {
    if (!headSha) throw new Error('headSha is required to persist a review');
    this.db.prepare(`
      INSERT INTO reviews(owner, repo, pr_number, head_sha, provider, result_json, error, check_run_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, repo, pr_number, head_sha, provider) DO UPDATE SET
        result_json = excluded.result_json,
        error = excluded.error,
        check_run_id = excluded.check_run_id,
        updated_at = excluded.updated_at
    `).run(owner, repo, prNumber, headSha, provider, result ? JSON.stringify(result) : null, error, checkRunId, nowMs());
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

  prune({ deliveriesBefore = nowMs() - 30 * 24 * 60 * 60_000, completedBefore = nowMs() - 14 * 24 * 60 * 60_000 } = {}) {
    const deliveries = this.db.prepare('DELETE FROM deliveries WHERE received_at < ?').run(deliveriesBefore).changes;
    const jobs = this.db.prepare("DELETE FROM jobs WHERE status = 'completed' AND updated_at < ?").run(completedBefore).changes;
    return { deliveries, jobs };
  }

  close() {
    this.db.close();
  }
}
