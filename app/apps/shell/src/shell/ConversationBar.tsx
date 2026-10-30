// The single input for text, push-to-talk voice and (later) files, with the active context chips
// (spec 6.2, 6.7, 6.14). "/" lists slash commands; "@" adds a context reference by name.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useStore } from 'zustand';
import clsx from 'clsx';
import { ArrowUp, AtSign, FileBarChart, Landmark, MapPin, MessageSquare, Mic, MicOff, Paperclip, Slash, Sparkles, Square, Table2, UserRound, WifiOff } from 'lucide-react';
import { Chip, IconButton, useAnnouncer } from '@dinext/ui';
import type { ApprovalCardBlock, ContextRef, SearchResult, SearchResultKind } from '@dinext/block-schemas';
import { classifyConfirmation } from '@dinext/voice/language';
import { useSession } from '../session/SessionProvider.tsx';
import { useVoice, useVoiceState } from '../voice/VoiceProvider.tsx';
import { VoiceOverlay, type TranscriptReview } from '../voice/VoiceOverlay.tsx';
import type { FinalTranscript } from '../voice/voiceClient.ts';
import { SLASH_HELP } from './commands.ts';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './ConversationBar.module.css';

const EMPTY: ContextRef[] = [];

const contextIcon: Partial<Record<ContextRef['type'], ReactNode>> = {
  member: <UserRound size={12} aria-hidden />,
  hierarchy_node: <MapPin size={12} aria-hidden />,
  table: <Table2 size={12} aria-hidden />,
  report: <FileBarChart size={12} aria-hidden />,
  block: <Sparkles size={12} aria-hidden />,
};

const resultToContext = (r: SearchResult): ContextRef | null => {
  const map: Partial<Record<SearchResultKind, ContextRef['type']>> = { member: 'member', branch: 'hierarchy_node', employee: 'employee', report: 'report', table: 'table', view: 'table', workflow: 'workflow_item' };
  const type = map[r.kind];
  return type ? { type, ref: r.id, label: r.kind === 'branch' ? `Branch: ${r.label}` : r.label } : null;
};

type Suggestion = { id: string; label: string; detail?: string; icon: ReactNode; apply: () => void };

/** Push-to-talk shows the understood text for 1.5 s before sending it (FE-VOICE-050). */
const AUTO_SEND_MS = 1500;
/** Below this, the transcript waits for the user to check it (FE-VOICE-080). */
const MIN_CONFIDENCE = 0.6;

