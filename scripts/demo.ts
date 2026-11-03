/**
 * A self-contained walkthrough on fake data. It uses the real store, MCP server,
 * router, gate and job queue. Only the model is scripted, so no keys are needed.
 *
 *   npm run demo            Runs straight through.
 *   npm run demo -- --slow  Pauses between sections, for screen recording.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ScriptedModel, type ScriptedStep } from '../src/agent/model.ts';
import { createStaffRuntime } from '../src/agent/runtime.ts';
import { fixedAmbient } from '../src/ambient.ts';
import { CustomerStore } from '../src/data/customers.ts';
import { openDb } from '../src/db.ts';
import { createHandlers } from '../src/jobs/handlers.ts';
import { healthReport } from '../src/jobs/health.ts';
import { JobQueue } from '../src/jobs/queue.ts';
import { runRecoveryCommand } from '../src/jobs/recovery.ts';
import { Worker } from '../src/jobs/worker.ts';
import { connectInProcess } from '../src/mcp/client.ts';
import { createDataServer } from '../src/mcp/server.ts';
import { SEED_CUSTOMERS } from '../src/seed-data.ts';

const SECTION_PAUSE_MS = process.argv.includes('--slow') ? 8_000 : 0;
const RETRY_DELAY_MS = 1_000;

const markReady = (revision: number): ScriptedStep => ({
  calls: [
    {
      tool: 'update_customer',
      input: {
        id: 'cust-2004',
        revision,
        changes: { repairStatus: 'ready' },
        reason: 'Staff marked the repair as finished',
      },
    },
  ],
});

const script: ScriptedStep[] = [
  { calls: [{ tool: 'find_customers', input: { query: 'Juniper Vale' } }] },
  {
    calls: [
      {
        tool: 'draft_message',
        input: {
          channel: 'email',
          to: 'juniper.vale@example.com',
          subject: 'Your bike is ready',
          body: 'Hi Juniper, your folding commuter is ready for pickup.',
          customerId: 'cust-2001',
        },
      },
    ],
  },
  { say: 'The email is drafted. I cannot send it myself.' },
  { say: 'I can’t send it. Please type APPROVE d_1 exactly.' },
  markReady(1),
  { calls: [{ tool: 'get_customer', input: { id: 'cust-2004' } }] },
  markReady(2),
  { say: 'Tobias Fernsworth’s bike is ready. The record had changed, so I re-read it first.' },
  { calls: [{ tool: 'job_enqueue', input: { type: 'weekly_summary', subject: '2030-W02' } }] },
  { say: 'The weekly summary job has started.' },
];

const ambient = fixedAmbient();
const store = new CustomerStore(openDb(':memory:'), ambient);
for (const customer of SEED_CUSTOMERS) store.insert(customer);

const mcp = await connectInProcess(createDataServer(store, 'staff-agent'));
const jobs = new JobQueue(openDb(':memory:'), ambient, {
  baseDelayMs: RETRY_DELAY_MS,
  maxDelayMs: RETRY_DELAY_MS,
});
const { router, outbox } = await createStaffRuntime({
  db: openDb(':memory:'),
  jobs,
  mcp,
  model: new ScriptedModel(script),
  staffIds: ['staff-1'],
  ambient,
});

const artifactDir = resolve('data/demo');
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });
const worker = new Worker({
  queue: jobs,
  handlers: createHandlers(mcp, artifactDir),
  workerId: 'demo-worker',
});

let firstSection = true;

async function section(title: string) {
  if (!firstSection) await sleep(SECTION_PAUSE_MS);
  firstSection = false;
  console.log(`\n=== ${title}`);
}

async function staffSays(text: string) {
  console.log(`\nstaff> ${text}`);
  const result = await router.handle({ chatId: 'demo', userId: 'staff-1', text, source: 'typed' });
  if (result.kind === 'agent') {
    for (const { name, isError } of result.toolCalls) {
      console.log(`  tool: ${name}${isError ? ' (rejected)' : ''}`);
    }
  }
  console.log(`agent> ${result.reply}`);
}

const outboxCount = () => console.log(`\noutbox: ${outbox.entries().length} message(s)`);

function jobsCommand(...args: string[]) {
  console.log(`\n$ npm run jobs -- ${args.join(' ')}`);
  runRecoveryCommand(args, jobs, (line) => console.log(line));
}

function showHealth() {
  const { status, queueDepth, failed, lastSuccessAt } = healthReport(jobs);
  console.log(`\nhealth: ${JSON.stringify({ status, queueDepth, failed, lastSuccessAt })}`);
}

await section(`Seeded ${SEED_CUSTOMERS.length} fake customers for an invented bike shop`);

await section('Drafting is not sending');
await staffSays("Juniper Vale's bike is ready. Draft an email to let them know.");
outboxCount();

await section('Only the exact typed command approves');
await staffSays('yes, send it');
outboxCount();
await staffSays('APPROVE d_1');
outboxCount();
await staffSays('APPROVE d_1');
outboxCount();

await section('A stale update is rejected, then redone on fresh data');
store.update({
  id: 'cust-2004',
  revision: 1,
  changes: { repairNotes: 'Rear wheel trued. Brake pads fitted. Prefers a text.' },
  actor: 'another-staff-member',
  reason: 'Added a note',
});
console.log('\n(another staff member edits Tobias Fernsworth’s notes first)');
await staffSays("Mark Tobias Fernsworth's bike as ready.");
const [change] = store.changes('cust-2004');
console.log(`\nchange: ${JSON.stringify(change)}`);

await section('A long job runs in the background');
await staffSays('Generate the weekly summary for 2030-W02.');
const summary = await worker.runOnce();
const artifact = String(summary?.result?.artifact);
console.log(`\nworker: ${summary?.status}, wrote ${relative('.', resolve(artifactDir, artifact))}`);

await section('A failing job retries with backoff, then stops');
const failing = jobs.enqueue({
  type: 'simulated_transcode',
  payload: { sourceName: 'shop-tour.mov', failUntilRequeued: true },
  idempotencyKey: 'transcode:shop-tour.mov',
  maxAttempts: 2,
}).job;
for (let attempt = 1; attempt <= 2; attempt++) {
  const state = await worker.runOnce();
  console.log(`\nattempt ${attempt}: ${state?.status}, ${state?.lastError}`);
  ambient.advance(RETRY_DELAY_MS);
}
showHealth();

await section('Recovery takes exact ids, never a blanket replay');
jobsCommand('failed');
jobsCommand('requeue', '--all');
jobsCommand('requeue', failing.id);
const recovered = await worker.runOnce();
console.log(`\nworker: ${recovered?.status}, ${JSON.stringify(recovered?.result)}`);
showHealth();

await mcp.close();
await sleep(SECTION_PAUSE_MS);
console.log('\nDemo finished. All names and records are invented.');
