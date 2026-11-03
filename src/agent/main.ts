import { mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { systemAmbient } from '../ambient.ts';
import { createVoiceAdapter, dataPath, loadAgentConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { JobQueue } from '../jobs/queue.ts';
import { connectOverHttp } from '../mcp/client.ts';
import { AnthropicModel } from './model.ts';
import { createStaffRuntime } from './runtime.ts';
import { createBot } from './telegram.ts';

const config = loadAgentConfig();
const voice = createVoiceAdapter();
const audioDir = dataPath(process.env, 'audio');
mkdirSync(audioDir, { recursive: true });

const { router } = await createStaffRuntime({
  db: openDb(dataPath(process.env, 'agent.db')),
  jobs: new JobQueue(openDb(dataPath(process.env, 'jobs.db'))),
  mcp: await connectOverHttp(config.MCP_URL, config.MCP_AUTH_TOKEN),
  model: new AnthropicModel(new Anthropic(), config.ANTHROPIC_MODEL),
  staffIds: config.TELEGRAM_STAFF_IDS,
  ambient: systemAmbient,
  voice: voice ? { adapter: voice, audioDir } : undefined,
});

const bot = createBot({ token: config.TELEGRAM_BOT_TOKEN, router, voice: voice ?? undefined });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bot.stop());
}

console.log('Telegram agent starting');
await bot.start();
