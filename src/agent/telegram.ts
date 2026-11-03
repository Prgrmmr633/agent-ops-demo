import { Bot, type Context, InputFile } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { VoiceAdapter } from '../voice/adapter.ts';
import type { Inbound, RouterResult, StaffRouter } from './router.ts';

const TELEGRAM_MESSAGE_LIMIT = 4096;

// Longer replies are sent as text, so one answer cannot use up a large share of voice credits.
const MAX_SPOKEN_CHARACTERS = 1000;

export interface BotOptions {
  token: string;
  router: StaffRouter;
  /** When set, staff voice notes are transcribed, and answered with a voice note. */
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

/** Each forum topic is its own conversation, so a call topic and a chat topic never mix. */
function conversationId(ctx: Context): string {
  const chat = String(ctx.chat?.id);
  const message = ctx.message;
  return message?.is_topic_message ? `${chat}:${message.message_thread_id}` : chat;
}

async function replyWithText(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) await ctx.reply(chunk);
}

export function createBot({ token, router, voice, botInfo }: BotOptions): Bot {
  const bot = botInfo ? new Bot(token, { botInfo }) : new Bot(token);

  /**
   * A voice note gets a spoken answer, like a call. Drafts and their commands always
   * follow as text, so staff can read exactly what would be sent and approve by typing.
   */
  async function replyWithVoice(ctx: Context, speech: VoiceAdapter, result: RouterResult) {
    const spoken = result.kind === 'agent' ? result.modelReply : result.reply;
    const rest = result.reply.slice(spoken.length).trim();
    if (spoken.length > MAX_SPOKEN_CHARACTERS) {
      await replyWithText(ctx, result.reply);
      return;
    }
    try {
      const audio = await speech.synthesize(spoken, 'voice_note');
      await ctx.replyWithVoice(new InputFile(audio, 'reply.ogg'));
    } catch (error) {
      console.error('Failed to speak a reply', error);
      await replyWithText(ctx, spoken);
    }
    if (rest) await replyWithText(ctx, rest);
  }

  async function respond(ctx: Context, text: string, source: Inbound['source']) {
    if (!ctx.chat || !ctx.from) return;
    try {
      const result = await router.handle({
        chatId: conversationId(ctx),
        userId: String(ctx.from.id),
        text,
        source,
      });
      if (source === 'voice' && voice) {
        await replyWithVoice(ctx, voice, result);
      } else {
        await replyWithText(ctx, result.reply);
      }
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
