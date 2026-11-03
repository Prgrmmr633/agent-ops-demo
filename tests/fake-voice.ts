import type { VoiceAdapter } from '../src/voice/adapter.ts';

export class FakeVoice implements VoiceAdapter {
  readonly spoken: string[] = [];
  private readonly heard: string;

  constructor(heard = 'What is the status of ticket 1002?') {
    this.heard = heard;
  }

  async synthesize(text: string): Promise<Uint8Array> {
    this.spoken.push(text);
    return new TextEncoder().encode(`audio:${text}`);
  }

  async transcribe(): Promise<string> {
    return this.heard;
  }
}
