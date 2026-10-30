// Browser side of voice (spec 7): one voice socket per tab, push-to-talk capture through an audio
// worklet, and playback of spoken answers with sentence captions. Audio is streamed and dropped;
// nothing is kept (FE-VOICE-070).
import { createStore } from 'zustand/vanilla';
import type { SpokenIdentifier, VoiceClientMessage, VoicePhrase, VoiceServerMessage } from '@dinext/block-schemas';
import workletUrl from './pcm-worklet.js?url';

export type VoicePhase = 'off' | 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'error';

export interface FinalTranscript {
  text: string;
  normalised: string;
  confidence: number;
  identifiers: SpokenIdentifier[];
}

export interface VoiceState {
  phase: VoicePhase;
  /** What is being heard, live (FE-VOICE-072 shows "Listening" with it). */
  partial: string;
  level: number;
  /** The sentence being spoken, shown as a caption (FE-A11Y-011). */
  caption: string;
  error: string | null;
  noisy: boolean;
  /** Approval read-backs that played to the end on this device (FE-VOICE-041). */
  readBacks: string[];
}

export interface VoiceClientOptions {
  ticketUrl: () => Promise<string>;
  onFinal: (t: FinalTranscript) => void;
  language?: string;
}

const PLAYBACK_RATE = 16000;

export class VoiceClient {
  readonly store = createStore<VoiceState>(() => ({ phase: 'off', partial: '', level: 0, caption: '', error: null, noisy: false, readBacks: [] }));
  private ws: WebSocket | null = null;
  private retry = 1000;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subs = new Map<string, { enabled: boolean; rate: number }>();

  // Capture
  private capture: { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null;
  private capturing = false;
  /** session.start has gone out; a release before that waits for it (a quick tap). */
  private started = false;
  private releasePending = false;

  // Playback
  private play: AudioContext | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Sentences queued for captions, with the playback time each one starts. */
  private captions: { at: number; text: string }[] = [];
  private utteranceEnds = new Map<string, { at: number; approvalId?: string }>();
  /** Audio after a barge-in is dropped until a new utterance starts; audio frames carry no ID. */
  private dropping = false;
  private current: string | null = null;
  private cancelled = new Set<string>();
  /** A timer, not requestAnimationFrame: background tabs pause animation frames but not audio. */
  private clock: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: VoiceClientOptions) {}

  private set(p: Partial<VoiceState>) {
    this.store.setState(p);
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopCapture(false);
    this.cancelSpeech(false);
    this.ws?.close();
    this.ws = null;
    if (this.clock) clearTimeout(this.clock);
    void this.play?.close();
    this.play = null;
    this.set({ phase: 'off' });
  }

  private send(m: VoiceClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async connect() {
    if (this.stopped) return;
    this.set({ phase: 'connecting', error: null });
    let url: string;
    try {
      url = await this.opts.ticketUrl();
    } catch {
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      this.set({ phase: 'idle', error: null });
      for (const [threadId, s] of this.subs) this.send({ type: 'tts.subscribe', threadId, ...s });
    };
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onControl(JSON.parse(ev.data) as VoiceServerMessage) : this.onAudio(ev.data as ArrayBuffer));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // A drop during capture keeps what was heard in the input box (FE-VOICE-120).
      if (this.capturing) this.stopCapture(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.set({ phase: 'error', error: 'Voice is unavailable. You can keep typing.' });
    this.reconnectTimer = setTimeout(() => void this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  /** Follow a thread's spoken answers (or stop them). */
  subscribe(threadId: string, enabled: boolean, rate = 1) {
    this.subs.set(threadId, { enabled, rate });
    this.send({ type: 'tts.subscribe', threadId, enabled, rate });
    if (!enabled) this.cancelSpeech(false);
  }

  say(phrase: VoicePhrase) {
    this.send({ type: 'say', phrase });
  }

  // ---- capture ----------------------------------------------------------------------------------

  /** Press: start listening. Starting to talk interrupts any answer that is playing (barge-in). */
  async startCapture(opts: { threadId?: string; speak: boolean; rate: number }) {
    if (this.capturing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.cancelSpeech(true);
    this.capturing = true;
    this.set({ phase: 'listening', partial: '', noisy: false, error: null, level: 0 });
    this.unlockPlayback();
    try {
      if (!this.capture) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        const ctx = new AudioContext();
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, 'pcm-capture');
        ctx.createMediaStreamSource(stream).connect(node);
        node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
          if (!this.capturing) return;
          this.ws?.send(e.data.pcm);
          this.set({ level: e.data.level });
        };
        this.capture = { ctx, stream, node };
      } else {
        await this.capture.ctx.resume();
      }
      if (!this.capturing) {
        // Cancelled while the microphone was opening: release it at once.
        this.capture?.stream.getTracks().forEach((t) => t.stop());
        void this.capture?.ctx.close();
        this.capture = null;
        return;
      }
      this.send({ type: 'session.start', mode: 'push_to_talk', language: this.opts.language ?? 'en-US', audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 100 }, threadId: opts.threadId, tts: { enabled: opts.speak, rate: opts.rate } });
      this.started = true;
      if (this.releasePending) {
        this.releasePending = false;
        this.stopCapture(true);
      }
    } catch (e) {
      this.capturing = false;
      this.releasePending = false;
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const missing = e instanceof DOMException && e.name === 'NotFoundError';
      this.set({
        phase: 'error',
        error: denied ? 'DI can’t use the microphone. Allow it in the browser’s site settings (the icon in the address bar), then try again.' : missing ? 'No microphone found.' : 'The microphone couldn’t start.',
      });
    }
  }

