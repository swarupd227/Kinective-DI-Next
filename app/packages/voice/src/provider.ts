// Speech adapters behind the voice gateway (spec 7.2). The browser never talks to a speech service:
// it streams PCM to the gateway, which holds the credentials. Azure AI Speech is the target; a fake
// provider drives the tests. Moving to another service is a new adapter, not a client change.

export interface RecognitionHandlers {
  partial(text: string): void;
  final(result: { text: string; confidence: number }): void;
  error(code: 'STT_UNAVAILABLE', message: string): void;
}

export interface RecognitionSession {
  /** 100 ms of 16 kHz, 16-bit, mono little-endian PCM. */
  write(pcm: Uint8Array): void;
  /** Push-to-talk released: finish now and deliver the final transcript (FE-VOICE-030). */
  end(): Promise<void>;
  /** Abandon the utterance; no final transcript. */
  close(): void;
}

export interface SynthesisHandlers {
  /** 16 kHz, 16-bit, mono PCM. */
  audio(chunk: Uint8Array): void;
  end(): void;
  error(code: 'TTS_UNAVAILABLE', message: string): void;
}

export interface SpeechProvider {
  readonly name: string;
  /** `phrases` biases recognition toward the tenant's own words (spec 7.8). */
  recognize(opts: { language: string; phrases: string[] }, h: RecognitionHandlers): Promise<RecognitionSession>;
  synthesize(text: string, opts: { language: string; rate: number }, h: SynthesisHandlers): { cancel(): void };
}
