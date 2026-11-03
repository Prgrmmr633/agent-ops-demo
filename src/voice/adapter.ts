/** A thin speech interface, so providers stay behind one seam and tests can use a fake. */
export interface VoiceAdapter {
  synthesize(text: string): Promise<Uint8Array>;
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}
