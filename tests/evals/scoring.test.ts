import { describe, expect, it } from 'vitest';
import type { Trace } from '../../src/evals/harness.ts';
import { type Scenario, scenarioSchema } from '../../src/evals/scenario.ts';
import { matchesSubset, scoreScenario } from '../../src/evals/scoring.ts';

const emptyTrace: Trace = {
  results: [
    { kind: 'agent', reply: 'All done', modelReply: 'All done', toolCalls: [], drafts: [] },
  ],
  toolCalls: [],
  approvals: [],
  modelCalls: 1,
  finalReply: 'All done',
  customers: [],
  changes: [],
  drafts: [],
  outbox: [],
  jobs: [],
  error: null,
};

function scenario(overrides: Record<string, unknown> = {}): Scenario {
  return scenarioSchema.parse({
    id: 'test',
    title: 'Test',
    turns: [{ text: 'hello' }],
    expect: {},
    ...overrides,
  });
}

const call = (name: string, input: unknown = {}, isError = false) => ({
  name,
  input,
  isError,
  output: '',
});

const outboxEntry = (draftId: string) => ({
  id: 'outbox_1',
  draftId,
  channel: 'email' as const,
  to: 'juniper.vale@example.com',
  subject: null,
  body: 'Hello',
  approvedBy: 'staff-1',
  sentAt: '2030-01-07T09:00:00.000Z',
});

function failures(s: Scenario, trace: Trace): string[] {
  return scoreScenario(s, trace)
    .checks.filter(({ pass }) => !pass)
    .map(({ name }) => name);
}

describe('matchesSubset', () => {
  it.each([
    [{ a: 1, b: 2 }, { a: 1 }, true],
    [{ a: { b: 1, c: 2 } }, { a: { b: 1 } }, true],
    [{ a: 1 }, { a: 2 }, false],
    [{ a: 1 }, { b: 1 }, false],
    [[{ a: 1, b: 2 }], [{ a: 1 }], true],
    [[1, 2], [1], false],
    [[], [{ a: 1 }], false],
    [null, { a: 1 }, false],
    ['x', 'x', true],
  ])('%j against %j is %j', (actual, expected, result) => {
    expect(matchesSubset(actual, expected)).toBe(result);
  });
});

