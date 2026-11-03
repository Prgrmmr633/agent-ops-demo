import type { AudioFormat, VoiceAdapter } from '../src/voice/adapter.ts';

export class FakeVoice implements VoiceAdapter {
  readonly spoken: string[] = [];
  readonly formats: AudioFormat[] = [];
  private readonly heard: string;

  constructor(heard = 'What is the status of ticket 1002?') {
    this.heard = heard;
  }

  async synthesize(text: string, format: AudioFormat = 'mp3'): Promise<Uint8Array> {
    this.spoken.push(text);
    this.formats.push(format);
    return new TextEncoder().encode(`audio:${text}`);
  }

  async transcribe(): Promise<string> {
    return this.heard;
  }
}
