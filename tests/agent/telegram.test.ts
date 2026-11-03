import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inbound, RouterResult, StaffRouter } from '../../src/agent/router.ts';
import { createBot, splitForTelegram } from '../../src/agent/telegram.ts';
import { FakeVoice } from '../fake-voice.ts';

const botInfo = { id: 1, is_bot: true, first_name: 'Test bot' } as UserFromGetMe;

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function setup(handle: (inbound: Inbound) => Promise<RouterResult>, voice?: FakeVoice) {
  const router = { handle: vi.fn(handle) } as unknown as StaffRouter;
  const bot = createBot({ token: 'test-token', router, voice, botInfo });
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === 'getFile' ? { file_id: 'f1', file_path: 'voice/1.oga' } : true;
    return { ok: true, result } as never;
  });
  const sent = () =>
    calls.filter(({ method }) => method === 'sendMessage').map(({ payload }) => payload.text);
  return { bot, calls, sent, router };
}

function textUpdate(text: string, extra: Record<string, unknown> = {}): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 100, type: 'private', first_name: 'Staff' },
      from: { id: 7, is_bot: false, first_name: 'Staff' },
      text,
      ...extra,
    },
  } as Update;
}

function voiceUpdate(extra: Record<string, unknown> = {}): Update {
  const { message } = textUpdate('') as unknown as { message: Record<string, unknown> };
  const { text: _text, ...rest } = message;
  const voice = { file_id: 'f1', file_unique_id: 'u1', duration: 2 };
  return { update_id: 1, message: { ...rest, voice, ...extra } } as unknown as Update;
}

// A message posted inside a forum topic of a group.
const inTopic = (thread: number) => ({
  chat: { id: -1001, type: 'supergroup', title: 'Team', is_forum: true },
  is_topic_message: true,
  message_thread_id: thread,
});

const agentResult = (modelReply: string, previews = ''): RouterResult => ({
  kind: 'agent',
  modelReply,
  reply: previews ? `${modelReply}\n\n${previews}` : modelReply,
  toolCalls: [],
  drafts: [],
});

describe('Telegram bot', () => {
  it('passes typed text to the router and replies', async () => {
    const { bot, sent, router } = setup(async () => ({ kind: 'refused', reply: 'Hello back' }));

    await bot.handleUpdate(textUpdate('hello'));

    expect(router.handle).toHaveBeenCalledWith({
      chatId: '100',
      userId: '7',
      text: 'hello',
      source: 'typed',
    });
    expect(sent()).toEqual(['Hello back']);
  });

  it('marks forwarded messages so that they cannot approve', async () => {
    const { bot, router } = setup(async () => ({ kind: 'refused', reply: 'No' }));

    await bot.handleUpdate(
      textUpdate('APPROVE d_1', {
        forward_origin: { type: 'hidden_user', date: 0, sender_user_name: 'Someone' },
      }),
    );

    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({ source: 'forwarded' }));
  });

  it('ignores edited messages', async () => {
    const { bot, router } = setup(async () => ({ kind: 'refused', reply: 'No' }));
    const { message } = textUpdate('APPROVE d_1') as { message: Update['message'] };

    await bot.handleUpdate({ update_id: 2, edited_message: message } as Update);

    expect(router.handle).not.toHaveBeenCalled();
  });

  it('tells staff when handling fails, without exposing the error', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bot, sent } = setup(async () => {
      throw new Error('internal detail');
    });

    await bot.handleUpdate(textUpdate('hello'));

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).not.toContain('internal detail');
    quiet.mockRestore();
  });

  it('splits long replies', async () => {
    const { bot, sent } = setup(async () => ({ kind: 'refused', reply: 'x'.repeat(5000) }));

    await bot.handleUpdate(textUpdate('hello'));

    expect(sent().map((text) => String(text).length)).toEqual([4096, 904]);
  });
});

describe('forum topics', () => {
  it('treats each topic as its own conversation', async () => {
    const { bot, router } = setup(async () => ({ kind: 'refused', reply: 'Ok' }));

    await bot.handleUpdate(textUpdate('in chat', inTopic(11)));
    await bot.handleUpdate(textUpdate('in call', inTopic(22)));

    const ids = vi.mocked(router.handle).mock.calls.map(([inbound]) => inbound.chatId);
    expect(ids).toEqual(['-1001:11', '-1001:22']);
  });

  it('replies in the topic the message came from', async () => {
    const { bot, calls } = setup(async () => ({ kind: 'refused', reply: 'Ok' }));

    await bot.handleUpdate(textUpdate('hello', inTopic(11)));

    expect(calls.find(({ method }) => method === 'sendMessage')?.payload).toMatchObject({
      message_thread_id: 11,
      text: 'Ok',
    });
  });
});

