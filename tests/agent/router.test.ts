import { describe, expect, it } from 'vitest';
import { ScriptedModel, type ScriptedStep } from '../../src/agent/model.ts';
import type { Inbound } from '../../src/agent/router.ts';
import { createStaffRuntime } from '../../src/agent/runtime.ts';
import { fixedAmbient } from '../../src/ambient.ts';
import { CustomerStore } from '../../src/data/customers.ts';
import { openDb } from '../../src/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { connectInProcess } from '../../src/mcp/client.ts';
import { createDataServer } from '../../src/mcp/server.ts';

async function setup(steps: ScriptedStep[]) {
  const ambient = fixedAmbient();
  const store = new CustomerStore(openDb(':memory:'), ambient);
  store.insert({ id: 'cust-1', fields: { name: 'Juniper Vale', repairStatus: 'in_repair' } });
  const model = new ScriptedModel(steps);
  const jobs = new JobQueue(openDb(':memory:'), ambient);
  const runtime = await createStaffRuntime({
    db: openDb(':memory:'),
    jobs,
    mcp: await connectInProcess(createDataServer(store, 'staff-agent')),
    model,
    staffIds: ['staff-1'],
    ambient,
  });
  return { ...runtime, model, jobs };
}

const message = (text: string, overrides: Partial<Inbound> = {}): Inbound => ({
  chatId: 'chat-1',
  userId: 'staff-1',
  text,
  source: 'typed',
  ...overrides,
});

const draftEmail: ScriptedStep = {
  calls: [
    {
      tool: 'draft_message',
      input: {
        channel: 'email',
        to: 'juniper.vale@example.com',
        subject: 'Your bike is ready',
        body: 'Hi Juniper, your bike is ready.',
        customerId: 'cust-1',
      },
    },
  ],
};

