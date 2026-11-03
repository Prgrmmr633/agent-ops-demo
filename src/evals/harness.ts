import type { ToolCallRecord } from '../agent/loop.ts';
import type { ModelClient, ModelReply, ModelRequest } from '../agent/model.ts';
import type { RouterResult } from '../agent/router.ts';
import { createStaffRuntime } from '../agent/runtime.ts';
import { fixedAmbient } from '../ambient.ts';
import { type Change, type Customer, CustomerStore } from '../data/customers.ts';
import { type Db, openDb } from '../db.ts';
import { JobQueue } from '../jobs/queue.ts';
import { connectInProcess } from '../mcp/client.ts';
import { createDataServer } from '../mcp/server.ts';
import type { OutboxEntry } from '../outbound/adapter.ts';
import type { ApprovalEvent } from '../outbound/approval.ts';
import type { Draft } from '../outbound/drafts.ts';
import { SEED_CUSTOMERS } from '../seed-data.ts';
import type { Scenario } from './scenario.ts';

/** Everything observed in a run. Scoring reads only this. */
export interface Trace {
  results: RouterResult[];
  toolCalls: ToolCallRecord[];
  approvals: ApprovalEvent[];
  modelCalls: number;
  finalReply: string;
  customers: Customer[];
  changes: Change[];
  drafts: Draft[];
  outbox: OutboxEntry[];
  jobs: Array<{ type: string; status: string; idempotencyKey: string }>;
  error: string | null;
}

const FAULT_SQL = {
  drop_repair_status_on_write: `
    CREATE TRIGGER eval_fault AFTER UPDATE OF fields ON customers
    BEGIN UPDATE customers SET fields = json_remove(fields, '$.repairStatus') WHERE id = NEW.id; END;
  `,
} as const;

class CountingModel implements ModelClient {
  calls = 0;
  private readonly inner: ModelClient;

  constructor(inner: ModelClient) {
    this.inner = inner;
  }

  complete(request: ModelRequest): Promise<ModelReply> {
    this.calls++;
    return this.inner.complete(request);
  }
}

function listJobs(db: Db): Trace['jobs'] {
  const rows = db.prepare('SELECT type, status, idempotency_key FROM jobs ORDER BY rowid').all();
  return (rows as unknown as Array<{ type: string; status: string; idempotency_key: string }>).map(
    ({ type, status, idempotency_key }) => ({ type, status, idempotencyKey: idempotency_key }),
  );
}

/**
 * Runs a scenario through the real stack: real store, real MCP client and server,
 * real router and gate. Only the model changes between modes.
 */
export async function runScenario(scenario: Scenario, model: ModelClient): Promise<Trace> {
  const ambient = fixedAmbient();
  const customersDb = openDb(':memory:');
  const jobsDb = openDb(':memory:');
  const store = new CustomerStore(customersDb, ambient);
  for (const customer of SEED_CUSTOMERS) store.insert(customer);

  const mcp = await connectInProcess(createDataServer(store, 'staff-agent'));
  const jobs = new JobQueue(jobsDb, ambient);
  const counting = new CountingModel(model);
  const runtime = await createStaffRuntime({
    db: openDb(':memory:'),
    jobs,
    mcp,
    model: counting,
    staffIds: ['staff-1'],
    ambient,
  });
  for (const fault of scenario.faults) customersDb.exec(FAULT_SQL[fault]);

  const results: RouterResult[] = [];
  let error: string | null = null;
  try {
    for (const turn of scenario.turns) {
      if (turn.otherStaffEdit) {
        const { id, changes } = turn.otherStaffEdit;
        store.update({
          id,
          revision: store.get(id)?.revision ?? 0,
          changes,
          actor: 'other-staff',
          reason: 'Edit made by another staff member',
        });
      }
      results.push(
        await runtime.router.handle({
          chatId: 'chat-1',
          userId: turn.userId,
          text: turn.text,
          source: turn.source,
        }),
      );
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  await mcp.close();

  const customers = store.find({ limit: 50 });
  return {
    results,
    toolCalls: results.flatMap((result) => (result.kind === 'agent' ? result.toolCalls : [])),
    approvals: results.flatMap((result) => (result.kind === 'approval' ? [result.event] : [])),
    modelCalls: counting.calls,
    finalReply: results.at(-1)?.reply ?? '',
    customers,
    changes: customers.flatMap((customer) => store.changes(customer.id)),
    drafts: runtime.drafts.recent('chat-1').toReversed(),
    outbox: runtime.outbox.entries(),
    jobs: listJobs(jobsDb),
    error,
  };
}
