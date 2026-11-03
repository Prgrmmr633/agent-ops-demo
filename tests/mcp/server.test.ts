import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { CustomerStore } from '../../src/data/customers.ts';
import { openDb } from '../../src/db.ts';
import { connectInProcess, type McpTools } from '../../src/mcp/client.ts';
import { createDataServer } from '../../src/mcp/server.ts';

const juniper = {
  id: 'cust-1',
  fields: { name: 'Juniper Vale', repairStatus: 'in_repair' as const },
};

describe('data MCP server', () => {
  let store: CustomerStore;
  let tools: McpTools;

  beforeEach(async () => {
    store = new CustomerStore(openDb(':memory:'), fixedAmbient());
    store.insert(juniper);
    tools = await connectInProcess(createDataServer(store, 'staff-agent'));
  });

  afterEach(() => tools.close());

  async function call(name: string, args: Record<string, unknown>) {
    const outcome = await tools.call(name, args);
    return { isError: outcome.isError, body: JSON.parse(outcome.text) };
  }

  const markReady = {
    id: 'cust-1',
    revision: 1,
    changes: { repairStatus: 'ready' },
    reason: 'Repair finished',
  };

  it('exposes exactly the four customer tools', async () => {
    const names = (await tools.list()).map((tool) => tool.name).sort();
    expect(names).toEqual(['find_customers', 'get_customer', 'list_changes', 'update_customer']);
  });

  it('describes each tool with an input schema', async () => {
    for (const tool of await tools.list()) {
      expect(tool.description).not.toBe('');
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('lists the named fields update_customer accepts, and nothing else', async () => {
    const update = (await tools.list()).find((tool) => tool.name === 'update_customer');
    if (!update) throw new Error('update_customer is missing');
    const schema = update.inputSchema as { properties: { changes: Record<string, unknown> } };
    const { changes } = schema.properties;

    expect(Object.keys(changes.properties as object).sort()).toEqual([
      'bike',
      'email',
      'name',
      'phone',
      'repairNotes',
      'repairStatus',
    ]);
    expect(changes.additionalProperties).toBe(false);
  });

  it('finds and gets customers', async () => {
    const found = await call('find_customers', { query: 'juniper' });
    const got = await call('get_customer', { id: 'cust-1' });

    expect(found.body.customers).toMatchObject([{ id: 'cust-1', revision: 1 }]);
    expect(got.body.customer).toMatchObject({ fields: { name: 'Juniper Vale' } });
  });

  it('flags a missing customer as a tool error', async () => {
    const got = await call('get_customer', { id: 'cust-404' });
    expect(got).toMatchObject({ isError: true, body: { error: 'not_found' } });
  });

  it('applies a field patch and returns the re-read and change record', async () => {
    const updated = await call('update_customer', markReady);

    expect(updated).toMatchObject({
      isError: false,
      body: {
        ok: true,
        customer: { revision: 2, fields: { name: 'Juniper Vale', repairStatus: 'ready' } },
        change: { status: 'verified', reason: 'Repair finished' },
      },
    });
  });

  it('reports a stale revision as a tool error', async () => {
    const updated = await call('update_customer', { ...markReady, revision: 9 });
    expect(updated).toMatchObject({ isError: true, body: { error: 'revision_conflict' } });
  });

  it('reports a failed re-read as a tool error', async () => {
    const db = openDb(':memory:');
    const faulty = new CustomerStore(db, fixedAmbient());
    faulty.insert(juniper);
    db.exec(`
      CREATE TRIGGER drop_status AFTER UPDATE OF fields ON customers
      BEGIN UPDATE customers SET fields = json_remove(fields, '$.repairStatus') WHERE id = NEW.id; END;
    `);
    const client = await connectInProcess(createDataServer(faulty, 'staff-agent'));

    const outcome = await client.call('update_customer', markReady);

    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.text)).toMatchObject({ error: 'verification_failed' });
    await client.close();
  });

  it.each([
    ['no revision', { ...markReady, revision: undefined }],
    ['a generic path operation', { ...markReady, changes: { '/repairStatus': 'ready' } }],
    ['an unknown field', { ...markReady, changes: { status: 'ready' } }],
    ['set and remove operations', { ...markReady, changes: [{ op: 'set', path: '/x' }] }],
  ])('rejects %s before touching data', async (_label, args) => {
    const outcome = await tools.call('update_customer', args);

    expect(outcome.isError).toBe(true);
    expect(store.get('cust-1')).toMatchObject({ revision: 1 });
  });

  it('never reports success while quietly dropping a field it does not know', async () => {
    const outcome = await tools.call('update_customer', {
      ...markReady,
      changes: { repairStatus: 'ready', pickupDate: 'Friday' },
    });

    expect(outcome.isError).toBe(true);
    expect(store.get('cust-1')).toMatchObject({ revision: 1 });
  });

  it('takes the audit actor from the server, not the caller', async () => {
    await tools.call('update_customer', { ...markReady, actor: 'someone-else' });

    const listed = await call('list_changes', { id: 'cust-1' });
    expect(listed.body.changes).toMatchObject([{ actor: 'staff-agent' }]);
  });
});