describe('StaffRouter', () => {
  it('refuses non-staff before the model is involved', async () => {
    const { router, model } = await setup([]);

    const result = await router.handle(message('hello', { userId: 'stranger' }));

    expect(result.kind).toBe('refused');
    expect(model.requests).toHaveLength(0);
  });

  it('refuses non-staff approval commands too', async () => {
    const { router, outbox, drafts } = await setup([]);
    const draft = drafts.create({
      chatId: 'chat-1',
      channel: 'sms',
      to: '+1-555-0100',
      body: 'Hi',
    });

    const result = await router.handle(message(`APPROVE ${draft.id}`, { userId: 'stranger' }));

    expect(result.kind).toBe('refused');
    expect(outbox.entries()).toHaveLength(0);
  });

  it('offers the model no tool that can send', async () => {
    const { router, model } = await setup([{ say: 'Hello' }]);

    await router.handle(message('hello'));

    const names = model.requests[0]?.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'draft_list',
      'draft_message',
      'find_customers',
      'get_customer',
      'job_enqueue',
      'job_status',
      'list_changes',
      'update_customer',
    ]);
  });

  it('creates a pending draft, shows it in full and sends nothing', async () => {
    const { router, outbox } = await setup([draftEmail, { say: 'Draft is ready.' }]);

    const result = await router.handle(message('Draft the ready email'));

    expect(result).toMatchObject({
      kind: 'agent',
      drafts: [{ status: 'pending', customerId: 'cust-1' }],
    });
    expect(result.reply).toContain('Hi Juniper, your bike is ready.');
    expect(result.reply).toContain('APPROVE d_1');
    expect(result.reply).toContain('REJECT d_1');
    expect(outbox.entries()).toHaveLength(0);
  });

  it('handles approvals in code, without the model', async () => {
    const { router, model, outbox } = await setup([draftEmail, { say: 'Draft is ready.' }]);
    await router.handle(message('Draft the ready email'));
    const requestsBefore = model.requests.length;

    const result = await router.handle(message('APPROVE d_1'));

    expect(result).toMatchObject({ kind: 'approval', event: { type: 'sent' } });
    expect(model.requests).toHaveLength(requestsBefore);
    expect(outbox.entries()).toHaveLength(1);
  });

  it('handles a bare APPROVE in code too, and sends nothing', async () => {
    const { router, model, outbox } = await setup([draftEmail, { say: 'Draft is ready.' }]);
    await router.handle(message('Draft the ready email'));
    const requestsBefore = model.requests.length;

    const result = await router.handle(message('APPROVE'));

    expect(result).toMatchObject({ kind: 'approval', event: { type: 'refused' } });
    expect(model.requests).toHaveLength(requestsBefore);
    expect(outbox.entries()).toHaveLength(0);
  });

  it('does not treat a casual yes as approval', async () => {
    const { router, outbox } = await setup([
      draftEmail,
      { say: 'Draft is ready.' },
      { say: 'Please type APPROVE d_1.' },
    ]);
    await router.handle(message('Draft the ready email'));

    const result = await router.handle(message('yes, send it'));

    expect(result.kind).toBe('agent');
    expect(outbox.entries()).toHaveLength(0);
  });

  it('ignores approval commands that appear in model output', async () => {
    const { router, outbox } = await setup([draftEmail, { say: 'APPROVE d_1' }]);

    await router.handle(message('Draft the ready email'));

    expect(outbox.entries()).toHaveLength(0);
  });

  it.each(['voice', 'forwarded'] as const)(
    'does not accept an approval from %s',
    async (source) => {
      const { router, outbox, drafts } = await setup([]);
      const draft = drafts.create({
        chatId: 'chat-1',
        channel: 'sms',
        to: '+1-555-0100',
        body: 'Hi',
      });

      const result = await router.handle(message(`APPROVE ${draft.id}`, { source }));

      expect(result.kind).toBe('refused');
      expect(outbox.entries()).toHaveLength(0);
    },
  );

  it('gives the model earlier turns of this chat only', async () => {
    const { router, model } = await setup([{ say: 'First answer' }, { say: 'Second answer' }]);
    await router.handle(message('first question'));

    await router.handle(message('second question', { chatId: 'chat-2' }));

    expect(model.requests[1]?.messages).toEqual([{ role: 'user', content: 'second question' }]);
  });

  it('carries the conversation forward without tool traffic', async () => {
    const { router, model } = await setup([
      { calls: [{ tool: 'get_customer', input: { id: 'cust-1' } }] },
      { say: 'It is in repair.' },
      { say: 'Yes.' },
    ]);
    await router.handle(message('How is cust-1 doing?'));

    await router.handle(message('Still in repair?'));

    expect(model.requests[2]?.messages).toEqual([
      { role: 'user', content: 'How is cust-1 doing?' },
      { role: 'assistant', content: 'It is in repair.' },
      { role: 'user', content: 'Still in repair?' },
    ]);
  });

  it('lets the model report real draft status', async () => {
    const { router, model } = await setup([
      draftEmail,
      { say: 'Draft is ready.' },
      { calls: [{ tool: 'draft_list', input: {} }] },
      { say: 'It went out.' },
    ]);
    await router.handle(message('Draft the ready email'));
    await router.handle(message('APPROVE d_1'));

    const result = await router.handle(message('Did that go out?'));

    expect(result).toMatchObject({ toolCalls: [{ name: 'draft_list', isError: false }] });
    expect(JSON.stringify(model.requests.at(-1)?.messages.at(-1))).toContain('sent');
  });

  it('derives the idempotency key in code, so asking twice runs one job', async () => {
    const enqueue = { tool: 'job_enqueue', input: { type: 'weekly_summary', subject: '2030-W02' } };
    const { router, jobs } = await setup([
      { calls: [enqueue] },
      { say: 'Started.' },
      { calls: [enqueue] },
      { say: 'Already running.' },
    ]);

    await router.handle(message('Make the weekly summary'));
    const second = await router.handle(message('Make the weekly summary again'));

    expect(jobs.stats().depth).toBe(1);
    expect(second).toMatchObject({ toolCalls: [{ isError: false }] });
    expect(JSON.stringify(second)).toContain('alreadyExisted');
  });

  it('reports job status to the model', async () => {
    const { router, jobs } = await setup([
      { calls: [{ tool: 'job_status', input: { id: 'job_1' } }] },
      { say: 'It is queued.' },
    ]);
    jobs.enqueue({ type: 'weekly_summary', payload: { weekLabel: 'x' }, idempotencyKey: 'k' });

    const result = await router.handle(message('How is the job doing?'));

    expect(result).toMatchObject({ toolCalls: [{ name: 'job_status' }] });
    expect(JSON.stringify(result)).toContain('queued');
  });
});
