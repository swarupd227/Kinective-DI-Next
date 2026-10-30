// Voice for the shell: one VoiceClient per tab, started when the session says voice is available.
// Speech settings stay in this browser, like theme and density; they hold no institution data.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useSession } from '../session/SessionProvider.tsx';
import { VoiceClient, type FinalTranscript, type VoiceState } from './voiceClient.ts';

const SPEAK_KEY = 'dinext.voice.speak';
const RATE_KEY = 'dinext.voice.rate';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted; the setting still applies to this tab.
  }
};

export interface VoiceValue {
  available: boolean;
  /** Why voice is off, shown on the microphone button. */
  reason?: string;
  client: VoiceClient | null;
  speak: boolean;
  setSpeak: (on: boolean) => void;
  rate: number;
  setRate: (rate: number) => void;
  /** The latest final transcript, numbered so the same text twice still arrives. */
  finals: StoreApi<{ seq: number; final: FinalTranscript | null }>;
}

/** Exported for tests, which provide a voice client stub. */
export const VoiceContext = createContext<VoiceValue | null>(null);

const NONE: VoiceValue = {
  available: false,
  client: null,
  speak: false,
  setSpeak: () => {},
  rate: 1,
  setRate: () => {},
  finals: createStore(() => ({ seq: 0, final: null })),
};

/** Outside a VoiceProvider (tests, the gallery) voice is simply unavailable. */
export const useVoice = () => useContext(VoiceContext) ?? NONE;

const OFF: VoiceState = { phase: 'off', partial: '', level: 0, caption: '', error: null, noisy: false, readBacks: [] };
const offStore = createStore<VoiceState>(() => OFF);

export const useVoiceState = <T,>(pick: (s: VoiceState) => T): T => {
  const { client } = useVoice();
  return useStore(client?.store ?? offStore, pick);
};

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const available = session.voice?.available ?? false;
  const [speak, setSpeakState] = useState(() => (read(SPEAK_KEY) ?? String(session.voice?.speakByDefault ?? true)) === 'true');
  const [rate, setRateState] = useState(() => Math.min(1.5, Math.max(0.75, Number(read(RATE_KEY) ?? 1) || 1)));
  const [finals] = useState(() => createStore<{ seq: number; final: FinalTranscript | null }>(() => ({ seq: 0, final: null })));

  const [client] = useState(() =>
    available
      ? new VoiceClient({
          ticketUrl: async () => {
            const res = await fetch('/v1/stream/ticket', { method: 'POST' });
            if (!res.ok) throw new Error('ticket');
            const { ticket } = (await res.json()) as { ticket: string };
            return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/voice?ticket=${ticket}`;
          },
          onFinal: (final) => finals.setState((s) => ({ seq: s.seq + 1, final })),
        })
      : null,
  );

  useEffect(() => {
    client?.start();
    return () => client?.stop();
  }, [client]);

  const value = useMemo<VoiceValue>(
    () => ({
      available: Boolean(client),
      reason: session.voice?.reason,
      client,
      speak,
      setSpeak: (on) => {
        setSpeakState(on);
        write(SPEAK_KEY, String(on));
        if (!on) client?.cancelSpeech();
      },
      rate,
      setRate: (r) => {
        setRateState(r);
        write(RATE_KEY, String(r));
      },
      finals,
    }),
    [client, session.voice?.reason, speak, rate, finals],
  );
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
