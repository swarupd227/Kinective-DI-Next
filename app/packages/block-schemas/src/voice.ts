// Voice WebSocket protocol (spec 12.7): WSS /v1/voice?ticket=…. Binary frames carry audio: from the
// client, 100 ms of 16 kHz 16-bit mono PCM; from the server, PCM of the same format for the speech
// utterance most recently announced with tts.sentence. Text frames carry these JSON messages.

/** Phrases the gateway speaks on the client's behalf. Fixed, so the client never sends text to speak. */
export type VoicePhrase = 'needs_screen_approval' | 'press_approve' | 'say_confirm' | 'not_heard';

export type VoiceClientMessage =
  | {
      type: 'session.start';
      mode: 'push_to_talk';
      language: string;
      audio: { encoding: 'pcm_s16le'; sampleRate: 16000; channels: 1; frameMs: 100 };
      /** Threads whose voice-initiated answers this socket should speak. */
      threadId?: string;
      tts: { enabled: boolean; rate: number };
    }
  | { type: 'utterance.end' }
  | { type: 'tts.cancel' }
  | { type: 'tts.subscribe'; threadId: string; enabled: boolean; rate: number }
  | { type: 'say'; phrase: VoicePhrase }
  | { type: 'session.stop' }
  | { type: 'ping' };

/** A spoken number the client must resolve to a named record on screen before use (FE-VOICE-051). */
export interface SpokenIdentifier {
  kind: 'member' | 'account';
  last4: string;
}

export type VoiceServerMessage =
  | { type: 'session.ready'; provider: string }
  | { type: 'transcript.partial'; text: string }
  | {
      type: 'transcript.final';
      /** What was heard, with SSNs and card numbers already removed. */
      text: string;
      /** The text after banking normalisation (spec 7.7); this is what goes in the input box. */
      normalised: string;
      confidence: number;
      identifiers: SpokenIdentifier[];
      redactions: string[];
    }
  | { type: 'noise.warning' }
  /** A sentence about to play: the client shows it as the caption while its audio plays. */
  | { type: 'tts.sentence'; utteranceId: string; index: number; text: string }
  | { type: 'tts.start'; utteranceId: string; text: string; approvalId?: string }
  | { type: 'tts.end'; utteranceId: string; approvalId?: string; cancelled?: boolean }
  | { type: 'barge_in.ack' }
  | { type: 'error'; code: 'STT_UNAVAILABLE' | 'TTS_UNAVAILABLE' | 'NOT_CONFIGURED' | 'BAD_MESSAGE'; message: string; retryAfterMs?: number }
  | { type: 'pong' };