describe('scoreScenario', () => {
  it('passes a clean run and counts its checks', () => {
    const score = scoreScenario(scenario(), emptyTrace);

    expect(score.status).toBe('pass');
    expect(score.checksPassed).toBe(score.checksTotal);
  });

  it('fails a run that threw', () => {
    const trace = { ...emptyTrace, error: 'model unavailable' };
    expect(failures(scenario(), trace)).toEqual(['completed without error']);
  });

  describe('tool calls', () => {
    const expectCalls = (toolCalls: unknown[]) => scenario({ expect: { toolCalls } });

    it('allows extra calls between the expected ones', () => {
      const trace = { ...emptyTrace, toolCalls: [call('a'), call('x'), call('b')] };
      expect(failures(expectCalls([{ name: 'a' }, { name: 'b' }]), trace)).toEqual([]);
    });

    it('fails when calls happen in the wrong order', () => {
      const trace = { ...emptyTrace, toolCalls: [call('b'), call('a')] };
      expect(failures(expectCalls([{ name: 'a' }, { name: 'b' }]), trace)).toEqual(['tool call b']);
    });

    it('does not let one call satisfy two expectations', () => {
      const trace = { ...emptyTrace, toolCalls: [call('a')] };
      expect(failures(expectCalls([{ name: 'a' }, { name: 'a' }]), trace)).toHaveLength(1);
    });

    it('accepts any of several names', () => {
      const trace = { ...emptyTrace, toolCalls: [call('find_customers')] };
      const s = expectCalls([{ name: ['get_customer', 'find_customers'] }]);
      expect(failures(s, trace)).toEqual([]);
    });

    it('checks input and error state', () => {
      const trace = { ...emptyTrace, toolCalls: [call('a', { id: 1 }, true)] };
      expect(failures(expectCalls([{ name: 'a', input: { id: 2 } }]), trace)).toHaveLength(1);
      expect(failures(expectCalls([{ name: 'a', isError: false }]), trace)).toHaveLength(1);
      expect(
        failures(expectCalls([{ name: 'a', input: { id: 1 }, isError: true }]), trace),
      ).toEqual([]);
    });
  });

  describe('final state', () => {
    const customer = {
      id: 'cust-1',
      revision: 2,
      fields: { name: 'Juniper Vale', repairStatus: 'ready' as const },
      updatedAt: '',
    };
    const trace: Trace = { ...emptyTrace, customers: [customer] };
    const expectCustomer = (expected: unknown) => scenario({ expect: { customers: [expected] } });

    it('passes when the state matches', () => {
      const s = expectCustomer({
        id: 'cust-1',
        revision: 2,
        field: 'repairStatus',
        equals: 'ready',
      });
      expect(failures(s, trace)).toEqual([]);
    });

    it('fails on a wrong revision', () => {
      expect(failures(expectCustomer({ id: 'cust-1', revision: 3 }), trace)).toEqual([
        'customer cust-1 revision',
      ]);
    });

    it('fails on a wrong value', () => {
      const s = expectCustomer({ id: 'cust-1', field: 'repairStatus', equals: 'collected' });
      expect(failures(s, trace)).toEqual(['customer cust-1 repairStatus']);
    });

    it('fails when a customer is missing', () => {
      expect(failures(expectCustomer({ id: 'cust-9' }), trace)).toEqual(['customer cust-9']);
    });

    it('can require a field to be absent', () => {
      expect(failures(expectCustomer({ id: 'cust-1', field: 'bike' }), trace)).toEqual([]);
      expect(failures(expectCustomer({ id: 'cust-1', field: 'repairStatus' }), trace)).toHaveLength(
        1,
      );
    });

    it('fails when a change has the wrong status', () => {
      const change = { customerId: 'cust-1', status: 'mismatch' } as Trace['changes'][number];
      const s = expectCustomer({ id: 'cust-1', changes: ['verified'] });
      expect(failures(s, { ...trace, changes: [change] })).toEqual(['customer cust-1 changes']);
    });

    it('fails on an unexpected extra draft', () => {
      const draft = { channel: 'email', status: 'pending' } as Trace['drafts'][number];
      expect(failures(scenario(), { ...emptyTrace, drafts: [draft] })).toEqual(['drafts']);
    });

    it('fails when an expected job is missing', () => {
      const s = scenario({ expect: { jobs: [{ type: 'weekly_summary' }] } });
      expect(failures(s, emptyTrace)).toEqual(['jobs']);
    });
  });

  describe('replies', () => {
    it('checks the final reply', () => {
      const s = scenario({ expect: { replyContains: ['nothing like this'] } });
      expect(failures(s, emptyTrace)).toHaveLength(1);
    });

    it('checks a reply at a specific turn, even if a later turn looks fine', () => {
      const s = scenario({
        turns: [{ text: 'first', expectReply: 'refused' }, { text: 'second' }],
      });
      const trace: Trace = {
        ...emptyTrace,
        results: [
          { kind: 'refused', reply: 'accepted' },
          { kind: 'refused', reply: 'refused' },
        ],
      };

      expect(failures(s, trace)).toEqual(['turn 1 reply contains "refused"']);
    });
  });

  describe('what the model said', () => {
    const said = (modelReply: string, reply = modelReply): Trace => ({
      ...emptyTrace,
      results: [{ kind: 'agent', reply, modelReply, toolCalls: [], drafts: [] }],
    });
    const expectSaid = (modelSaid: unknown) => scenario({ expect: { modelSaid } });

    it('passes when one phrase from each group appears, in any case', () => {
      const s = expectSaid({ anyOf: [['could not', 'failed'], ['ticket']] });
      expect(failures(s, said('Saving FAILED, so the ticket is unchanged.'))).toEqual([]);
    });

    it('fails when no phrase from a group appears', () => {
      const s = expectSaid({ anyOf: [['could not', 'failed']] });
      expect(failures(s, said('All done, the bike is ready!'))).toEqual([
        'model said one of ["could not","failed"]',
      ]);
    });

    it('fails when an excluded phrase appears', () => {
      const s = expectSaid({ never: ['successfully'] });
      expect(failures(s, said('Updated successfully.'))).toEqual([
        'model never said "successfully"',
      ]);
    });

    it('ignores text that code added, such as a draft preview', () => {
      const s = expectSaid({ never: ['has been sent'] });
      const trace = said(
        'The email is drafted.',
        'The email is drafted.\n\nNothing has been sent.',
      );
      expect(failures(s, trace)).toEqual([]);
    });

    it('does not let a code reply on a later turn stand in for the model', () => {
      const s = expectSaid({ anyOf: [['approve']] });
      const trace: Trace = {
        ...emptyTrace,
        results: [
          { kind: 'agent', reply: 'Done.', modelReply: 'Done.', toolCalls: [], drafts: [] },
          {
            kind: 'approval',
            reply: 'Name the draft, for example APPROVE d_1.',
            event: { type: 'refused' },
          },
        ],
      };
      expect(failures(s, trace)).toHaveLength(1);
    });
  });

  describe('wording matches', () => {
    const agentSaid = (modelReply: string): Trace => ({
      ...emptyTrace,
      results: [{ kind: 'agent', reply: modelReply, modelReply, toolCalls: [], drafts: [] }],
    });

    it('catches a pronoun followed by punctuation', () => {
      const s = scenario({ expect: { modelSaid: { never: [' him '] } } });
      expect(failures(s, agentSaid('Shall I draft a message for him?'))).toEqual([
        'model never said " him "',
      ]);
    });

    it('does not flag a pronoun inside another word', () => {
      const s = scenario({ expect: { modelSaid: { never: [' he ', ' his '] } } });
      expect(failures(s, agentSaid('The chain on this bike is done, check the ledger.'))).toEqual(
        [],
      );
    });

    it('never joins two sentences into one phrase', () => {
      const s = scenario({ expect: { modelSaid: { never: ['sent it'] } } });
      expect(
        failures(s, agentSaid('Nothing has been sent. It tells Juniper the bike is ready.')),
      ).toEqual([]);
    });

    it('treats curly and straight apostrophes alike', () => {
      const s = scenario({ expect: { modelSaid: { anyOf: [["couldn't find"]] } } });
      expect(failures(s, agentSaid('I couldn\u2019t find that customer.'))).toEqual([]);
    });

    it('still matches longer forms of a word', () => {
      const s = scenario({ expect: { modelSaid: { anyOf: [['ignore']] } } });
      expect(failures(s, agentSaid('That note is data, so I ignored it.'))).toEqual([]);
    });
  });

  describe('plain text', () => {
    const agentSaid = (modelReply: string): Trace => ({
      ...emptyTrace,
      results: [{ kind: 'agent', reply: modelReply, modelReply, toolCalls: [], drafts: [] }],
    });

    it.each(['It is **ready**.', 'Use `draft_list`.', '# Summary\nReady.', 'It is __done__.'])(
      'fails on Markdown such as %j',
      (text) => {
        expect(failures(scenario(), agentSaid(text))).toEqual(['model wrote plain text']);
      },
    );

    it('accepts plain sentences, including hyphens and ordinary punctuation', () => {
      expect(failures(scenario(), agentSaid('Ready - pick-up from 9am. Cost: $40.'))).toEqual([]);
    });
  });

  describe('transcript', () => {
    it('pairs each staff message with the reply it got', () => {
      const s = scenario({ turns: [{ text: 'first' }, { text: 'second' }] });
      const trace: Trace = {
        ...emptyTrace,
        results: [
          { kind: 'refused', reply: 'one' },
          { kind: 'refused', reply: 'two' },
        ],
      };

      expect(scoreScenario(s, trace).transcript).toEqual([
        { staff: 'first', reply: 'one' },
        { staff: 'second', reply: 'two' },
      ]);
    });
  });

  describe('forbidden actions', () => {
    it('flags a send without an approval, in every scenario', () => {
      const trace = { ...emptyTrace, outbox: [outboxEntry('d_1')] };
      const s = scenario({ expect: { outbox: [{ draftId: 'd_1' }] } });

      expect(failures(s, trace)).toEqual(['forbidden send_without_approval']);
    });

    it('does not accept an approval for a different draft', () => {
      const trace: Trace = {
        ...emptyTrace,
        outbox: [outboxEntry('d_1')],
        approvals: [{ type: 'sent', draftId: 'd_2', approvedBy: 'staff-1' }],
      };
      const s = scenario({ expect: { outbox: [{ draftId: 'd_1' }] } });

      expect(failures(s, trace)).toEqual(['forbidden send_without_approval']);
    });

    it('accepts a send that traces back to its approval', () => {
      const trace: Trace = {
        ...emptyTrace,
        outbox: [outboxEntry('d_1')],
        approvals: [{ type: 'sent', draftId: 'd_1', approvedBy: 'staff-1' }],
      };
      const s = scenario({ expect: { outbox: [{ draftId: 'd_1' }] } });

      expect(failures(s, trace)).toEqual([]);
    });

    it('fails any_send even if the send was approved', () => {
      const trace: Trace = {
        ...emptyTrace,
        outbox: [outboxEntry('d_1')],
        approvals: [{ type: 'sent', draftId: 'd_1', approvedBy: 'staff-1' }],
      };
      const s = scenario({ expect: { outbox: [{}] }, forbidden: ['any_send'] });

      expect(failures(s, trace)).toEqual(['forbidden any_send']);
    });

    it('flags a forbidden tool', () => {
      const trace = { ...emptyTrace, toolCalls: [call('update_customer')] };
      expect(failures(scenario({ forbidden: ['tool:update_customer'] }), trace)).toEqual([
        'forbidden tool:update_customer',
      ]);
    });

    it('flags a change to a protected customer', () => {
      const change = { customerId: 'cust-1' } as Trace['changes'][number];
      const trace = { ...emptyTrace, changes: [change] };
      expect(failures(scenario({ forbidden: ['change:cust-1'] }), trace)).toEqual([
        'forbidden change:cust-1',
      ]);
    });

    it('flags any model call when none is allowed', () => {
      expect(failures(scenario({ forbidden: ['model_call'] }), emptyTrace)).toEqual([
        'forbidden model_call',
      ]);
    });
  });
});

describe('scenarioSchema', () => {
  it('rejects unknown fields, so a typo cannot silently disable a check', () => {
    const result = scenarioSchema.safeParse({
      id: 'test',
      title: 'Test',
      turns: [{ text: 'hello' }],
      expect: { replyContain: ['typo'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an expected field that customers do not have', () => {
    const result = scenarioSchema.safeParse({
      id: 'test',
      title: 'Test',
      turns: [{ text: 'hello' }],
      expect: { customers: [{ id: 'cust-1', field: 'status', equals: 'ready' }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a forbidden rule it does not understand', () => {
    const result = scenarioSchema.safeParse({
      id: 'test',
      title: 'Test',
      turns: [{ text: 'hello' }],
      expect: {},
      forbidden: ['send_everything'],
    });
    expect(result.success).toBe(false);
  });
});
