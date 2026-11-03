/** `voice_note` is Ogg Opus, the format chat apps use for voice messages. */
export type AudioFormat = 'mp3' | 'voice_note';

/** A thin speech interface, so providers stay behind one seam and tests can use a fake. */
export interface VoiceAdapter {
  synthesize(text: string, format?: AudioFormat): Promise<Uint8Array>;
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}
