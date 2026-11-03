import { describe, expect, it, vi } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { type JobHandler, PermanentJobError, Worker } from '../../src/jobs/worker.ts';

function setup(handlers: Record<string, JobHandler>, leaseMs?: number) {
  const ambient = fixedAmbient();
  const queue = new JobQueue(openDb(':memory:'), ambient, {
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
  });
  const worker = new Worker({
    queue,
    handlers,
    workerId: 'worker-1',
    pollMs: 1,
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
  return { ambient, queue, worker };
}

const newJob = (type = 'demo', maxAttempts = 3) => ({
  type,
  payload: {},
  idempotencyKey: `${type}-key`,
  maxAttempts,
});

describe('Worker', () => {
  it('returns null when there is nothing to do', async () => {
    const { worker } = setup({});
    expect(await worker.runOnce()).toBeNull();
  });

  it('runs a job and stores its result', async () => {
    const { queue, worker } = setup({ demo: async () => ({ answer: 42 }) });
    queue.enqueue(newJob());

    const finished = await worker.runOnce();

    expect(finished).toMatchObject({ status: 'succeeded', result: { answer: 42 } });
  });

  it('retries a failing job after backoff until it succeeds', async () => {
    const handler = vi
      .fn<JobHandler>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue({ ok: true });
    const { ambient, queue, worker } = setup({ demo: handler });
    queue.enqueue(newJob());

    const first = await worker.runOnce();
    expect(first).toMatchObject({ status: 'queued', attempts: 1, lastError: 'first failure' });

    expect(await worker.runOnce()).toBeNull();

    ambient.advance(1_000);
    expect(await worker.runOnce()).toMatchObject({ status: 'queued', attempts: 2 });

    ambient.advance(2_000);
    expect(await worker.runOnce()).toMatchObject({
      status: 'succeeded',
      attempts: 3,
      lastError: null,
    });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('stops after the last attempt and keeps the error', async () => {
    const { ambient, queue, worker } = setup({
      demo: async () => {
        throw new Error('always fails');
      },
    });
    queue.enqueue(newJob('demo', 2));

    await worker.runOnce();
    ambient.advance(1_000);
    const finished = await worker.runOnce();
    ambient.advance(60_000);

    expect(finished).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'always fails',
    });
    expect(await worker.runOnce()).toBeNull();
  });

  it('does not retry a permanent error', async () => {
    const handler = vi.fn<JobHandler>().mockRejectedValue(new PermanentJobError('bad payload'));
    const { queue, worker } = setup({ demo: handler });
    queue.enqueue(newJob());

    const finished = await worker.runOnce();

    expect(finished).toMatchObject({ status: 'failed', attempts: 1 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fails a job with no handler without retrying', async () => {
    const { queue, worker } = setup({});
    queue.enqueue(newJob('unknown'));

    expect(await worker.runOnce()).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'No handler for job type unknown.',
    });
  });

  it('recovers a crashed job before looking for new work', async () => {
    const { ambient, queue, worker } = setup({ demo: async () => ({ ok: true }) });
    const { job } = queue.enqueue(newJob());
    queue.claim('crashed-worker', 5_000);

    ambient.advance(6_000);
    await worker.runOnce();
    ambient.advance(1_000);
    const finished = await worker.runOnce();

    expect(finished).toMatchObject({ id: job.id, status: 'succeeded', attempts: 2 });
  });

  it('keeps renewing the lease while a slow job runs', async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { queue, worker } = setup(
      {
        demo: async () => {
          await blocked;
          return {};
        },
      },
      20,
    );
    const renew = vi.spyOn(queue, 'renewLease');
    queue.enqueue(newJob());

    const running = worker.runOnce();
    await vi.waitFor(() => expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2));
    release();
    await running;

    const calls = renew.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(renew.mock.calls.length).toBe(calls);
  });

  it('runs until aborted, draining what is due', async () => {
    const stop = new AbortController();
    const seen: string[] = [];
    const { queue, worker } = setup({
      demo: async (job) => {
        seen.push(job.idempotencyKey);
        if (seen.length === 2) stop.abort();
        return {};
      },
    });
    queue.enqueue({ ...newJob(), idempotencyKey: 'one' });
    queue.enqueue({ ...newJob(), idempotencyKey: 'two' });

    await worker.run(stop.signal);

    expect(seen).toEqual(['one', 'two']);
  });

  it('stops promptly while idle', async () => {
    const stop = new AbortController();
    const { worker } = setup({});

    const running = worker.run(stop.signal);
    stop.abort();

    await expect(running).resolves.toBeUndefined();
  });
});
