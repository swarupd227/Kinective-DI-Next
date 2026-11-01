// Session bootstrap (spec 11.3): load the session, open the main stream, then render. Holds the
// API client, stream store and connection for the whole shell. Tokens would live in memory here
// (FE-ARCH-061); the mock Experience Layer needs none.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { Button } from '@dinext/ui';
import type { AppId, AppNotification, ContextRef, Session } from '@dinext/block-schemas';
import { createApiClient, createStreamStore, newClientMessageId, StreamConnection, type ApiClient, type ConnectionState, type StreamStore } from '@dinext/stream-client';
import { terminology, type Terms } from './terminology.ts';
import styles from './SessionProvider.module.css';

export interface SessionValue {
  session: Session;
  api: ApiClient;
  stream: StreamStore;
  connection: StreamConnection;
  connState: ConnectionState;
  terms: Terms;
  can: (app: AppId) => boolean;
  notifications: AppNotification[];
  markRead: (ids: string[]) => void;
  /** Sends a message to a thread, following it first so its events arrive (spec 12.3). */
  send: (threadId: string, text: string, context?: ContextRef[], slashCommand?: string, opts?: SendOptions) => Promise<void>;
  /** Creates a thread for a request asked outside a conversation (Home, palette) and sends it. */
  startThread: (text: string, context?: ContextRef[], opts?: SendOptions) => Promise<string>;
  switchPersona: (persona: string) => void;
}

export interface SendOptions {
  /** Spoken requests use the same endpoint, marked as voice (FE-API-020). */
  channel?: 'text' | 'voice';
  /** Runs once the thread exists and before the message is sent, for example to follow its speech. */
  beforeSend?: (threadId: string) => void;
}

/** Exported for tests, which provide a session without the Experience Layer. */
export const SessionContext = createContext<SessionValue | null>(null);

export const useSession = () => {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
};

// Developer persona switching works against the mock Experience Layer only.
const PERSONA_KEY = 'dinext.dev.persona';
const readPersona = () => {
  try {
    return new URLSearchParams(location.search).get('persona') ?? localStorage.getItem(PERSONA_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });

export function SessionProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionBootstrap>{children}</SessionBootstrap>
    </QueryClientProvider>
  );
}

function SessionBootstrap({ children }: { children: ReactNode }) {
  const [api] = useState(() => createApiClient({ baseUrl: '' }));
  const [persona, setPersona] = useState(readPersona);
  const sessionQuery = useQuery({ queryKey: ['session', persona], queryFn: () => api.session(persona), staleTime: Infinity });
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const [live] = useState(() => {
    const holder: { connection?: StreamConnection } = {};
    const stream = createStreamStore({ onGap: () => holder.connection?.requestReplay() });
    holder.connection = new StreamConnection({
      store: stream,
      clientVersion: '0.2.0',
      onState: setConnState,
      onNotification: (n) => {
        setNotifications((xs) => [n, ...xs.filter((x) => x.id !== n.id)]);
        // A new card joins Home at once. A decided one stays there, showing how it ended.
        if (n.group === 'approvals' && !n.read) void queryClient.invalidateQueries({ queryKey: ['home'] });
      },
      url: async () => {
        const res = await fetch('/v1/stream/ticket', { method: 'POST' });
        if (!res.ok) throw new Error('ticket');
        const { ticket } = (await res.json()) as { ticket: string };
        return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/stream?ticket=${ticket}`;
      },
    });
    return { stream, connection: holder.connection };
  });

  useEffect(() => {
    live.connection.start();
    return () => live.connection.stop();
  }, [live]);

  const session = sessionQuery.data;
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api.notifications().then((n) => !cancelled && setNotifications(n), () => {});
    return () => {
      cancelled = true;
    };
  }, [api, session]);

  const markRead = useCallback(
    (ids: string[]) => {
      // Marking read is harmless and reversible, so it is optimistic (spec 11.7).
      setNotifications((xs) => xs.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)));
      void api.markNotificationsRead(ids).catch(() => {});
    },
    [api],
  );

  const send = useCallback(
    async (threadId: string, text: string, context: ContextRef[] = [], slashCommand?: string, opts: SendOptions = {}) => {
      live.connection.subscribe(threadId);
      opts.beforeSend?.(threadId);
      await api.sendMessage(threadId, { clientMessageId: newClientMessageId(), input: { kind: 'text', text }, inputChannel: opts.channel ?? 'text', context, slashCommand });
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
    [api, live],
  );

  const startThread = useCallback(
    async (text: string, context: ContextRef[] = [], opts: SendOptions = {}) => {
      const t = await api.createThread();
      await send(t.threadId, text, context, undefined, opts);
      return t.threadId;
    },
    [api, send],
  );

  const switchPersona = useCallback((p: string) => {
    try {
      localStorage.setItem(PERSONA_KEY, p);
    } catch {
      // Not persisted; the switch still applies to this tab.
    }
    queryClient.clear();
    setPersona(p);
  }, []);

  const value = useMemo<SessionValue | null>(() => {
    if (!session) return null;
    const apps = new Set(session.apps);
    return {
      session,
      api,
      stream: live.stream,
      connection: live.connection,
      connState,
      terms: terminology(session.tenant.institutionType),
      can: (app) => apps.has(app),
      notifications,
      markRead,
      send,
      startThread,
      switchPersona,
    };
  }, [session, api, live, connState, notifications, markRead, send, startThread, switchPersona]);

  if (sessionQuery.isError) {
    return (
      <div className={styles.splash} role="alert">
        <p className={styles.title}>DI could not start</p>
        <p className={styles.detail}>The Experience Layer did not answer. If you are running locally, start the mock server with npm run dev.</p>
        <Button icon={<RotateCw size={16} aria-hidden />} onClick={() => void sessionQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!value) {
    return (
      <div className={styles.splash} role="status" aria-label="Loading Data Intelligence">
        <span className={styles.mark} aria-hidden>
          DI
        </span>
      </div>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