export function ConversationBar({ threadId, collapsedByDefault }: { threadId?: string; collapsedByDefault: boolean }) {
  const { session, api, send, startThread, stream, connState, terms } = useSession();
  const { announce } = useAnnouncer();
  const navigate = useNavigate();
  const bp = useBreakpoint();
  const key = threadId ?? 'new';
  const chips = useUi((s) => s.contexts[key] ?? EMPTY);
  const { removeContext, addContext, moveContext } = useUi.getState();
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(!collapsedByDefault);
  const [active, setActive] = useState(0);
  // Results are kept with the text they answer, so a slow reply never shows under a newer query.
  const [mention, setMention] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Set when an action expands the bar and wants the input focused once it renders. */
  const focusNext = useRef(false);
  const listId = useId();

  const running = useStore(stream.store, (s) => {
    const t = threadId ? s.threads[threadId] : undefined;
    return t?.turns.findLast((x) => x.kind === 'agent' && x.state === 'running') as { runId: string } | undefined;
  });

  // ---- voice (spec 7) ----
  const voice = useVoice();
  const phase = useVoiceState((s) => s.phase);
  const readBacks = useVoiceState((s) => s.readBacks);
  const [review, setReview] = useState<TranscriptReview | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const autoSend = useRef<{ timer: ReturnType<typeof setInterval> } | null>(null);
  const pttHeld = useRef(false);
  const listening = phase === 'listening';

  const clearAutoSend = useCallback(() => {
    if (autoSend.current) clearInterval(autoSend.current.timer);
    autoSend.current = null;
  }, []);

  // Spoken answers follow the conversation on screen.
  useEffect(() => {
    if (threadId) voice.client?.subscribe(threadId, voice.speak, voice.rate);
  }, [threadId, voice.client, voice.speak, voice.rate]);

  const startListening = () => {
    if (!voice.client || pttHeld.current) return;
    pttHeld.current = true;
    clearAutoSend();
    setReview(null);
    setVoiceNotice(null);
    void voice.client.startCapture({ threadId, speak: voice.speak, rate: voice.rate });
  };
  const stopListening = () => {
    if (!pttHeld.current) return;
    pttHeld.current = false;
    voice.client?.stopCapture();
  };

  // Moving between a classic view and a conversation resets the collapsed state.
  const [collapsedFor, setCollapsedFor] = useState(collapsedByDefault);
  if (collapsedFor !== collapsedByDefault) {
    setCollapsedFor(collapsedByDefault);
    setExpanded(!collapsedByDefault);
  }

  // The palette can hand over a slash command or a draft question.
  useEffect(
    () =>
      useUi.subscribe((s) => {
        if (s.prefill === null) return;
        setText(s.prefill);
        setExpanded(true);
        useUi.getState().setPrefill(null);
        focusNext.current = true;
      }),
    [],
  );

  // "/" focuses the conversation bar when focus is not already in a field (spec 10.7).
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable && !t.closest('[role=dialog]')) {
        e.preventDefault();
        focusNext.current = true;
        setExpanded(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (focusNext.current) {
      focusNext.current = false;
      el.focus();
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text, expanded]);

  // Slash commands at the start of the input; "@word" at the caret looks up context references.
  const slashQuery = /^\/(\w*)$/.exec(text)?.[1];
  const mentionQuery = /(?:^|\s)@([\w'-]{1,40})$/.exec(text)?.[1];

  useEffect(() => {
    if (!mentionQuery) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      // Names that start with the text rank first, then names containing it, then detail matches.
      const q = mentionQuery.toLowerCase();
      const rank = (r: SearchResult) => (r.label.toLowerCase().startsWith(q) ? 0 : r.label.toLowerCase().includes(q) ? 1 : 2);
      api.search(mentionQuery, ctrl.signal).then(
        (r) => setMention({ q: mentionQuery, results: r.filter((x) => resultToContext(x)).sort((a, b) => rank(a) - rank(b)).slice(0, 8) }),
        () => {},
      );
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [mentionQuery, api]);

  const suggestions = ((): Suggestion[] => {
    if (slashQuery !== undefined) {
      return session.slashCommands
        .filter((c) => c.slice(1).startsWith(slashQuery.toLowerCase()))
        .map((c) => ({
          id: c,
          label: c,
          detail: SLASH_HELP[c] ? `${SLASH_HELP[c].hint} · ${SLASH_HELP[c].routedTo}` : undefined,
          icon: <Slash size={14} aria-hidden />,
          apply: () => setText(`${c} `),
        }));
    }
    if (mentionQuery && mention.q === mentionQuery) {
      return mention.results.map((r) => ({
        id: `${r.kind}:${r.id}`,
        label: r.label,
        detail: r.detail,
        icon: r.kind === 'member' ? <UserRound size={14} aria-hidden /> : r.kind === 'branch' ? <MapPin size={14} aria-hidden /> : r.kind === 'table' ? <Table2 size={14} aria-hidden /> : r.kind === 'report' ? <FileBarChart size={14} aria-hidden /> : <Landmark size={14} aria-hidden />,
        apply: () => {
          const c = resultToContext(r);
          if (c) {
            addContext(key, c);
            announce(`Added context ${c.label}`);
          }
          setText((t) => t.replace(/@[\w'-]{1,40}$/, ''));
        },
      }));
    }
    return [];
  })();

  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));
  const canSend = connState === 'open' && text.trim().length > 0 && !sending;

  const submit = async (channel: 'text' | 'voice' = 'text', override?: string, extra: ContextRef[] = []) => {
    const value = (override ?? text).trim();
    if (connState !== 'open' || !value || sending) return;
    clearAutoSend();
    setReview(null);
    const slash = /^\/\w+/.exec(value)?.[0];
    // A spoken request's answer is spoken on this device, so follow the thread before sending.
    const opts = { channel, beforeSend: channel === 'voice' ? (id: string) => voice.client?.subscribe(id, voice.speak, voice.rate) : undefined };
    const context = [...chips, ...extra.filter((x) => !chips.some((c) => c.type === x.type && c.ref === x.ref))];
    setSending(true);
    try {
      if (threadId) {
        await send(threadId, value, context, slash, opts);
      } else {
        const id = await startThread(value, context, opts);
        moveContext('new', id);
        navigate(`/c/${id}`);
      }
      setText('');
    } catch {
      announce('Your message was not sent. Check the connection and try again.', 'assertive');
    } finally {
      setSending(false);
    }
  };

  /** The card a spoken "confirm" would act on: the newest pending one in this thread. */
  const pendingCard = (): ApprovalCardBlock['data'] | null => {
    const t = threadId ? stream.store.getState().threads[threadId] : undefined;
    const blockId = t?.pendingApprovals.at(-1);
    const data = blockId ? (t!.blocks[blockId]?.envelope.data as ApprovalCardBlock['data'] | undefined) : undefined;
    return data?.approvalId ? data : null;
  };

  /** Spoken confirmation of a visible card (spec 7.6). The server checks the same rules again. */
  const confirmByVoice = async (kind: 'confirm' | 'deny' | 'ambiguous', card: ApprovalCardBlock['data']) => {
    const fail = (message: string, phrase?: 'needs_screen_approval' | 'press_approve' | 'say_confirm') => {
      setVoiceNotice(message);
      if (phrase) voice.client?.say(phrase);
      announce(message);
    };
    if (kind === 'ambiguous') return fail('I didn’t catch a clear yes. Say “confirm”, or press Approve.', 'say_confirm');
    if (kind === 'confirm') {
      if (card.riskTier === 'high' || !card.confirmation.methods.includes('voice')) return fail('This needs your approval on screen.', 'needs_screen_approval');
      if (card.riskTier === 'medium' && !session.flags.voiceMediumConfirm) return fail('Press Approve to confirm this one.', 'press_approve');
      if (card.riskTier === 'medium' && !readBacks.includes(card.approvalId)) return fail('Wait for the summary to finish, then say “confirm”.');
    }
    const result = await api.decide(
      card.approvalId,
      { decision: kind === 'confirm' ? 'approve' : 'deny', channel: 'voice', typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash } },
      card.idempotencyKey,
    );
    if (result.ok) {
      setVoiceNotice(null);
      announce(`${kind === 'confirm' ? 'Approved' : 'Denied'} by voice: ${card.summary}`);
    } else {
      fail(result.message ?? 'That didn’t go through. Use the buttons on the card.');
    }
  };

  const onFinal = (f: FinalTranscript) => {
    clearAutoSend();
    if (!f.text.trim()) {
      setVoiceNotice('I didn’t hear anything. Hold the microphone and speak, then release.');
      return;
    }
    const card = pendingCard();
    const kind = card ? classifyConfirmation(f.text) : null;
    if (card && kind) {
      void confirmByVoice(kind, card);
      return;
    }
    setText(f.normalised);
    setExpanded(true);
    // A spoken member number is only a lookup: show who it could be and let the user pick on screen
    // ("Did you mean Suzanne Jackson, member …4521?", spec 7.9). The number itself is never sent.
    const spoken = f.identifiers.find((i) => i.kind === 'member');
    if (spoken && session.apps.includes('rm')) {
      setReview({ text: f.normalised, reason: 'identifier', matches: null });
      const said = f.text.toLowerCase();
      api
        .search(spoken.last4, undefined, 'member')
        .then((results) => {
          const members = results.filter((r) => r.kind === 'member');
          // People whose name was also spoken come first.
          const score = (r: SearchResult) => r.label.toLowerCase().split(/\s+/).filter((w) => said.includes(w)).length;
          setReview((r) => (r?.text === f.normalised ? { ...r, matches: members.sort((a, b) => score(b) - score(a)).slice(0, 4) } : r));
        })
        .catch(() => setReview((r) => (r?.text === f.normalised ? { ...r, matches: [] } : r)));
      return;
    }
    if (f.identifiers.length) return setReview({ text: f.normalised, reason: 'identifier' });
    if (f.confidence < MIN_CONFIDENCE) return setReview({ text: f.normalised, reason: 'confidence' });
    setReview({ text: f.normalised, reason: 'countdown', secondsLeft: Math.ceil(AUTO_SEND_MS / 1000) });
    let left = AUTO_SEND_MS;
    const timer = setInterval(() => {
      left -= 100;
      if (left > 0) return setReview((r) => (r ? { ...r, secondsLeft: Math.ceil(left / 1000) } : r));
      clearAutoSend();
      void submitRef.current('voice', f.normalised);
    }, 100);
    autoSend.current = { timer };
  };

  // Handlers change every render; the subscription calls the latest ones.
  const onFinalRef = useRef(onFinal);
  const submitRef = useRef(submit);
  useEffect(() => {
    onFinalRef.current = onFinal;
    submitRef.current = submit;
  });
  useEffect(() => voice.finals.subscribe((s) => s.final && onFinalRef.current(s.final)), [voice.finals]);
  useEffect(() => clearAutoSend, [clearAutoSend]);

  // Ctrl/Cmd+Shift+Space starts listening, and again stops (spec 7.1).
  useEffect(() => {
    if (!voice.client) return;
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.code !== 'Space' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (voice.client!.isCapturing) {
        pttHeld.current = true;
        stopListening();
      } else {
        setExpanded(true);
        startListening();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Typing over a transcript that was about to send means the user is editing it.
    if (review?.reason === 'countdown' && e.key.length === 1) {
      clearAutoSend();
      setReview(null);
    }
    // Holding Space in an empty input talks (spec 7.1).
    if (voice.client && e.key === ' ' && !text && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      startListening();
      return;
    }
    if (e.key === ' ' && listening) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && (voice.client?.isSpeaking || listening)) {
      // Esc stops speech first, then a running run (FE-VOICE-020).
      e.preventDefault();
      if (listening) {
        pttHeld.current = false;
        voice.client?.stopCapture(false);
      } else voice.client?.cancelSpeech();
      return;
    }
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        suggestions[activeIndex]?.apply();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText((t) => (slashQuery !== undefined ? '' : t.replace(/@[\w'-]*$/, '')));
        return;
      }
    }
    if (e.key === 'Escape' && running) {
      // Esc cancels the running run (FE-EXP-090).
      e.preventDefault();
      void api.cancelRun(running.runId);
      announce('Stopping the run');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ' ' && pttHeld.current) {
      e.preventDefault();
      stopListening();
    }
  };

  const micButton = voice.available ? (
    <button
      type="button"
      className={clsx(styles.mic, listening && styles.micLive)}
      aria-label={listening ? 'Listening. Release to send' : 'Hold to talk'}
      aria-pressed={listening}
      aria-keyshortcuts="Control+Shift+Space"
      title="Hold to talk (or hold Space in an empty box, or Ctrl+Shift+Space)"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        startListening();
      }}
      onPointerUp={stopListening}
      onPointerCancel={stopListening}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          startListening();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          stopListening();
        }
      }}
    >
      <Mic size={18} aria-hidden />
    </button>
  ) : (
    <IconButton label={voice.reason ?? 'Voice is not available'} icon={<MicOff size={18} aria-hidden />} disabled />
  );

  if (!expanded) {
    return (
      <div className={styles.wrap} data-region="bar" tabIndex={-1}>
        <button
          type="button"
          className={styles.collapsed}
          onClick={() => {
            focusNext.current = true;
            setExpanded(true);
          }}
        >
          <MessageSquare size={16} aria-hidden />
          Ask DI about this view…
          <kbd className={styles.kbd}>/</kbd>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-region="bar" tabIndex={-1}>
      {voice.available && (
        <VoiceOverlay
          review={review}
          notice={voiceNotice}
          onSend={() => void submit('voice')}
          onChoose={(r) => {
            // The chosen person replaces the spoken number, and goes with the request as a chip.
            const chip = resultToContext(r);
            if (!chip || !review) return;
            addContext(key, chip);
            void submit('voice', review.text.replace(/\b(member|customer)\s+…\d{4}\b/i, r.label), [chip]);
          }}
          onEdit={() => {
            clearAutoSend();
            setReview(null);
            ref.current?.focus();
          }}
          onStop={() => {
            if (listening) {
              pttHeld.current = false;
              voice.client?.stopCapture(false);
            } else voice.client?.cancelSpeech();
          }}
        />
      )}
      <div className={clsx(styles.bar, open && styles.barOpen)}>
        {open && (
          <div id={listId} role="listbox" className={styles.suggest} aria-label={slashQuery !== undefined ? 'Commands' : 'Add context'}>
            {suggestions.map((s, i) => (
              <div
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                // Options are reached through aria-activedescendant; focus stays in the input.
                tabIndex={-1}
                aria-selected={i === activeIndex}
                className={clsx(styles.option, i === activeIndex && styles.optionActive)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  s.apply();
                  ref.current?.focus();
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className={styles.optionIcon}>{s.icon}</span>
                <span className={styles.optionLabel}>{s.label}</span>
                {s.detail && <span className={styles.optionDetail}>{s.detail}</span>}
              </div>
            ))}
          </div>
        )}
        <div className={styles.inputRow}>
          <IconButton label="Attach a file (coming with file upload)" icon={<Paperclip size={18} aria-hidden />} disabled />
          <label htmlFor="conversation-input" className="dn-visually-hidden">
            Ask DI
          </label>
          <textarea
            id="conversation-input"
            ref={ref}
            rows={1}
            className={styles.input}
            placeholder={threadId ? 'Ask a follow-up…' : bp === 'phone' ? 'Ask DI…' : `Ask DI or type / for commands, @ for a ${terms.person} or branch…`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
          />
          {micButton}
          {running && !text ? (
            <button type="button" className={clsx(styles.send, styles.stop)} onClick={() => void api.cancelRun(running.runId)} aria-label="Stop the run" aria-keyshortcuts="Escape">
              <Square size={14} aria-hidden />
            </button>
          ) : (
            <button type="button" className={styles.send} onClick={() => void submit()} disabled={!canSend} aria-label="Send">
              <ArrowUp size={18} aria-hidden />
            </button>
          )}
        </div>
        {(chips.length > 0 || connState !== 'open') && (
          <div className={styles.chips}>
            {connState !== 'open' && (
              <span className={styles.offline} role="status">
                <WifiOff size={12} aria-hidden />
                {connState === 'connecting' ? 'Connecting…' : 'Reconnecting. Your message stays here until the connection is back.'}
              </span>
            )}
            {chips.length > 0 && (
              <ul className={styles.chipList} aria-label="Context for the next message">
                {chips.map((c) => (
                  <li key={`${c.type}:${c.ref}`}>
                    <Chip tone="accent" icon={contextIcon[c.type] ?? <AtSign size={12} aria-hidden />} onRemove={() => removeContext(key, c)} removeLabel={`Remove context ${c.label}`}>
                      {c.label}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
