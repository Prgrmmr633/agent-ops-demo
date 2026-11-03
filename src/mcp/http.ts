import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CustomerStore } from '../data/customers.ts';
import { createDataServer } from './server.ts';

export interface HttpOptions {
  store: CustomerStore;
  actor: string;
  token: string;
  host: string;
  port: number;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  return timingSafeEqual(digest(supplied), digest(token));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Stateless Streamable HTTP: each POST gets its own MCP server and transport. */
async function handleMcp(req: IncomingMessage, res: ServerResponse, options: HttpOptions) {
  const server = createDataServer(options.store, options.actor);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export async function startDataHttpServer(options: HttpOptions): Promise<RunningServer> {
  const httpServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
    } else if (path !== '/mcp') {
      sendJson(res, 404, { error: 'not_found' });
    } else if (!isAuthorized(req, options.token)) {
      sendJson(res, 401, { error: 'unauthorized' });
    } else if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
    } else {
      handleMcp(req, res, options).catch((error: unknown) => {
        console.error('MCP request failed', error);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, options.host, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://${options.host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      }),
  };
}
