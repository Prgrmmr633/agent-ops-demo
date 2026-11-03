import { isDeepStrictEqual } from 'node:util';
import { type Ambient, systemAmbient } from '../ambient.ts';
import { type Db, transaction } from '../db.ts';
import type { JsonObject } from '../json.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  type: string;
  payload: JsonObject;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  result: JsonObject | null;
  requeueCount: number;
  createdAt: number;
  finishedAt: number | null;
}

export interface NewJob {
  type: string;
  payload: JsonObject;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface QueueStats {
  depth: number;
  running: number;
  failed: number;
  succeeded: number;
  oldestDueAgeMs: number | null;
  lastSuccessAt: number | null;
}

export class IdempotencyConflict extends Error {}
export class RequeueRefused extends Error {}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
    run_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    result TEXT,
    requeue_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, run_at);
`;

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY: RetryPolicy = { baseDelayMs: 5_000, maxDelayMs: 5 * 60_000 };
const LEASE_EXPIRED = 'Worker lease expired before the job finished.';

export class JobQueue {
  private readonly db: Db;
  private readonly ambient: Ambient;
  private readonly retry: RetryPolicy;

  constructor(db: Db, ambient: Ambient = systemAmbient, retry: RetryPolicy = DEFAULT_RETRY) {
    this.db = db;
    this.ambient = ambient;
    this.retry = retry;
    db.exec(SCHEMA);
  }

  /** Reusing a key returns the original job, so a repeated request cannot do the work twice. */
  enqueue(input: NewJob): { job: Job; created: boolean } {
    const now = this.ambient.now();
    const inserted = this.db
      .prepare(
        `INSERT INTO jobs
           (id, type, payload, idempotency_key, status, max_attempts, run_at, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
      )
      .get(
        this.ambient.newId('job'),
        input.type,
        JSON.stringify(input.payload),
        input.idempotencyKey,
        input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        now,
        now,
      );
    if (inserted) return { job: toJob(inserted), created: true };

    const existing = toJob(
      this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(input.idempotencyKey),
    );
    if (existing.type !== input.type || !isDeepStrictEqual(existing.payload, input.payload)) {
      throw new IdempotencyConflict(
        `Key "${input.idempotencyKey}" was already used for different work (${existing.id}).`,
      );
    }
    return { job: existing, created: false };
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? toJob(row) : null;
  }

  listFailed(): Job[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'failed' ORDER BY finished_at, rowid`)
      .all()
      .map(toJob);
  }

  /** Takes the oldest due job in one statement, so two workers cannot claim the same one. */
  claim(workerId: string, leaseMs: number): Job | null {
    const now = this.ambient.now();
    const row = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ?
           ORDER BY run_at, rowid LIMIT 1
         )
         RETURNING *`,
      )
      .get(workerId, now + leaseMs, now);
    return row ? toJob(row) : null;
  }

  /** Returns false if the job's lease was lost, for example after a long pause. */
  renewLease(job: Job, leaseMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
      )
      .run(this.ambient.now() + leaseMs, job.id, job.leaseOwner, job.attempts);
    return result.changes === 1;
  }

  /** Returns false if another attempt owns the job now, which leaves its state alone. */
  complete(job: Job, result: JsonObject): boolean {
    const update = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'succeeded', result = ?, last_error = NULL, finished_at = ?,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
      )
      .run(JSON.stringify(result), this.ambient.now(), job.id, job.leaseOwner, job.attempts);
    return update.changes === 1;
  }

  /** Schedules a retry with backoff, or marks the job failed once it has no attempts left. */
  fail(job: Job, error: string, options: { permanent?: boolean } = {}): boolean {
    const update = this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, run_at = ?, last_error = ?, finished_at = ?,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
      )
      .run(
        ...this.nextState(job, options.permanent === true),
        error,
        this.finishedAt(job, options.permanent === true),
        job.id,
        job.leaseOwner,
        job.attempts,
      );
    return update.changes === 1;
  }

  /** Treats a running job with an expired lease as a failed attempt. Returns the job ids. */
  recoverExpired(): string[] {
    return transaction(this.db, () => {
      const expired = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at <= ?`)
        .all(this.ambient.now())
        .map(toJob);
      for (const job of expired) this.fail(job, LEASE_EXPIRED);
      return expired.map((job) => job.id);
    });
  }

  /**
   * The only way back from `failed`. Takes exact ids and is all-or-nothing, and
   * there is deliberately no variant that selects jobs by status or type.
   */
  requeueExact(ids: string[]): Job[] {
    if (ids.length === 0) throw new RequeueRefused('Name at least one job id.');
    if (new Set(ids).size !== ids.length) throw new RequeueRefused('Job ids must be unique.');

    return transaction(this.db, () => {
      const now = this.ambient.now();
      return ids.map((id) => {
        const job = this.get(id);
        if (!job) throw new RequeueRefused(`No job with id ${id}. Nothing was requeued.`);
        if (job.status !== 'failed') {
          throw new RequeueRefused(`Job ${id} is ${job.status}, not failed. Nothing was requeued.`);
        }
        const row = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'queued', attempts = 0, run_at = ?, finished_at = NULL,
                 requeue_count = requeue_count + 1
             WHERE id = ? RETURNING *`,
          )
          .get(now, id);
        return toJob(row);
      });
    });
  }

  stats(): QueueStats {
    const now = this.ambient.now();
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'queued'), 0) AS depth,
           COALESCE(SUM(status = 'running'), 0) AS running,
           COALESCE(SUM(status = 'failed'), 0) AS failed,
           COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
           MIN(CASE WHEN status = 'queued' AND run_at <= ?1 THEN run_at END) AS oldest_due,
           MAX(CASE WHEN status = 'succeeded' THEN finished_at END) AS last_success
         FROM jobs`,
      )
      .get(now) as {
      depth: number;
      running: number;
      failed: number;
      succeeded: number;
      oldest_due: number | null;
      last_success: number | null;
    };
    return {
      depth: row.depth,
      running: row.running,
      failed: row.failed,
      succeeded: row.succeeded,
      oldestDueAgeMs: row.oldest_due === null ? null : now - row.oldest_due,
      lastSuccessAt: row.last_success,
    };
  }

  private willRetry(job: Job, permanent: boolean): boolean {
    return !permanent && job.attempts < job.maxAttempts;
  }

  private nextState(job: Job, permanent: boolean): [JobStatus, number] {
    if (!this.willRetry(job, permanent)) return ['failed', job.runAt];
    const delay = this.retry.baseDelayMs * 2 ** (job.attempts - 1);
    return ['queued', this.ambient.now() + Math.min(delay, this.retry.maxDelayMs)];
  }

  private finishedAt(job: Job, permanent: boolean): number | null {
    return this.willRetry(job, permanent) ? null : this.ambient.now();
  }
}

function toJob(row: unknown): Job {
  const r = row as {
    id: string;
    type: string;
    payload: string;
    idempotency_key: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    run_at: number;
    lease_owner: string | null;
    lease_expires_at: number | null;
    last_error: string | null;
    result: string | null;
    requeue_count: number;
    created_at: number;
    finished_at: number | null;
  };
  return {
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload),
    idempotencyKey: r.idempotency_key,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: r.run_at,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    lastError: r.last_error,
    result: r.result === null ? null : JSON.parse(r.result),
    requeueCount: r.requeue_count,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}
