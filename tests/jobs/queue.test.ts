import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { IdempotencyConflict, JobQueue, RequeueRefused } from '../../src/jobs/queue.ts';

const retry = { baseDelayMs: 1_000, maxDelayMs: 3_000 };
const LEASE = 10_000;

function setup() {
  const ambient = fixedAmbient();
  const queue = new JobQueue(openDb(':memory:'), ambient, retry);
  return { ambient, queue };
}

const job = (key: string, maxAttempts = 3) => ({
  type: 'simulated_transcode',
  payload: { sourceName: `${key}.mov` },
  idempotencyKey: key,
  maxAttempts,
});

/** Drives a job to `failed` by exhausting its attempts. */
function exhaust(queue: JobQueue, ambient: ReturnType<typeof fixedAmbient>, key: string): string {
  const { job: created } = queue.enqueue(job(key, 1));
  ambient.advance(1);
  const claimed = queue.claim('worker-1', LEASE);
  if (claimed?.id !== created.id) throw new Error('claimed an unexpected job');
  queue.fail(claimed, 'boom');
  return created.id;
}

describe('enqueue', () => {
  it('creates a queued job', () => {
    const { queue } = setup();

    const result = queue.enqueue(job('a'));

    expect(result).toMatchObject({ created: true, job: { status: 'queued', attempts: 0 } });
  });

  it('returns the original job when a key is reused', () => {
    const { queue } = setup();
    const first = queue.enqueue(job('a'));

    const second = queue.enqueue(job('a'));

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(queue.stats().depth).toBe(1);
  });

  it('keeps returning a finished job rather than running it again', () => {
    const { queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');
    queue.complete(claimed, { done: true });

    const again = queue.enqueue(job('a'));

    expect(again).toMatchObject({ created: false, job: { status: 'succeeded' } });
    expect(queue.claim('worker-1', LEASE)).toBeNull();
  });

  it('refuses a reused key for different work', () => {
    const { queue } = setup();
    queue.enqueue(job('a'));

    expect(() =>
      queue.enqueue({ ...job('a'), payload: { sourceName: 'something-else.mov' } }),
    ).toThrow(IdempotencyConflict);
  });
});

describe('claim', () => {
  it('takes the oldest due job first', () => {
    const { ambient, queue } = setup();
    const first = queue.enqueue(job('a')).job;
    ambient.advance(1);
    queue.enqueue(job('b'));

    expect(queue.claim('worker-1', LEASE)?.id).toBe(first.id);
  });

  it('counts the attempt and records the lease', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));

    expect(queue.claim('worker-1', LEASE)).toMatchObject({
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-1',
      leaseExpiresAt: ambient.now() + LEASE,
    });
  });

  it('returns null when nothing is due', () => {
    const { queue } = setup();
    expect(queue.claim('worker-1', LEASE)).toBeNull();
  });

  describe('across connections', () => {
    let dir: string;

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('gives a job to only one of two workers', () => {
      dir = mkdtempSync(join(tmpdir(), 'jobs-'));
      const path = join(dir, 'jobs.db');
      const ambient = fixedAmbient();
      const first = new JobQueue(openDb(path), ambient, retry);
      const second = new JobQueue(openDb(path), ambient, retry);
      first.enqueue(job('a'));

      const claims = [first.claim('worker-1', LEASE), second.claim('worker-2', LEASE)];

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it('keeps queued work across a restart', () => {
      dir = mkdtempSync(join(tmpdir(), 'jobs-'));
      const path = join(dir, 'jobs.db');
      const ambient = fixedAmbient();
      const before = new JobQueue(openDb(path), ambient, retry);
      const { job: created } = before.enqueue(job('a'));

      const after = new JobQueue(openDb(path), ambient, retry);

      expect(after.claim('worker-1', LEASE)?.id).toBe(created.id);
    });
  });
});

