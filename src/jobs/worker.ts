import { setTimeout as sleep } from 'node:timers/promises';
import type { JsonObject } from '../json.ts';
import type { Job, JobQueue } from './queue.ts';

export type JobHandler = (job: Job) => Promise<JsonObject>;

/** Thrown when retrying cannot help, such as a malformed payload. */
export class PermanentJobError extends Error {}

export interface WorkerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  workerId: string;
  leaseMs?: number;
  pollMs?: number;
}

export class Worker {
  private readonly queue: JobQueue;
  private readonly handlers: Record<string, JobHandler>;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;

  constructor(options: WorkerOptions) {
    this.queue = options.queue;
    this.handlers = options.handlers;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollMs = options.pollMs ?? 1_000;
  }

  /** Runs at most one job and returns its state afterwards, or null if none was due. */
  async runOnce(): Promise<Job | null> {
    this.queue.recoverExpired();
    const job = this.queue.claim(this.workerId, this.leaseMs);
    if (!job) return null;

    // Keeps the lease alive for as long as a slow job is really still running.
    const heartbeat = setInterval(() => this.queue.renewLease(job, this.leaseMs), this.leaseMs / 2);
    try {
      const handler = this.handlers[job.type];
      if (!handler) throw new PermanentJobError(`No handler for job type ${job.type}.`);
      this.queue.complete(job, await handler(job));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.queue.fail(job, message, { permanent: error instanceof PermanentJobError });
    } finally {
      clearInterval(heartbeat);
    }
    return this.queue.get(job.id);
  }

  /** Polls until the signal aborts. A job in progress finishes first. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = await this.runOnce();
      if (!job) await sleep(this.pollMs, undefined, { signal }).catch(() => {});
    }
  }
}
