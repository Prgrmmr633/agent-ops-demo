import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { CustomerStore } from '../../src/data/customers.ts';
import { openDb } from '../../src/db.ts';
import { createHandlers } from '../../src/jobs/handlers.ts';
import type { Job } from '../../src/jobs/queue.ts';
import { PermanentJobError } from '../../src/jobs/worker.ts';
import { connectInProcess, type McpTools } from '../../src/mcp/client.ts';
import { createDataServer } from '../../src/mcp/server.ts';

function jobOf(type: string, payload: Job['payload'], attempts = 1): Job {
  return {
    id: 'job_1',
    type,
    payload,
    idempotencyKey: 'key',
    status: 'running',
    attempts,
    maxAttempts: 3,
    runAt: 0,
    leaseOwner: 'worker-1',
    leaseExpiresAt: 0,
    lastError: null,
    result: null,
    requeueCount: 0,
    createdAt: 0,
    finishedAt: null,
  };
}

describe('job handlers', () => {
  let dir: string;
  let tools: McpTools;
  let store: CustomerStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
    store = new CustomerStore(openDb(':memory:'), fixedAmbient());
    store.insert({ id: 'cust-1', fields: { name: 'Juniper Vale', repairStatus: 'ready' } });
    store.insert({ id: 'cust-2', fields: { name: 'Otto Bramblewick', repairStatus: 'in_repair' } });
    store.insert({ id: 'cust-3', fields: { name: 'Wren Ashdown' } });
    tools = await connectInProcess(createDataServer(store, 'worker'));
  });

  afterEach(async () => {
    await tools.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('weekly_summary', () => {
    const job = jobOf('weekly_summary', { weekLabel: '2030-W02' });

    it('writes a valid PDF from data read through MCP', async () => {
      const result = await createHandlers(tools, dir).weekly_summary(job);

      expect(result).toMatchObject({ artifact: 'job_1.pdf', customers: 3 });
      const bytes = readFileSync(join(dir, 'job_1.pdf'));
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    });

    it('replaces the same file on a retry and leaves nothing else behind', async () => {
      const handlers = createHandlers(tools, dir);

      await handlers.weekly_summary(job);
      await handlers.weekly_summary({ ...job, attempts: 2 });

      expect(readdirSync(dir)).toEqual(['job_1.pdf']);
    });

    it('adds pages when the content is long', async () => {
      for (let index = 4; index <= 50; index++) {
        store.insert({ id: `cust-${index}`, fields: { name: `Customer ${index}` } });
      }

      await createHandlers(tools, dir).weekly_summary(job);

      const bytes = readFileSync(join(dir, 'job_1.pdf'));
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
    });

    it('survives text the PDF font cannot draw', async () => {
      store.insert({ id: 'cust-4', fields: { name: 'Ana ✅ 完了' } });

      await expect(createHandlers(tools, dir).weekly_summary(job)).resolves.toBeDefined();
    });

    it('fails permanently on a bad payload', async () => {
      await expect(
        createHandlers(tools, dir).weekly_summary(jobOf('weekly_summary', {})),
      ).rejects.toBeInstanceOf(PermanentJobError);
    });
  });

  describe('simulated_transcode', () => {
    const job = jobOf(
      'simulated_transcode',
      { sourceName: 'clip.mov', failUntilRequeued: true },
      2,
    );

    it('fails until the job has been requeued', async () => {
      const handlers = createHandlers(tools, dir);

      await expect(handlers.simulated_transcode(job)).rejects.toThrow('attempt 2');
      await expect(handlers.simulated_transcode({ ...job, requeueCount: 1 })).resolves.toEqual({
        output: 'clip.mov.mp4',
        simulated: true,
      });
    });
  });
});
