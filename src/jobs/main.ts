import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dataPath, loadWorkerConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { connectOverHttp } from '../mcp/client.ts';
import { createHandlers } from './handlers.ts';
import { startHealthServer } from './health.ts';
import { JobQueue } from './queue.ts';
import { Worker } from './worker.ts';

const config = loadWorkerConfig();
const queue = new JobQueue(openDb(dataPath(process.env, 'jobs.db')));
const artifactDir = dataPath(process.env, 'artifacts');
mkdirSync(artifactDir, { recursive: true });

const tools = await connectOverHttp(config.MCP_URL, config.MCP_AUTH_TOKEN);
const health = await startHealthServer(queue, config.HEALTH_HOST, config.HEALTH_PORT);
console.log(`Worker health on ${health.url}/healthz`);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => stop.abort());
}

const worker = new Worker({
  queue,
  handlers: createHandlers(tools, artifactDir),
  workerId: `${hostname()}-${process.pid}`,
});
await worker.run(stop.signal);

await Promise.all([health.close(), tools.close()]);
