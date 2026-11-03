import { describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { healthReport, startHealthServer } from '../../src/jobs/health.ts';
import { JobQueue } from '../../src/jobs/queue.ts';

function setup() {
  const ambient = fixedAmbient();
  return { ambient, queue: new JobQueue(openDb(':memory:'), ambient) };
}

const job = (key: string, maxAttempts = 3) => ({
  type: 'demo',
  payload: {},
  idempotencyKey: key,
  maxAttempts,
});

describe('healthReport', () => {
  it('is ok when idle', () => {
    expect(healthReport(setup().queue)).toEqual({
      status: 'ok',
      queueDepth: 0,
      running: 0,
      failed: 0,
      oldestDueAgeSeconds: null,
      lastSuccessAt: null,
    });
  });

  it('reports queue depth and the last success', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));
    const claimed = queue.claim('worker-1', 1_000);
    if (!claimed) throw new Error('expected a job');
    queue.complete(claimed, {});
    queue.enqueue(job('b'));
    ambient.advance(3_000);

    expect(healthReport(queue)).toMatchObject({
      status: 'ok',
      queueDepth: 1,
      oldestDueAgeSeconds: 3,
      lastSuccessAt: '2030-01-07T09:00:00.000Z',
    });
  });

  it('is degraded when a job has failed for good', () => {
    const { queue } = setup();
    queue.enqueue(job('a', 1));
    const claimed = queue.claim('worker-1', 1_000);
    if (!claimed) throw new Error('expected a job');
    queue.fail(claimed, 'boom');

    expect(healthReport(queue)).toMatchObject({ status: 'degraded', failed: 1 });
  });

  it('is degraded when due work is not draining', () => {
    const { ambient, queue } = setup();
    queue.enqueue(job('a'));

    ambient.advance(5 * 60_000 + 1);

    expect(healthReport(queue).status).toBe('degraded');
  });
});

describe('health endpoint', () => {
  it('serves the report as JSON', async () => {
    const { queue } = setup();
    queue.enqueue(job('a'));
    const server = await startHealthServer(queue, '127.0.0.1', 0);

    const response = await fetch(`${server.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', queueDepth: 1 });
    await server.close();
  });

  it('returns 404 for anything else', async () => {
    const server = await startHealthServer(setup().queue, '127.0.0.1', 0);

    const response = await fetch(`${server.url}/jobs`);

    expect(response.status).toBe(404);
    await server.close();
  });
});
