// Azure AI Speech adapter. Recognition streams the client's PCM through a push stream with a phrase
// list; synthesis returns raw 16 kHz PCM so the client plays it without decoding. Audio is never
// written anywhere (FE-VOICE-070).
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { RecognitionHandlers, RecognitionSession, SpeechProvider, SynthesisHandlers } from './provider.ts';

export interface AzureSpeechOptions {
  key: string;
  region: string;
  /** A neural voice, for example en-US-AvaNeural. */
  voice?: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class AzureSpeechProvider implements SpeechProvider {
  readonly name = 'azure';
  constructor(private readonly opts: AzureSpeechOptions) {}

  private config() {
    return sdk.SpeechConfig.fromSubscription(this.opts.key, this.opts.region);
  }

  async recognize(opts: { language: string; phrases: string[] }, h: RecognitionHandlers): Promise<RecognitionSession> {
    const config = this.config();
    config.speechRecognitionLanguage = opts.language;
    config.outputFormat = sdk.OutputFormat.Detailed;
    const push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(push));
    if (opts.phrases.length) sdk.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(opts.phrases.slice(0, 500));

    // Continuous recognition can return several segments for one press; they are joined.
    const segments: { text: string; confidence: number }[] = [];
    let partialPrefix = '';
    let closed = false;
    recognizer.recognizing = (_s, e) => h.partial(`${partialPrefix}${e.result.text}`.trim());
    recognizer.recognized = (_s, e) => {
      if (e.result.reason !== sdk.ResultReason.RecognizedSpeech || !e.result.text) return;
      let confidence = 0.9;
      try {
        confidence = (JSON.parse(e.result.json) as { NBest?: { Confidence?: number }[] }).NBest?.[0]?.Confidence ?? confidence;
      } catch {
        // Simple output has no confidence; the default stands.
      }
      segments.push({ text: e.result.text, confidence });
      partialPrefix = `${segments.map((s) => s.text).join(' ')} `;
    };
    const stopped = new Promise<void>((resolve) => {
      recognizer.sessionStopped = () => resolve();
      recognizer.canceled = (_s, e) => {
        if (e.reason === sdk.CancellationReason.Error && !closed) h.error('STT_UNAVAILABLE', e.errorDetails);
        resolve();
      };
    });
    await new Promise<void>((resolve, reject) => recognizer.startContinuousRecognitionAsync(resolve, (err) => reject(new Error(err))));

    const finish = () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        recognizer.stopContinuousRecognitionAsync(
          () => recognizer.close(() => resolve()),
          () => resolve(),
        );
      });
    return {
      write: (pcm) => {
        if (!closed) push.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
      },
      end: async () => {
        // Closing the input lets the service finish the last segment; stop if it takes too long.
        push.close();
        await Promise.race([stopped, new Promise((r) => setTimeout(r, 1500))]);
        await finish();
        const text = segments.map((s) => s.text).join(' ').trim();
        const confidence = segments.length ? Math.min(...segments.map((s) => s.confidence)) : 0;
        h.final({ text, confidence });
      },
      close: () => {
        push.close();
        void finish();
      },
    };
  }

  synthesize(text: string, opts: { language: string; rate: number }, h: SynthesisHandlers) {
    const config = this.config();
    config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
    const voice = this.opts.voice ?? 'en-US-AvaNeural';
    // Passing null keeps the SDK from playing audio itself; chunks arrive through `synthesizing`.
    const synth = new sdk.SpeechSynthesizer(config, null);
    let cancelled = false;
    synth.synthesizing = (_s, e) => {
      if (!cancelled && e.result.audioData.byteLength) h.audio(new Uint8Array(e.result.audioData));
    };
    const rate = `${Math.round((Math.min(1.5, Math.max(0.75, opts.rate)) - 1) * 100)}%`;
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(opts.language)}"><voice name="${xml(voice)}"><prosody rate="${rate}">${xml(text)}</prosody></voice></speak>`;
    synth.speakSsmlAsync(
      ssml,
      (result) => {
        synth.close();
        if (cancelled) return;
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) h.end();
        else h.error('TTS_UNAVAILABLE', result.errorDetails || 'Speech synthesis failed');
      },
      (err) => {
        synth.close();
        if (!cancelled) h.error('TTS_UNAVAILABLE', err);
      },
    );
    return {
      cancel: () => {
        cancelled = true;
      },
    };
  }
}
