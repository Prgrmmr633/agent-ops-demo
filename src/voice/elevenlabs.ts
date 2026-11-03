import { z } from 'zod';
import type { AudioFormat, VoiceAdapter } from './adapter.ts';

const API_ROOT = 'https://api.elevenlabs.io/v1';
const REQUEST_TIMEOUT_MS = 60_000;
const OUTPUT_FORMAT: Record<AudioFormat, string> = {
  mp3: 'mp3_44100_128',
  voice_note: 'opus_48000_64',
};

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  /** Left out of the request when unset, so the provider's default applies. */
  ttsModel?: string | undefined;
  sttModel: string;
  fetch?: typeof globalThis.fetch;
}

const transcript = z.object({ text: z.string() });

export class ElevenLabsVoice implements VoiceAdapter {
  private readonly options: ElevenLabsOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: ElevenLabsOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async synthesize(text: string, format: AudioFormat = 'mp3'): Promise<Uint8Array> {
    const { voiceId, ttsModel } = this.options;
    const response = await this.request(
      `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT[format]}`,
      {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(ttsModel ? { model_id: ttsModel } : {}) }),
      },
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const form = new FormData();
    form.set('model_id', this.options.sttModel);
    form.set('file', new Blob([Buffer.from(audio)], { type: mimeType }), 'audio');
    const response = await this.request('/speech-to-text', { body: form });
    return transcript.parse(await response.json()).text;
  }

  private async request(
    path: string,
    init: { headers?: Record<string, string>; body: string | FormData },
  ) {
    const response = await this.fetch(`${API_ROOT}${path}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.options.apiKey, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Voice provider returned HTTP ${response.status}.`);
    return response;
  }
}
