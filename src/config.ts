import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { VoiceAdapter } from './voice/adapter.ts';
import { ElevenLabsVoice } from './voice/elevenlabs.ts';

type Env = Record<string, string | undefined>;

const blankAsMissing = (value: unknown) => (value === '' ? undefined : value);
const required = z.preprocess(blankAsMissing, z.string());
const optional = (fallback: string) => z.preprocess(blankAsMissing, z.string().default(fallback));
const port = (fallback: number) =>
  z.preprocess(blankAsMissing, z.coerce.number().int().min(0).max(65535).default(fallback));

function parse<T extends z.ZodType>(schema: T, env: Env, service: string): z.output<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const names = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`${service}: missing or invalid settings: ${names}. See .env.example.`);
}

/** Each service owns one database file under DATA_DIR. */
export function dataPath(env: Env, ...segments: string[]): string {
  const root = resolve(env.DATA_DIR || './data');
  mkdirSync(root, { recursive: true });
  return join(root, ...segments);
}

const authToken = required.pipe(z.string().min(16));
const mcpUrl = optional('http://127.0.0.1:3001');

export function loadDataServiceConfig(env: Env = process.env) {
  return parse(
    z.object({
      MCP_AUTH_TOKEN: authToken,
      MCP_HOST: optional('127.0.0.1'),
      MCP_PORT: port(3001),
      DATA_ACTOR: optional('staff-agent'),
    }),
    env,
    'data service',
  );
}

export function loadWorkerConfig(env: Env = process.env) {
  return parse(
    z.object({
      MCP_URL: mcpUrl,
      MCP_AUTH_TOKEN: authToken,
      HEALTH_HOST: optional('127.0.0.1'),
      HEALTH_PORT: port(3002),
    }),
    env,
    'worker',
  );
}

export function loadAgentConfig(env: Env = process.env) {
  return parse(
    z.object({
      MCP_URL: mcpUrl,
      MCP_AUTH_TOKEN: authToken,
      TELEGRAM_BOT_TOKEN: required,
      TELEGRAM_STAFF_IDS: required.transform((ids) => ids.split(',').map((id) => id.trim())),
      ANTHROPIC_MODEL: required,
    }),
    env,
    'agent',
  );
}

/** Voice is off unless VOICE_ENABLED is exactly "true". */
export function createVoiceAdapter(env: Env = process.env): VoiceAdapter | null {
  if (env.VOICE_ENABLED !== 'true') return null;
  const config = parse(
    z.object({
      ELEVENLABS_API_KEY: required,
      ELEVENLABS_VOICE_ID: required,
      ELEVENLABS_TTS_MODEL: z.preprocess(blankAsMissing, z.string().optional()),
      ELEVENLABS_STT_MODEL: optional('scribe_v2'),
    }),
    env,
    'voice',
  );
  return new ElevenLabsVoice({
    apiKey: config.ELEVENLABS_API_KEY,
    voiceId: config.ELEVENLABS_VOICE_ID,
    ttsModel: config.ELEVENLABS_TTS_MODEL,
    sttModel: config.ELEVENLABS_STT_MODEL,
  });
}
