import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsVoice } from '../../src/voice/elevenlabs.ts';

function stub(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

const options = { apiKey: 'test-key-not-real', voiceId: 'voice/1', sttModel: 'stt-model' };

function lastCall(fetchStub: ReturnType<typeof stub>) {
  const [url, init] = fetchStub.mock.calls[0] ?? [];
  return { url: String(url), init };
}

describe('ElevenLabsVoice', () => {
  it('posts text to the voice and returns the audio bytes', async () => {
    const fetchStub = stub(new Response(new Uint8Array([1, 2, 3])));
    const voice = new ElevenLabsVoice({ ...options, ttsModel: 'tts-model', fetch: fetchStub });

    const audio = await voice.synthesize('Hello');

    const { url, init } = lastCall(fetchStub);
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%2F1');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'xi-api-key': 'test-key-not-real' });
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Hello', model_id: 'tts-model' });
    expect([...audio]).toEqual([1, 2, 3]);
  });

  it('leaves the model out when none is configured', async () => {
    const fetchStub = stub(new Response(new Uint8Array()));

    await new ElevenLabsVoice({ ...options, fetch: fetchStub }).synthesize('Hello');

    expect(JSON.parse(String(lastCall(fetchStub).init?.body))).toEqual({ text: 'Hello' });
  });

  it('sends audio as a form and returns the transcript', async () => {
    const fetchStub = stub(Response.json({ text: 'Mark ticket 1001 ready' }));
    const voice = new ElevenLabsVoice({ ...options, fetch: fetchStub });

    const text = await voice.transcribe(new Uint8Array([9]), 'audio/ogg');

    const { url, init } = lastCall(fetchStub);
    const form = init?.body as FormData;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(form.get('model_id')).toBe('stt-model');
    expect((form.get('file') as File).type).toBe('audio/ogg');
    expect(text).toBe('Mark ticket 1001 ready');
  });

  it('raises provider errors without echoing the key or response body', async () => {
    const fetchStub = stub(new Response('details', { status: 401 }));
    const voice = new ElevenLabsVoice({ ...options, fetch: fetchStub });

    await expect(voice.synthesize('Hello')).rejects.toThrow('Voice provider returned HTTP 401.');
  });

  it('rejects a transcript response of the wrong shape', async () => {
    const fetchStub = stub(Response.json({ transcripts: [] }));
    const voice = new ElevenLabsVoice({ ...options, fetch: fetchStub });

    await expect(voice.transcribe(new Uint8Array(), 'audio/ogg')).rejects.toThrow();
  });
});