  /** Release: end the utterance at once (FE-VOICE-030). */
  stopCapture(send = true) {
    if (!this.capturing) return;
    if (send && !this.started) {
      // Released while the microphone was still opening: end as soon as it is.
      this.releasePending = true;
      return;
    }
    this.capturing = false;
    this.started = false;
    if (send) {
      this.send({ type: 'utterance.end' });
      this.set({ phase: 'processing', level: 0 });
    } else {
      this.send({ type: 'session.stop' });
      this.set({ phase: this.ws ? 'idle' : 'error', level: 0 });
    }
    // The microphone is released between presses, so the browser's indicator goes off too.
    this.capture?.stream.getTracks().forEach((t) => t.stop());
    void this.capture?.ctx.close();
    this.capture = null;
  }

  get isCapturing() {
    return this.capturing;
  }

  // ---- playback ---------------------------------------------------------------------------------

  /** Safari plays audio only after a user gesture; a press of the microphone is one. */
  private unlockPlayback() {
    if (!this.play) this.play = new AudioContext({ sampleRate: PLAYBACK_RATE });
    void this.play.resume();
  }

  private onAudio(buf: ArrayBuffer) {
    if (this.dropping || !buf.byteLength) return;
    this.unlockPlayback();
    const ctx = this.play!;
    const pcm = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    const audio = ctx.createBuffer(1, pcm.length, PLAYBACK_RATE);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.nextTime);
    src.start(at);
    this.nextTime = at + audio.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    if (this.store.getState().phase !== 'listening') this.set({ phase: 'speaking' });
    this.tick();
  }

  private playbackTime() {
    return this.play ? Math.max(this.play.currentTime + 0.02, this.nextTime) : 0;
  }

  /** Captions and the end of each utterance follow the audio clock, not message arrival. */
  private tick = () => {
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
    const ctx = this.play;
    if (!ctx) return;
    const now = ctx.currentTime;
    while (this.captions.length && this.captions[0]!.at <= now) this.set({ caption: this.captions.shift()!.text });
    for (const [id, end] of this.utteranceEnds) {
      if (end.at > now) continue;
      this.utteranceEnds.delete(id);
      if (end.approvalId) this.set({ readBacks: [...this.store.getState().readBacks, end.approvalId] });
    }
    const busy = this.sources.size > 0 || this.captions.length > 0 || this.utteranceEnds.size > 0;
    if (busy) this.clock = setTimeout(this.tick, 50);
    else if (this.store.getState().phase === 'speaking') this.set({ phase: 'idle', caption: '' });
  };

  /** Barge-in: stop at once, drop queued audio, keep the text on screen (FE-VOICE-020). */
  cancelSpeech(notify = true) {
    const speaking = this.sources.size > 0 || this.captions.length > 0;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.captions = [];
    this.utteranceEnds.clear();
    this.nextTime = 0;
    this.dropping = true;
    if (this.current) this.cancelled.add(this.current);
    if (notify && (speaking || this.store.getState().phase === 'speaking')) this.send({ type: 'tts.cancel' });
    if (this.store.getState().phase === 'speaking') this.set({ phase: 'idle' });
    this.set({ caption: '' });
  }

  get isSpeaking() {
    return this.sources.size > 0;
  }

  private onControl(m: VoiceServerMessage) {
    switch (m.type) {
      case 'transcript.partial':
        this.set({ partial: m.text });
        return;
      case 'transcript.final':
        this.set({ phase: this.isSpeaking ? 'speaking' : 'idle', partial: '' });
        this.opts.onFinal({ text: m.text, normalised: m.normalised, confidence: m.confidence, identifiers: m.identifiers });
        return;
      case 'noise.warning':
        this.set({ noisy: true });
        return;
      case 'tts.start':
        if (this.cancelled.has(m.utteranceId)) return;
        this.current = m.utteranceId;
        this.dropping = false;
        return;
      case 'tts.sentence':
        if (this.dropping || this.cancelled.has(m.utteranceId)) return;
        this.captions.push({ at: this.playbackTime(), text: m.text });
        this.tick();
        return;
      case 'tts.end':
        if (!m.cancelled && !this.cancelled.has(m.utteranceId)) this.utteranceEnds.set(m.utteranceId, { at: this.playbackTime(), approvalId: m.approvalId });
        this.tick();
        return;
      case 'error':
        if (m.code === 'NOT_CONFIGURED') this.set({ phase: 'idle', error: m.message });
        else if (m.code === 'TTS_UNAVAILABLE') this.set({ error: 'Audio unavailable. The answer is on screen.' });
        else this.set({ phase: 'idle', error: 'Voice is unavailable. You can keep typing.' });
        if (this.capturing) this.stopCapture(false);
        return;
    }
  }
}
