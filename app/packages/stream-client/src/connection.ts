// Main stream WebSocket client (spec 11.6, 12.2): hello with block support, resume by last seq,
// 20 s heartbeat with 10 s pong timeout, reconnect with jittered backoff 1-30 s, and one store
// update per animation frame.
import { BLOCK_SUPPORT, type AppNotification, type ClientMessage, type ControlEvent, type StreamEvent } from '@dinext/block-schemas';
import type { StreamStore } from './store.ts';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionOptions {
  /** Resolves the socket URL, including a fresh one-time ticket (spec 12.1). */
  url: () => Promise<string>;
  store: StreamStore;
  clientVersion: string;
  locale?: string;
  onState?: (state: ConnectionState) => void;
  /** Session-wide bell notifications (FE-NOTE-002). */
  onNotification?: (n: AppNotification) => void;
  WebSocketImpl?: typeof WebSocket;
}

const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

// Browsers pause animation frames in hidden or occluded windows. Whichever fires first, the frame
// or a 100 ms timer, flushes the batch, so a background tab's thread stays current.
const raf = (cb: () => void) => {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cb();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
  setTimeout(once, 100);
};

export class StreamConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private gapTimer?: ReturnType<typeof setInterval>;
  private queue: StreamEvent[] = [];
  private flushScheduled = false;
  private stopped = false;
  /** Bumped on every start/stop so an open() still awaiting its ticket cannot create a stale socket. */
  private generation = 0;
  private readonly subscribed = new Set<string>();

  constructor(private readonly opts: ConnectionOptions) {}

  start() {
    this.stopped = false;
    this.generation += 1;
    clearInterval(this.gapTimer);
    this.gapTimer = setInterval(() => this.opts.store.checkGaps(), 500);
    void this.open('connecting', this.generation);
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    clearInterval(this.heartbeat);
    clearInterval(this.gapTimer);
    clearTimeout(this.pongTimer);
    this.ws?.close(1000, 'client stop');
    this.ws = null;
    this.opts.onState?.('closed');
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  cancelRun(runId: string) {
    this.send({ type: 'run.cancel', runId });
  }

  /**
   * Follows a thread. The server replays every event after the store's last sequence, so opening a
   * thread after a reload rebuilds it from the stream; reconnects re-subscribe through hello.
   */
  subscribe(threadId: string) {
    if (this.subscribed.has(threadId)) return;
    this.subscribed.add(threadId);
    this.send({ type: 'subscribe', threadId, lastSeq: this.lastSeqOf(threadId) });
  }

  unsubscribe(threadId: string) {
    if (!this.subscribed.delete(threadId)) return;
    this.send({ type: 'unsubscribe', threadId });
  }

  private lastSeqOf(threadId: string) {
    return this.opts.store.store.getState().threads[threadId]?.lastSeq ?? 0;
  }

  /** Called by the store's gap detector: reconnecting with resume makes the server replay. */
  requestReplay() {
    this.ws?.close(4000, 'gap');
  }

  private async open(state: ConnectionState, generation: number) {
    this.opts.onState?.(state);
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let url: string;
    try {
      url = await this.opts.url();
    } catch {
      return this.scheduleReconnect(generation);
    }
    if (this.stopped || generation !== this.generation) return;
    const ws = new Impl(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.send({
        type: 'hello',
        clientVersion: this.opts.clientVersion,
        locale: this.opts.locale ?? 'en-US',
        blockSupport: BLOCK_SUPPORT,
        resume: [...this.subscribed].map((threadId) => ({ threadId, lastSeq: this.lastSeqOf(threadId) })),
      });
      this.opts.onState?.('open');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    };
    ws.onmessage = (msg) => this.onMessage(String(msg.data));
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      clearTimeout(this.pongTimer);
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect(generation);
    };
    // A close event always follows an error, and onclose handles reconnecting.
  }

  private ping() {
    this.send({ type: 'ping' });
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => this.ws?.close(4001, 'pong timeout'), PONG_TIMEOUT_MS);
  }

  private scheduleReconnect(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!;
    this.attempt += 1;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.opts.onState?.('reconnecting');
    setTimeout(() => void this.open('reconnecting', generation), jitter);
  }

  private onMessage(raw: string) {
    let msg: StreamEvent | ControlEvent;
    try {
      msg = JSON.parse(raw) as StreamEvent | ControlEvent;
    } catch {
      return;
    }
    if (msg.type === 'pong') {
      clearTimeout(this.pongTimer);
      return;
    }
    if (msg.type === 'notification') {
      this.opts.onNotification?.(msg.notification);
      return;
    }
    if (msg.type === 'welcome' || msg.type === 'replay.unavailable') return;
    this.queue.push(msg);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      raf(() => {
        this.flushScheduled = false;
        const batch = this.queue;
        this.queue = [];
        this.opts.store.applyMany(batch);
      });
    }
  }
}
