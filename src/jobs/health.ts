import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunningServer } from '../mcp/http.ts';
import type { JobQueue } from './queue.ts';

const STUCK_AFTER_MS = 5 * 60_000;

export interface HealthReport {
  status: 'ok' | 'degraded';
  queueDepth: number;
  running: number;
  failed: number;
  oldestDueAgeSeconds: number | null;
  lastSuccessAt: string | null;
}

/** `degraded` means a person should look: a job has failed for good or nothing is draining. */
export function healthReport(queue: JobQueue): HealthReport {
  const stats = queue.stats();
  const stuck = stats.oldestDueAgeMs !== null && stats.oldestDueAgeMs > STUCK_AFTER_MS;
  return {
    status: stats.failed > 0 || stuck ? 'degraded' : 'ok',
    queueDepth: stats.depth,
    running: stats.running,
    failed: stats.failed,
    oldestDueAgeSeconds:
      stats.oldestDueAgeMs === null ? null : Math.floor(stats.oldestDueAgeMs / 1000),
    lastSuccessAt:
      stats.lastSuccessAt === null ? null : new Date(stats.lastSuccessAt).toISOString(),
  };
}

export async function startHealthServer(
  queue: JobQueue,
  host: string,
  port: number,
): Promise<RunningServer> {
  const server = createServer((req, res) => {
    const found = req.method === 'GET' && req.url === '/healthz';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(found ? healthReport(queue) : { error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
