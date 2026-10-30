// A speech provider for tests: it "hears" the next scripted transcript, a word per frame, and
// "speaks" silence whose length follows the text. No audio is interpreted.
import type { RecognitionHandlers, RecognitionSession, SpeechProvider, SynthesisHandlers } from './provider.ts';

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = 'fake';
  /** Transcripts returned by successive utterances. */
  readonly transcripts: { text: string; confidence?: number }[] = [];
  readonly spoken: string[] = [];
  phrases: string[] = [];
  /** Milliseconds of audio per character of spoken text. */
  msPerChar = 4;
  private turn = 0;

  /** `loop` is heard in turn once `transcripts` is empty (developer demos without a speech service). */
  constructor(private readonly loop: string[] = []) {}

  async recognize(opts: { language: string; phrases: string[] }, h: RecognitionHandlers): Promise<RecognitionSession> {
    this.phrases = opts.phrases;
    const next = this.transcripts.shift() ?? (this.loop.length ? { text: this.loop[this.turn++ % this.loop.length]! } : { text: '' });
    const words = next.text.split(/\s+/).filter(Boolean);
    let frames = 0;
    let open = true;
    return {
      write: () => {
        if (!open) return;
        frames += 1;
        if (frames <= words.length) h.partial(words.slice(0, frames).join(' '));
      },
      end: async () => {
        open = false;
        h.final({ text: next.text, confidence: next.confidence ?? 0.93 });
      },
      close: () => {
        open = false;
      },
    };
  }

  synthesize(text: string, _opts: { language: string; rate: number }, h: SynthesisHandlers) {
    this.spoken.push(text);
    let chunks = Math.max(1, Math.ceil((text.length * this.msPerChar) / 100));
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (chunks-- <= 0) return h.end();
      h.audio(new Uint8Array(3200));
      setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
    return {
      cancel: () => {
        cancelled = true;
      },
    };
  }
}
