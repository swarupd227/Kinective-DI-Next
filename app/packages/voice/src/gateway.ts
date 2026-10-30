// Voice gateway (spec 7.2, 12.7). One WebSocket per browser tab: audio frames in, transcripts and
// speech out. The final transcript goes back to the client, which sends it through the normal
// message endpoint with inputChannel "voice", so typed and spoken requests follow one path.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { VoiceClientMessage, VoiceServerMessage } from '@dinext/block-schemas';
import { normaliseTranscript } from './normalise.ts';
import type { RecognitionSession, SpeechProvider } from './provider.ts';
import { PHRASES, sentences } from './speakable.ts';

export interface VoiceStatus {
  available: boolean;
  reason?: string;
}

interface Utterance {
  id: string;
  text: string;
  approvalId?: string;
}

interface Connection {
  ws: WebSocket;
  vocabulary: string[];
  language: string;
  subs: Map<string, { enabled: boolean; rate: number }>;
  rec: RecognitionSession | null;
  queue: Utterance[];
  playing: { utterance: Utterance; cancel: () => void } | null;
  loudFrames: number;
  warnedNoise: boolean;
}

let counter = 0;
const nextId = () => `u${Date.now().toString(36)}${(counter++).toString(36)}`;

/** RMS of a 16-bit PCM frame, 0 to 1. */
function level(pcm: Uint8Array) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const n = Math.floor(pcm.byteLength / 2);
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export class VoiceGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<Connection>();
  private readonly readBacks = new Set<string>();

  constructor(private readonly opts: { provider: SpeechProvider | null; language?: string; unavailableReason?: string }) {}

  status(): VoiceStatus {
    return this.opts.provider ? { available: true } : { available: false, reason: this.opts.unavailableReason ?? 'Voice isn’t set up in this environment.' };
  }

  get providerName() {
    return this.opts.provider?.name ?? null;
  }

  /** True once an approval card's spoken summary has played to the end (FE-VOICE-041). */
  readBackDone(approvalId: string) {
    return this.readBacks.has(approvalId);
  }

  /** Call after the caller has validated the one-time ticket. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: { vocabulary: string[] }) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, ctx.vocabulary));
  }

  /** Speaks to every socket following the thread with speech on (voice-initiated answers). */
  speak(threadId: string, text: string, meta: { approvalId?: string } = {}) {
    if (!this.opts.provider || !text.trim()) return 0;
    let n = 0;
    for (const c of this.connections) {
      const sub = c.subs.get(threadId);
      if (!sub?.enabled) continue;
      this.enqueue(c, { id: nextId(), text, approvalId: meta.approvalId });
      n++;
    }
    return n;
  }

  close() {
    for (const c of this.connections) {
      c.rec?.close();
      c.playing?.cancel();
      c.ws.terminate();
    }
    this.wss.close();
  }

  private send(c: Connection, m: VoiceServerMessage) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  }

  private attach(ws: WebSocket, vocabulary: string[]) {
    const c: Connection = { ws, vocabulary, language: this.opts.language ?? 'en-US', subs: new Map(), rec: null, queue: [], playing: null, loudFrames: 0, warnedNoise: false };
    this.connections.add(c);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return this.onAudio(c, data as Buffer);
      let msg: VoiceClientMessage;
      try {
        msg = JSON.parse(String(data)) as VoiceClientMessage;
      } catch {
        return this.send(c, { type: 'error', code: 'BAD_MESSAGE', message: 'Not JSON' });
      }
      void this.onMessage(c, msg);
    });
    ws.on('close', () => {
      c.rec?.close();
      c.playing?.cancel();
      this.connections.delete(c);
    });
  }

  private onAudio(c: Connection, frame: Buffer) {
    if (!c.rec) return;
    const pcm = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    c.rec.write(pcm);
    // A background level that stays high for 3 seconds earns one warning (spec 7.10).
    c.loudFrames = level(pcm) > 0.3 ? c.loudFrames + 1 : 0;
    if (c.loudFrames >= 30 && !c.warnedNoise) {
      c.warnedNoise = true;
      this.send(c, { type: 'noise.warning' });
    }
  }

  private async onMessage(c: Connection, msg: VoiceClientMessage) {
    switch (msg.type) {
      case 'ping':
        return this.send(c, { type: 'pong' });
      case 'session.start': {
        if (msg.threadId) c.subs.set(msg.threadId, { enabled: msg.tts.enabled, rate: msg.tts.rate });
        if (!this.opts.provider) return this.send(c, { type: 'error', code: 'NOT_CONFIGURED', message: this.status().reason! });
        // Speaking again interrupts any answer still playing (barge-in, spec 7.4).
        this.cancelSpeech(c, false);
        c.rec?.close();
        c.loudFrames = 0;
        try {
          c.rec = await this.opts.provider.recognize(
            { language: msg.language || c.language, phrases: c.vocabulary },
            {
              partial: (text) => this.send(c, { type: 'transcript.partial', text }),
              final: ({ text, confidence }) => {
                const n = normaliseTranscript(text);
                this.send(c, { type: 'transcript.final', text: n.text, normalised: n.normalised, confidence, identifiers: n.identifiers, redactions: n.redactions });
              },
              error: (code, message) => this.send(c, { type: 'error', code, message, retryAfterMs: 2000 }),
            },
          );
          this.send(c, { type: 'session.ready', provider: this.opts.provider.name });
        } catch (e) {
          c.rec = null;
          this.send(c, { type: 'error', code: 'STT_UNAVAILABLE', message: e instanceof Error ? e.message : String(e), retryAfterMs: 2000 });
        }
        return;
      }
      case 'utterance.end': {
        const rec = c.rec;
        c.rec = null;
        await rec?.end();
        return;
      }
      case 'session.stop':
        c.rec?.close();
        c.rec = null;
        return;
      case 'tts.cancel':
        return this.cancelSpeech(c, true);
      case 'tts.subscribe':
        c.subs.set(msg.threadId, { enabled: msg.enabled, rate: msg.rate });
        if (!msg.enabled) this.cancelSpeech(c, false);
        return;
      case 'say':
        if (msg.phrase in PHRASES) this.enqueue(c, { id: nextId(), text: PHRASES[msg.phrase] });
        return;
      default:
        return this.send(c, { type: 'error', code: 'BAD_MESSAGE', message: 'Unknown message' });
    }
  }

  private cancelSpeech(c: Connection, ack: boolean) {
    const current = c.playing;
    c.queue = [];
    c.playing = null;
    if (current) {
      current.cancel();
      this.send(c, { type: 'tts.end', utteranceId: current.utterance.id, approvalId: current.utterance.approvalId, cancelled: true });
    }
    if (ack) this.send(c, { type: 'barge_in.ack' });
  }

  private enqueue(c: Connection, u: Utterance) {
    c.queue.push(u);
    if (!c.playing) void this.drain(c);
  }

  /** Plays queued utterances one at a time, a sentence per synthesis so captions follow along. */
  private async drain(c: Connection) {
    const provider = this.opts.provider!;
    while (c.queue.length) {
      const u = c.queue.shift()!;
      const rate = [...c.subs.values()][0]?.rate ?? 1;
      let cancelled = false;
      let cancelCurrent = () => {};
      c.playing = {
        utterance: u,
        cancel: () => {
          cancelled = true;
          cancelCurrent();
        },
      };
      this.send(c, { type: 'tts.start', utteranceId: u.id, text: u.text, approvalId: u.approvalId });
      let failed = false;
      const parts = sentences(u.text);
      for (let i = 0; i < parts.length && !cancelled; i++) {
        this.send(c, { type: 'tts.sentence', utteranceId: u.id, index: i, text: parts[i]! });
        await new Promise<void>((resolve) => {
          const handle = provider.synthesize(parts[i]!, { language: c.language, rate }, {
            audio: (chunk) => {
              if (!cancelled && c.ws.readyState === c.ws.OPEN) c.ws.send(chunk, { binary: true });
            },
            end: resolve,
            error: (code, message) => {
              failed = true;
              this.send(c, { type: 'error', code, message });
              resolve();
            },
          });
          cancelCurrent = () => {
            handle.cancel();
            resolve();
          };
        });
        if (failed) break;
      }
      if (cancelled) return;
      c.playing = null;
      // A read-back that played to the end makes a spoken confirmation acceptable.
      if (u.approvalId && !failed) this.readBacks.add(u.approvalId);
      this.send(c, { type: 'tts.end', utteranceId: u.id, approvalId: u.approvalId });
    }
  }
}
