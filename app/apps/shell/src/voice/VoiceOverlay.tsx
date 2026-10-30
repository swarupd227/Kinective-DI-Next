// Voice overlay (spec 7.12): sits above the conversation bar without hiding the canvas. It shows
// listening with a red dot and level meter, the live transcript, the understood text to check
// before it is sent, and the sentence being spoken as a caption.
import clsx from 'clsx';
import { AlertTriangle, Pencil, SendHorizontal, Square, UserRound, Volume2, VolumeX } from 'lucide-react';
import type { SearchResult } from '@dinext/block-schemas';
import { IconButton } from '@dinext/ui';
import { useVoice, useVoiceState } from './VoiceProvider.tsx';
import styles from './VoiceOverlay.module.css';

export interface TranscriptReview {
  text: string;
  /** Why it waits: an auto-send countdown, low confidence, or a spoken number to check. */
  reason: 'countdown' | 'confidence' | 'identifier';
  /** Seconds left before it sends itself, for the countdown. */
  secondsLeft?: number;
  /** People a spoken member number could mean; null while the lookup runs (spec 7.9). */
  matches?: SearchResult[] | null;
}

const BARS = 12;

export function VoiceOverlay({
  review,
  notice,
  onSend,
  onEdit,
  onStop,
  onChoose,
}: {
  review: TranscriptReview | null;
  notice: string | null;
  onSend: () => void;
  onEdit: () => void;
  onStop: () => void;
  onChoose?: (r: SearchResult) => void;
}) {
  const { speak, setSpeak } = useVoice();
  const phase = useVoiceState((s) => s.phase);
  const partial = useVoiceState((s) => s.partial);
  const level = useVoiceState((s) => s.level);
  const caption = useVoiceState((s) => s.caption);
  const error = useVoiceState((s) => s.error);
  const noisy = useVoiceState((s) => s.noisy);

  const listening = phase === 'listening';
  const speaking = phase === 'speaking';
  const processing = phase === 'processing';
  const message = error ?? notice ?? (noisy ? 'It’s noisy here. A headset helps, or you can type.' : null);
  if (!listening && !speaking && !processing && !review && !message) return null;

  return (
    <div className={styles.overlay} aria-label="Voice">
      <div className={styles.head}>
        {listening && (
          <span className={styles.state} role="status">
            <span className={styles.dot} aria-hidden />
            Listening
            <span className={styles.hint}>· release to send</span>
          </span>
        )}
        {processing && (
          <span className={styles.state} role="status">
            Understanding…
          </span>
        )}
        {speaking && (
          <span className={styles.state}>
            <Volume2 size={14} aria-hidden />
            Speaking
          </span>
        )}
        {!listening && !speaking && !processing && <span className={styles.state}>Voice</span>}
        <span className={styles.actions}>
          {(listening || speaking) && <IconButton label={listening ? 'Stop listening' : 'Stop speaking'} icon={<Square size={14} aria-hidden />} onClick={onStop} aria-keyshortcuts="Escape" />}
          <IconButton label={speak ? 'Answers are spoken. Turn off' : 'Answers are not spoken. Turn on'} icon={speak ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />} onClick={() => setSpeak(!speak)} aria-pressed={speak} />
        </span>
      </div>

      {listening && (
        <div className={styles.meter} aria-hidden>
          {Array.from({ length: BARS }, (_, i) => (
            <span key={i} className={clsx(styles.bar, i < Math.round(Math.min(1, level * 6) * BARS) && styles.barOn)} />
          ))}
        </div>
      )}

      {(listening || processing) && partial && <p className={styles.partial}>“{partial}”</p>}

      {speaking && caption && (
        // The full answer is already in the conversation; the caption follows the audio.
        <p className={styles.caption} aria-hidden>
          {caption}
        </p>
      )}

      {review && (
        <div className={styles.review}>
          <p className={styles.understood}>
            <span className="dn-visually-hidden">Understood: </span>
            {review.text}
          </p>
          {review.reason === 'confidence' && <p className={styles.check}>Is this right? Check it before sending.</p>}
          {review.reason === 'identifier' && review.matches === undefined && <p className={styles.check}>A spoken number is used only to find the record on screen. Check it, then send.</p>}
          {review.reason === 'identifier' && review.matches === null && (
            <p className={styles.check} role="status">
              Looking up who that is…
            </p>
          )}
          {review.matches && (
            <div className={styles.picker}>
              <p className={styles.check} id="voice-picker-label">
                {review.matches.length ? 'Did you mean:' : 'No one you can open has that number. Check it, or say the name.'}
              </p>
              {review.matches.length > 0 && (
                <ul className={styles.matches} aria-labelledby="voice-picker-label">
                  {review.matches.map((m) => (
                    <li key={m.id}>
                      <button type="button" className={styles.match} onClick={() => onChoose?.(m)}>
                        <UserRound size={14} aria-hidden />
                        <span className={styles.matchName}>{m.label}</span>
                        <span className={styles.matchDetail}>{m.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <span className={styles.reviewActions}>
            <button type="button" className={styles.textButton} onClick={onEdit}>
              <Pencil size={14} aria-hidden />
              Edit
            </button>
            <button type="button" className={styles.sendButton} onClick={onSend}>
              <SendHorizontal size={14} aria-hidden />
              {review.reason === 'countdown' && review.secondsLeft !== undefined ? `Send (${review.secondsLeft})` : 'Send'}
            </button>
          </span>
        </div>
      )}

      {message && (
        <p className={styles.message} role={error ? 'alert' : 'status'}>
          <AlertTriangle size={14} aria-hidden />
          {message}
        </p>
      )}
    </div>
  );
}
