import { describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { runRecoveryCommand } from '../../src/jobs/recovery.ts';

function setup() {
  const queue = new JobQueue(openDb(':memory:'), fixedAmbient());
  const failedIds = ['a', 'b'].map((key) => {
    queue.enqueue({ type: 'demo', payload: {}, idempotencyKey: key, maxAttempts: 1 });
    const claimed = queue.claim('worker-1', 1_000);
    if (!claimed) throw new Error('expected a job');
    queue.fail(claimed, `failure ${key}`);
    return claimed.id;
  });
  const lines: string[] = [];
  const run = (...args: string[]) => runRecoveryCommand(args, queue, (line) => lines.push(line));
  return { queue, failedIds, lines, run };
}

describe('recovery command', () => {
  it('lists failed jobs with their errors', () => {
    const { lines, run } = setup();

    expect(run('failed')).toBe(0);

    expect(lines).toEqual([
      'job_1  demo  attempts=1  failure a',
      'job_2  demo  attempts=1  failure b',
    ]);
  });

  it('says so when nothing has failed', () => {
    const queue = new JobQueue(openDb(':memory:'), fixedAmbient());
    const lines: string[] = [];

    runRecoveryCommand(['failed'], queue, (line) => lines.push(line));

    expect(lines).toEqual(['No failed jobs.']);
  });

  it('requeues only the ids it is given', () => {
    const { queue, failedIds, run } = setup();
    const [first, second] = failedIds as [string, string];

    expect(run('requeue', first)).toBe(0);

    expect(queue.get(first)?.status).toBe('queued');
    expect(queue.get(second)?.status).toBe('failed');
  });

  it.each([['--all'], ['*'], ['all'], ['job_*'], ['job_1,job_2'], ['failed']])(
    'refuses %s as a blanket selector',
    (selector) => {
      const { queue, lines, run } = setup();

      expect(run('requeue', selector)).toBe(2);

      expect(queue.listFailed()).toHaveLength(2);
      expect(lines.at(-1)).toContain('Nothing was requeued');
    },
  );

  it('refuses a selector mixed in with a valid id, and requeues neither', () => {
    const { queue, failedIds, run } = setup();

    expect(run('requeue', failedIds[0] as string, '--all')).toBe(2);

    expect(queue.listFailed()).toHaveLength(2);
  });

  it('prints usage when no ids are given', () => {
    const { queue, lines, run } = setup();

    expect(run('requeue')).toBe(2);

    expect(lines.join('\n')).toContain('no option to requeue everything');
    expect(queue.listFailed()).toHaveLength(2);
  });

  it('reports a refused requeue and changes nothing', () => {
    const { queue, failedIds, lines, run } = setup();

    expect(run('requeue', failedIds[0] as string, 'job_404')).toBe(1);

    expect(lines).toEqual(['No job with id job_404. Nothing was requeued.']);
    expect(queue.listFailed()).toHaveLength(2);
  });

  it('prints usage for an unknown command', () => {
    const { run } = setup();
    expect(run('replay-all')).toBe(2);
  });
});
