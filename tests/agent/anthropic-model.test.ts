import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicModel } from '../../src/agent/model.ts';

function stubbedClient(capture: { body?: Record<string, unknown>; headers?: Headers }) {
  return new Anthropic({
    apiKey: 'test-key-not-real',
    maxRetries: 0,
    fetch: async (_url, init) => {
      capture.headers = new Headers(init?.headers);
      capture.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [{ type: 'text', text: 'Hello', citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
}

describe('AnthropicModel', () => {
  it('sends the configured model, tools and fallback through the real SDK', async () => {
    const capture: { body?: Record<string, unknown>; headers?: Headers } = {};
    const model = new AnthropicModel(stubbedClient(capture), 'model-from-env');

    const reply = await model.complete({
      system: 'Be helpful',
      tools: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(reply).toMatchObject({ stop_reason: 'end_turn', content: [{ text: 'Hello' }] });
    expect(capture.body).toMatchObject({
      model: 'model-from-env',
      system: 'Be helpful',
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      tools: [{ name: 'echo' }],
    });
    expect(capture.body).not.toHaveProperty('betas');
    expect(capture.headers?.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('raises API errors instead of hiding them', async () => {
    const client = new Anthropic({
      apiKey: 'test-key-not-real',
      maxRetries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const model = new AnthropicModel(client, 'model-from-env');

    await expect(
      model.complete({ system: 's', tools: [], messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
  });
});