describe('voice notes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('transcribes a voice note and marks it as voice', async () => {
    const { bot, router } = setup(
      async () => ({ kind: 'refused', reply: 'Ok' }),
      new FakeVoice('APPROVE d_1'),
    );

    await bot.handleUpdate(voiceUpdate());

    expect(router.handle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'APPROVE d_1', source: 'voice' }),
    );
  });

  it('answers a voice note with a voice note of the agent’s own words', async () => {
    const voice = new FakeVoice();
    const { bot, calls, sent } = setup(async () => agentResult('Juniper’s bike is ready.'), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual(['Juniper’s bike is ready.']);
    expect(voice.formats).toEqual(['voice_note']);
    expect(calls.map(({ method }) => method)).toContain('sendVoice');
    expect(sent()).toEqual([]);
  });

  it('keeps drafts and their commands as text after the spoken reply', async () => {
    const voice = new FakeVoice();
    const preview = 'Draft d_1 (email) to someone@example.com\nNothing has been sent.';
    const { bot, calls, sent } = setup(async () => agentResult('I drafted it.', preview), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual(['I drafted it.']);
    const methods = calls.map(({ method }) => method).filter((m) => m !== 'getFile');
    expect(methods).toEqual(['sendVoice', 'sendMessage']);
    expect(sent()).toEqual([preview]);
  });

  it('does not read ids or phone numbers aloud, and sends the whole reply in writing', async () => {
    const voice = new FakeVoice();
    const words =
      'I’ve drafted a text to Tobias Fernsworth at +1-555-0104. To send it, type APPROVE d_1.';
    const preview = 'Draft d_1 (sms) to +1-555-0104\nNothing has been sent.';
    const { bot, calls, sent } = setup(async () => agentResult(words, preview), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual([
      'I’ve drafted a text to Tobias Fernsworth. The details are in the message below.',
    ]);
    const methods = calls.map(({ method }) => method).filter((m) => m !== 'getFile');
    expect(methods).toEqual(['sendVoice', 'sendMessage']);
    expect(sent()).toEqual([`${words}\n\n${preview}`]);
  });

  it('answers in text alone when nothing is left to say aloud', async () => {
    const voice = new FakeVoice();
    const reply = 'Name the draft, for example APPROVE d_1. Waiting: d_1.';
    const { bot, calls, sent } = setup(async () => ({ kind: 'refused', reply }), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual([]);
    expect(calls.map(({ method }) => method)).not.toContain('sendVoice');
    expect(sent()).toEqual([reply]);
  });

  it('speaks a refusal too, so a spoken approval is answered aloud and sends nothing', async () => {
    const voice = new FakeVoice('APPROVE d_1');
    const refusal = 'Approvals must be typed by staff in this chat.';
    const { bot } = setup(async () => ({ kind: 'refused', reply: refusal }), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual([refusal]);
  });

  it('replies in the same topic when answering by voice', async () => {
    const { bot, calls } = setup(async () => agentResult('Done.'), new FakeVoice());

    await bot.handleUpdate(voiceUpdate(inTopic(22)));

    expect(calls.find(({ method }) => method === 'sendVoice')?.payload).toMatchObject({
      message_thread_id: 22,
    });
  });

  it('falls back to text when speech fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const voice = new FakeVoice();
    vi.spyOn(voice, 'synthesize').mockRejectedValue(new Error('provider down'));
    const { bot, calls, sent } = setup(async () => agentResult('Done.'), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(calls.map(({ method }) => method)).not.toContain('sendVoice');
    expect(sent()).toEqual(['Done.']);
    quiet.mockRestore();
  });

  it('sends a very long reply as text instead of speaking it', async () => {
    const voice = new FakeVoice();
    const long = 'word '.repeat(300).trim();
    const { bot, sent } = setup(async () => agentResult(long), voice);

    await bot.handleUpdate(voiceUpdate());

    expect(voice.spoken).toEqual([]);
    expect(sent()).toEqual([long]);
  });

  it('answers typed text with text, even when voice is on', async () => {
    const voice = new FakeVoice();
    const { bot, sent } = setup(async () => agentResult('Typed answer.'), voice);

    await bot.handleUpdate(textUpdate('hello'));

    expect(voice.spoken).toEqual([]);
    expect(sent()).toEqual(['Typed answer.']);
  });

  it('asks staff to type when a voice note cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bot, sent, router } = setup(
      async () => ({ kind: 'refused', reply: 'Ok' }),
      new FakeVoice(),
    );

    await bot.handleUpdate(voiceUpdate());

    expect(router.handle).not.toHaveBeenCalled();
    expect(sent()[0]).toContain('type it instead');
    quiet.mockRestore();
  });

  it('ignores voice notes when voice is off', async () => {
    const { bot, router } = setup(async () => ({ kind: 'refused', reply: 'Ok' }));

    await bot.handleUpdate(voiceUpdate());

    expect(router.handle).not.toHaveBeenCalled();
  });
});

describe('splitForTelegram', () => {
  it('keeps short text whole', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
  });
});
