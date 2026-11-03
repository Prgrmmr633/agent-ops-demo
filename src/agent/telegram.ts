import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { VoiceAdapter } from '../voice/adapter.ts';
import type { Inbound, StaffRouter } from './router.ts';

const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface BotOptions {
  token: string;
  router: StaffRouter;
  /** When set, staff voice notes are transcribed and handled as text. */
  voice?: VoiceAdapter | undefined;
  /** Supplied in tests so that the bot does not call getMe. */
  botInfo?: UserFromGetMe;
}

export function splitForTelegram(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(start, start + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks;
}

export function createBot({ token, router, voice, botInfo }: BotOptions): Bot {
  const bot = botInfo ? new Bot(token, { botInfo }) : new Bot(token);

  async function respond(ctx: Context, text: string, source: Inbound['source']) {
    if (!ctx.chat || !ctx.from) return;
    try {
      const { reply } = await router.handle({
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        text,
        source,
      });
      for (const chunk of splitForTelegram(reply)) await ctx.reply(chunk);
    } catch (error) {
      console.error('Failed to handle a message', error);
      await ctx.reply('Something went wrong. Please check the record before retrying.');
    }
  }

  // Edited messages are not handled, so an old message cannot become an approval later.
  bot.on('message:text', (ctx) =>
    respond(ctx, ctx.message.text, ctx.message.forward_origin ? 'forwarded' : 'typed'),
  );

  if (voice) {
    bot.on('message:voice', async (ctx) => {
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const download = await fetch(url);
        if (!download.ok) throw new Error('Could not download the voice note.');
        const audio = new Uint8Array(await download.arrayBuffer());
        const mimeType = ctx.message.voice.mime_type ?? 'audio/ogg';
        await respond(ctx, await voice.transcribe(audio, mimeType), 'voice');
      } catch (error) {
        console.error('Failed to transcribe a voice note', error);
        await ctx.reply('I could not read that voice note. Please type it instead.');
      }
    });
  }

  bot.catch(({ error }) => console.error('Telegram update failed', error));
  return bot;
}