describe('fail', () => {
  it('backs off exponentially, up to the cap', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a', 4));
    const delays: number[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = queue.claim('worker-1', LEASE);
      if (!claimed) throw new Error('expected a job');
      queue.fail(claimed, 'boom');
      const runAt = queue.get(claimed.id)?.runAt ?? 0;
      delays.push(runAt - ambient.now());
      ambient.advance(runAt - ambient.now());
    }

    expect(delays).toEqual([1_000, 2_000, 3_000]);
  });

  it('does not run a job again before its backoff has passed', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');
    queue.fail(claimed, 'boom');

    expect(queue.claim('worker-1', LEASE)).toBeNull();
    ambient.advance(999);
    expect(queue.claim('worker-1', LEASE)).toBeNull();
    ambient.advance(1);
    expect(queue.claim('worker-1', LEASE)).not.toBeNull();
  });

  it('marks the job failed once attempts run out', () => {
    const { queue } = setup();
    const { job: created } = queue.enqueue(job('a', 1));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');

    queue.fail(claimed, 'boom');

    expect(queue.get(created.id)).toMatchObject({
      status: 'failed',
      lastError: 'boom',
      leaseOwner: null,
    });
    expect(queue.get(created.id)?.finishedAt).not.toBeNull();
  });

  it('skips retries for a permanent failure', () => {
    const { queue } = setup();
    const { job: created } = queue.enqueue(job('a', 5));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');

    queue.fail(claimed, 'bad payload', { permanent: true });

    expect(queue.get(created.id)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('lost leases', () => {
  it('recovers a job from a crashed worker as a used attempt', () => {
    const { ambient, queue } = setup();
    const { job: created } = queue.enqueue(job('a'));
    queue.claim('crashed-worker', LEASE);

    ambient.advance(LEASE);
    const recovered = queue.recoverExpired();

    expect(recovered).toEqual([created.id]);
    expect(queue.get(created.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      leaseOwner: null,
    });
  });

  it('fails a crashed job that has no attempts left', () => {
    const { ambient, queue } = setup();
    const { job: created } = queue.enqueue(job('a', 1));
    queue.claim('crashed-worker', LEASE);

    ambient.advance(LEASE);
    queue.recoverExpired();

    expect(queue.get(created.id)).toMatchObject({ status: 'failed' });
  });

  it('leaves a running job alone while its lease is valid', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));
    queue.claim('worker-1', LEASE);

    ambient.advance(LEASE - 1);

    expect(queue.recoverExpired()).toEqual([]);
  });

  it('extends the lease on renewal', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');

    ambient.advance(LEASE - 1);
    expect(queue.renewLease(claimed, LEASE)).toBe(true);
    ambient.advance(LEASE - 1);

    expect(queue.recoverExpired()).toEqual([]);
  });

  it('stops a worker that lost its lease from overwriting the newer attempt', () => {
    const { ambient, queue } = setup();
    const { job: created } = queue.enqueue(job('a'));
    const stale = queue.claim('slow-worker', LEASE);
    if (!stale) throw new Error('expected a job');

    ambient.advance(LEASE);
    queue.recoverExpired();
    ambient.advance(retry.baseDelayMs);
    const current = queue.claim('slow-worker', LEASE);
    if (!current) throw new Error('expected a job');

    expect(queue.complete(stale, { from: 'stale' })).toBe(false);
    expect(queue.fail(stale, 'late failure')).toBe(false);
    expect(queue.renewLease(stale, LEASE)).toBe(false);
    expect(queue.get(created.id)).toMatchObject({ status: 'running', attempts: 2 });

    expect(queue.complete(current, { from: 'current' })).toBe(true);
    expect(queue.get(created.id)?.result).toEqual({ from: 'current' });
  });
});

describe('requeueExact', () => {
  it('requeues exactly the named jobs and leaves other failures alone', () => {
    const { ambient, queue } = setup();
    const named = exhaust(queue, ambient, 'a');
    const other = exhaust(queue, ambient, 'b');

    queue.requeueExact([named]);

    expect(queue.get(named)).toMatchObject({ status: 'queued', attempts: 0, requeueCount: 1 });
    expect(queue.get(other)).toMatchObject({ status: 'failed', requeueCount: 0 });
  });

  it('makes the job runnable straight away', () => {
    const { ambient, queue } = setup();
    const id = exhaust(queue, ambient, 'a');

    queue.requeueExact([id]);

    expect(queue.claim('worker-1', LEASE)?.id).toBe(id);
  });

  it('changes nothing if any id is unknown', () => {
    const { ambient, queue } = setup();
    const id = exhaust(queue, ambient, 'a');

    expect(() => queue.requeueExact([id, 'job_missing'])).toThrow(RequeueRefused);

    expect(queue.get(id)).toMatchObject({ status: 'failed', requeueCount: 0 });
  });

  it('changes nothing if any job is not failed', () => {
    const { ambient, queue } = setup();
    const failed = exhaust(queue, ambient, 'a');
    const { job: queued } = queue.enqueue(job('b'));

    expect(() => queue.requeueExact([failed, queued.id])).toThrow(/queued, not failed/);

    expect(queue.get(failed)).toMatchObject({ status: 'failed' });
  });

  it('refuses to requeue a job that succeeded', () => {
    const { queue } = setup();
    const { job: created } = queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');
    queue.complete(claimed, {});

    expect(() => queue.requeueExact([created.id])).toThrow(/succeeded, not failed/);
  });

  it('refuses an empty list rather than treating it as everything', () => {
    const { ambient, queue } = setup();
    const id = exhaust(queue, ambient, 'a');

    expect(() => queue.requeueExact([])).toThrow(RequeueRefused);

    expect(queue.get(id)).toMatchObject({ status: 'failed' });
  });

  it('refuses duplicate ids', () => {
    const { ambient, queue } = setup();
    const id = exhaust(queue, ambient, 'a');

    expect(() => queue.requeueExact([id, id])).toThrow(RequeueRefused);
  });
});

describe('stats', () => {
  it('reports an empty queue', () => {
    expect(setup().queue.stats()).toEqual({
      depth: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
      oldestDueAgeMs: null,
      lastSuccessAt: null,
    });
  });

  it('reports depth, age and the last success', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');
    ambient.advance(500);
    queue.complete(claimed, {});
    const succeededAt = ambient.now();
    queue.enqueue(job('b'));
    queue.enqueue(job('c'));
    ambient.advance(2_000);

    expect(queue.stats()).toMatchObject({
      depth: 2,
      succeeded: 1,
      oldestDueAgeMs: 2_000,
      lastSuccessAt: succeededAt,
    });
  });

  it('does not count a job waiting on backoff as overdue', () => {
    const { queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', LEASE);
    if (!claimed) throw new Error('expected a job');
    queue.fail(claimed, 'boom');

    expect(queue.stats()).toMatchObject({ depth: 1, oldestDueAgeMs: null });
  });
});
