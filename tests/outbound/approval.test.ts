import { describe, expect, it, vi } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { LocalOutbox, type OutboundAdapter } from '../../src/outbound/adapter.ts';
import {
  ApprovalGate,
  formatDraftPreview,
  parseApprovalCommand,
} from '../../src/outbound/approval.ts';
import { DraftStore, type NewDraft } from '../../src/outbound/drafts.ts';

const staff = { chatId: 'chat-1', userId: 'staff-1' };

const emailDraft: NewDraft = {
  chatId: 'chat-1',
  channel: 'email',
  to: 'juniper.vale@example.com',
  subject: 'Your bike is ready',
  body: 'Hi Juniper, your bike is ready for pickup.',
};

function setup(adapter?: OutboundAdapter) {
  const db = openDb(':memory:');
  const ambient = fixedAmbient();
  const drafts = new DraftStore(db, ambient);
  const outbox = new LocalOutbox(db, ambient);
  return { drafts, outbox, gate: new ApprovalGate(drafts, adapter ?? outbox) };
}

const approve = (draftId: string) => ({ kind: 'approve', draftId }) as const;

describe('parseApprovalCommand', () => {
  it.each([
    ['APPROVE d_42', { kind: 'approve', draftId: 'd_42' }],
    ['REJECT d_42', { kind: 'reject', draftId: 'd_42' }],
    ['  APPROVE d_42  ', { kind: 'approve', draftId: 'd_42' }],
    ['APPROVE', { kind: 'approve' }],
    ['REJECT', { kind: 'reject' }],
  ])('accepts %j', (text, expected) => {
    expect(parseApprovalCommand(text)).toEqual(expected);
  });

  it.each([
    'approve d_1',
    'Approve d_1',
    'APPROVED d_1',
    'yes',
    'yes, send it',
    'approved',
    'please APPROVE d_1',
    'APPROVE d_1 please',
    'APPROVE d_1\nand also this',
    'APPROVE  d_1',
    'APPROVE d_1 d_2',
    'I APPROVE d_1',
    'SEND EMAIL',
    'SEND EMAIL d_1',
    'SEND SMS',
    'CALL',
  ])('does not treat %j as an approval', (text) => {
    expect(parseApprovalCommand(text)).toBeNull();
  });
});

