import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutboundAdapter, OutboundMessage } from '../outbound/adapter.ts';
import type { VoiceAdapter } from './adapter.ts';

/**
 * Renders an approved call script to audio before handing it on. It sits behind
 * the gate, so no speech is generated for a draft nobody has approved.
 */
export class VoiceRenderingOutbound implements OutboundAdapter {
  private readonly next: OutboundAdapter;
  private readonly voice: VoiceAdapter;
  private readonly audioDir: string;

  constructor(next: OutboundAdapter, voice: VoiceAdapter, audioDir: string) {
    this.next = next;
    this.voice = voice;
    this.audioDir = audioDir;
  }

  async send(message: OutboundMessage): Promise<{ providerRef: string }> {
    if (message.channel === 'voice') {
      const audio = await this.voice.synthesize(message.body);
      await writeFile(join(this.audioDir, `${message.draftId}.mp3`), audio);
    }
    return this.next.send(message);
  }
}
