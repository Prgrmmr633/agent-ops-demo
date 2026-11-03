import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { CustomerStore } from '../../src/data/customers.ts';
import { openDb } from '../../src/db.ts';
import { connectOverHttp } from '../../src/mcp/client.ts';
import { type RunningServer, startDataHttpServer } from '../../src/mcp/http.ts';

const token = 'test-token-not-a-secret';

describe('data service over HTTP', () => {
  let server: RunningServer;

  beforeEach(async () => {
    const store = new CustomerStore(openDb(':memory:'), fixedAmbient());
    store.insert({ id: 'cust-1', fields: { name: 'Juniper Vale', repairStatus: 'in_repair' } });
    server = await startDataHttpServer({
      store,
      actor: 'staff-agent',
      token,
      host: '127.0.0.1',
      port: 0,
    });
  });

  afterEach(() => server.close());

  it('serves the tools to an authenticated MCP client', async () => {
    const tools = await connectOverHttp(server.url, token);

    const first = await tools.call('get_customer', { id: 'cust-1' });
    const updated = await tools.call('update_customer', {
      id: 'cust-1',
      revision: 1,
      changes: { repairStatus: 'ready' },
      reason: 'Repair finished',
    });

    expect(JSON.parse(first.text)).toMatchObject({ customer: { revision: 1 } });
    expect(JSON.parse(updated.text)).toMatchObject({ ok: true, customer: { revision: 2 } });
    await tools.close();
  });

  it('refuses a client with the wrong token', async () => {
    await expect(connectOverHttp(server.url, 'wrong-token-value')).rejects.toThrow();
  });

  it('refuses a request with no token', async () => {
    const response = await fetch(`${server.url}/mcp`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('answers health checks without a token', async () => {
    const response = await fetch(`${server.url}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown paths', async () => {
    const response = await fetch(`${server.url}/nope`);
    expect(response.status).toBe(404);
  });
});
