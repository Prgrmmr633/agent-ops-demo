import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { openDb } from '../../src/db.ts';
import { LocalOutbox, type OutboundMessage } from '../../src/outbound/adapter.ts';
import { ApprovalGate } from '../../src/outbound/approval.ts';
import { DraftStore } from '../../src/outbound/drafts.ts';
import { VoiceRenderingOutbound } from '../../src/voice/outbound.ts';
import { FakeVoice } from '../fake-voice.ts';

const message = (channel: OutboundMessage['channel']): OutboundMessage => ({
  draftId: 'd_1',
  channel,
  to: '+1-555-0101',
  subject: null,
  body: 'Hello Juniper',
  approvedBy: 'staff-1',
});

const staff = { chatId: 'chat-1', userId: 'staff-1' };

describe('VoiceRenderingOutbound', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(voice = new FakeVoice()) {
    const ambient = fixedAmbient();
    const db = openDb(':memory:');
    const outbox = new LocalOutbox(db, ambient);
    const drafts = new DraftStore(db, ambient);
    const adapter = new VoiceRenderingOutbound(outbox, voice, dir);
    return { voice, outbox, drafts, adapter, gate: new ApprovalGate(drafts, adapter) };
  }

  it('renders a voice message to a file and then delivers it', async () => {
    const { adapter, outbox } = setup();

    await adapter.send(message('voice'));

    expect(readFileSync(join(dir, 'd_1.mp3'), 'utf8')).toBe('audio:Hello Juniper');
    expect(outbox.entries()).toHaveLength(1);
  });

  it('does not render other channels', async () => {
    const { adapter, voice } = setup();

    await adapter.send(message('sms'));

    expect(voice.spoken).toEqual([]);
    expect(existsSync(join(dir, 'd_1.mp3'))).toBe(false);
  });

  it('generates no speech until a draft is approved', async () => {
    const { voice, drafts, gate } = setup();
    const draft = drafts.create({
      chatId: 'chat-1',
      channel: 'voice',
      to: '+1-555-0101',
      body: 'Hello',
    });

    expect(voice.spoken).toEqual([]);

    await gate.handle({ kind: 'approve', draftId: draft.id }, staff);

    expect(voice.spoken).toEqual(['Hello']);
  });

  it('records a failed send when rendering fails, and delivers nothing', async () => {
    const voice = new FakeVoice();
    vi.spyOn(voice, 'synthesize').mockRejectedValue(new Error('provider down'));
    const { outbox, drafts, gate } = setup(voice);
    const draft = drafts.create({
      chatId: 'chat-1',
      channel: 'voice',
      to: '+1-555-0101',
      body: 'Hello',
    });

    await gate.handle({ kind: 'approve', draftId: draft.id }, staff);

    expect(outbox.entries()).toHaveLength(0);
    expect(drafts.get(draft.id)).toMatchObject({ status: 'failed', error: 'provider down' });
  });
});
