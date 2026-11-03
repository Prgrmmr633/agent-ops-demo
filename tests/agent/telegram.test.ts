import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Inbound, RouterResult, StaffRouter } from '../../src/agent/router.ts';
import { createBot, splitForTelegram } from '../../src/agent/telegram.ts';
import { FakeVoice } from '../fake-voice.ts';

const botInfo = { id: 1, is_bot: true, first_name: 'Test bot' } as UserFromGetMe;

function setup(handle: (inbound: Inbound) => Promise<RouterResult>, voice?: FakeVoice) {
  const router = { handle: vi.fn(handle) } as unknown as StaffRouter;
  const bot = createBot({ token: 'test-token', router, voice, botInfo });
  const sent: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') sent.push((payload as { text: string }).text);
    const result = method === 'getFile' ? { file_id: 'f1', file_path: 'voice/1.oga' } : true;
    return { ok: true, result } as never;
  });
  return { bot, sent, router };
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
    expect(sent).toEqual(['Hello back']);
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

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('internal detail');
    quiet.mockRestore();
  });

  it('splits long replies', async () => {
    const { bot, sent } = setup(async () => ({ kind: 'refused', reply: 'x'.repeat(5000) }));

    await bot.handleUpdate(textUpdate('hello'));

    expect(sent.map((text) => text.length)).toEqual([4096, 904]);
  });
});

describe('voice notes', () => {
  const voiceUpdate = () => {
    const { message } = textUpdate('') as unknown as { message: Record<string, unknown> };
    const { text: _text, ...rest } = message;
    const voice = { file_id: 'f1', file_unique_id: 'u1', duration: 2 };
    return { update_id: 1, message: { ...rest, voice } } as unknown as Update;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('transcribes a voice note and marks it as voice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
    const { bot, router } = setup(
      async () => ({ kind: 'refused', reply: 'Ok' }),
      new FakeVoice('APPROVE d_1'),
    );

    await bot.handleUpdate(voiceUpdate());

    expect(router.handle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'APPROVE d_1', source: 'voice' }),
    );
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
    expect(sent[0]).toContain('type it instead');
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
