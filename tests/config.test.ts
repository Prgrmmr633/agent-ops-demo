import { describe, expect, it } from 'vitest';
import {
  createVoiceAdapter,
  loadAgentConfig,
  loadDataServiceConfig,
  loadWorkerConfig,
} from '../src/config.ts';
import { ElevenLabsVoice } from '../src/voice/elevenlabs.ts';

describe('loadDataServiceConfig', () => {
  it('applies defaults', () => {
    const config = loadDataServiceConfig({ MCP_AUTH_TOKEN: 'long-enough-placeholder' });
    expect(config).toMatchObject({ MCP_HOST: '127.0.0.1', MCP_PORT: 3001 });
  });

  it('treats blank values as missing', () => {
    const config = loadDataServiceConfig({
      MCP_AUTH_TOKEN: 'long-enough-placeholder',
      MCP_PORT: '',
    });
    expect(config.MCP_PORT).toBe(3001);
  });

  it('names the setting that is missing without echoing values', () => {
    expect(() => loadDataServiceConfig({})).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('rejects a token that is too short', () => {
    expect(() => loadDataServiceConfig({ MCP_AUTH_TOKEN: 'short' })).toThrow(/MCP_AUTH_TOKEN/);
  });
});

describe('loadWorkerConfig', () => {
  it('needs the MCP token', () => {
    expect(() => loadWorkerConfig({})).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('defaults the health port', () => {
    const config = loadWorkerConfig({ MCP_AUTH_TOKEN: 'long-enough-placeholder' });
    expect(config.HEALTH_PORT).toBe(3002);
  });
});

describe('loadAgentConfig', () => {
  const env = {
    MCP_AUTH_TOKEN: 'long-enough-placeholder',
    TELEGRAM_BOT_TOKEN: 'placeholder',
    TELEGRAM_STAFF_IDS: '101, 102',
    ANTHROPIC_MODEL: 'model-from-env',
  };

  it('splits the staff list', () => {
    expect(loadAgentConfig(env).TELEGRAM_STAFF_IDS).toEqual(['101', '102']);
  });

  it('has no built-in model, so the name always comes from the environment', () => {
    expect(() => loadAgentConfig({ ...env, ANTHROPIC_MODEL: '' })).toThrow(/ANTHROPIC_MODEL/);
  });

  it('lists every missing setting by name', () => {
    expect(() => loadAgentConfig({})).toThrow(/TELEGRAM_BOT_TOKEN.*TELEGRAM_STAFF_IDS/);
  });
});

describe('createVoiceAdapter', () => {
  const settings = { ELEVENLABS_API_KEY: 'test-key-not-real', ELEVENLABS_VOICE_ID: 'voice-1' };

  it('is off by default, even with credentials present', () => {
    expect(createVoiceAdapter(settings)).toBeNull();
  });

  it.each(['false', '1', 'TRUE', ''])('stays off when the flag is %j', (VOICE_ENABLED) => {
    expect(createVoiceAdapter({ ...settings, VOICE_ENABLED })).toBeNull();
  });

  it('uses ElevenLabs when switched on', () => {
    expect(createVoiceAdapter({ ...settings, VOICE_ENABLED: 'true' })).toBeInstanceOf(
      ElevenLabsVoice,
    );
  });

  it('refuses to start half configured', () => {
    expect(() => createVoiceAdapter({ VOICE_ENABLED: 'true' })).toThrow(/ELEVENLABS_API_KEY/);
  });
});