describe('ApprovalGate', () => {
  it('sends nothing when a draft is created', () => {
    const { drafts, outbox } = setup();

    const draft = drafts.create(emailDraft);

    expect(draft.status).toBe('pending');
    expect(outbox.entries()).toHaveLength(0);
  });

  it('sends the exact draft and records who approved it', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);

    const result = await gate.handle(approve(draft.id), staff);

    expect(result.event).toEqual({ type: 'sent', draftId: draft.id, approvedBy: 'staff-1' });
    expect(outbox.entries()).toMatchObject([
      {
        draftId: draft.id,
        to: emailDraft.to,
        subject: emailDraft.subject,
        body: emailDraft.body,
        approvedBy: 'staff-1',
      },
    ]);
    expect(drafts.get(draft.id)).toMatchObject({ status: 'sent', decidedBy: 'staff-1' });
  });

  it('does not send twice when approved twice', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);

    await gate.handle(approve(draft.id), staff);
    const second = await gate.handle(approve(draft.id), staff);

    expect(second).toEqual({
      reply: `Draft ${draft.id} has already been handled.`,
      event: { type: 'refused' },
    });
    expect(outbox.entries()).toHaveLength(1);
  });

  it('lets only one of two simultaneous approvals send', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);

    const results = await Promise.all([
      gate.handle(approve(draft.id), staff),
      gate.handle(approve(draft.id), staff),
    ]);

    expect(results.map((result) => result.event.type).sort()).toEqual(['refused', 'sent']);
    expect(outbox.entries()).toHaveLength(1);
  });

  it('asks which draft, rather than guessing, even when only one is waiting', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);

    const result = await gate.handle({ kind: 'approve' }, staff);

    expect(result.event).toEqual({ type: 'refused' });
    expect(result.reply).toBe(
      `Name the draft, for example APPROVE ${draft.id}. Waiting: ${draft.id}.`,
    );
    expect(outbox.entries()).toHaveLength(0);
    expect(drafts.get(draft.id)?.status).toBe('pending');
  });

  it('lists every waiting draft for a bare command', async () => {
    const { drafts, gate } = setup();
    const first = drafts.create(emailDraft);
    const second = drafts.create({ ...emailDraft, to: 'otto.bramblewick@example.com' });

    const result = await gate.handle({ kind: 'reject' }, staff);

    expect(result.reply).toContain(`REJECT ${first.id}`);
    expect(result.reply).toContain(`Waiting: ${first.id}, ${second.id}.`);
  });

  it('says so when nothing is waiting', async () => {
    const { gate } = setup();

    const result = await gate.handle({ kind: 'approve' }, staff);

    expect(result.reply).toBe('No drafts are waiting in this chat.');
  });

  it('sends only the named draft when several are waiting', async () => {
    const { drafts, outbox, gate } = setup();
    drafts.create(emailDraft);
    const second = drafts.create({ ...emailDraft, to: 'otto.bramblewick@example.com' });

    await gate.handle(approve(second.id), staff);

    expect(outbox.entries()).toMatchObject([{ draftId: second.id }]);
    expect(drafts.pending('chat-1')).toHaveLength(1);
  });

  it('refuses an id it does not know', async () => {
    const { outbox, gate } = setup();

    const result = await gate.handle(approve('d_404'), staff);

    expect(result.reply).toBe('No draft d_404 in this chat.');
    expect(outbox.entries()).toHaveLength(0);
  });

  it('keeps drafts private to their chat', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);
    const outsider = { chatId: 'chat-2', userId: 'staff-2' };

    const approved = await gate.handle(approve(draft.id), outsider);
    const rejected = await gate.handle({ kind: 'reject', draftId: draft.id }, outsider);

    expect(approved.reply).toBe(`No draft ${draft.id} in this chat.`);
    expect(rejected.event).toEqual({ type: 'refused' });
    expect(outbox.entries()).toHaveLength(0);
    expect(drafts.get(draft.id)?.status).toBe('pending');
  });

  it('never sends a rejected draft', async () => {
    const { drafts, outbox, gate } = setup();
    const draft = drafts.create(emailDraft);

    const rejected = await gate.handle({ kind: 'reject', draftId: draft.id }, staff);
    const approved = await gate.handle(approve(draft.id), staff);

    expect(rejected.event).toEqual({ type: 'rejected', draftId: draft.id });
    expect(approved.event).toEqual({ type: 'refused' });
    expect(outbox.entries()).toHaveLength(0);
    expect(drafts.get(draft.id)).toMatchObject({ status: 'rejected', decidedBy: 'staff-1' });
  });

  it('cannot reject a draft that was already sent', async () => {
    const { drafts, gate } = setup();
    const draft = drafts.create(emailDraft);
    await gate.handle(approve(draft.id), staff);

    const rejected = await gate.handle({ kind: 'reject', draftId: draft.id }, staff);

    expect(rejected.event).toEqual({ type: 'refused' });
    expect(drafts.get(draft.id)?.status).toBe('sent');
  });

  it('records a failed send and does not retry', async () => {
    const send = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const { drafts, gate } = setup({ send });
    const draft = drafts.create(emailDraft);

    const first = await gate.handle(approve(draft.id), staff);
    const second = await gate.handle(approve(draft.id), staff);

    expect(first.event).toEqual({ type: 'failed', draftId: draft.id });
    expect(second.event).toEqual({ type: 'refused' });
    expect(send).toHaveBeenCalledOnce();
    expect(drafts.get(draft.id)).toMatchObject({
      status: 'failed',
      error: 'provider unavailable',
    });
  });
});

describe('LocalOutbox', () => {
  it('refuses a second row for one draft, whatever the caller does', async () => {
    const { outbox } = setup();
    const message = {
      draftId: 'd_1',
      channel: 'email',
      to: emailDraft.to,
      subject: null,
      body: 'Hello',
      approvedBy: 'staff-1',
    } as const;

    await outbox.send(message);

    await expect(outbox.send(message)).rejects.toThrow(/UNIQUE/);
    expect(outbox.entries()).toHaveLength(1);
  });
});

describe('formatDraftPreview', () => {
  it('shows the full text and both exact commands, and says nothing was sent', () => {
    const { drafts } = setup();
    const draft = drafts.create(emailDraft);

    const preview = formatDraftPreview(draft);

    expect(preview).toContain(emailDraft.body);
    expect(preview).toContain(`Subject: ${emailDraft.subject}`);
    expect(preview).toContain(`APPROVE ${draft.id}`);
    expect(preview).toContain(`REJECT ${draft.id}`);
    expect(preview).toContain('Nothing has been sent');
  });
});
