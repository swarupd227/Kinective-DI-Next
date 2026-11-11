// The header's Feedback button (DI's global feedback): a short note about any page, kept with the page
// it was sent from, for the AI governance team's feedback queue. Answers keep their own thumbs up and down.
import { useState } from 'react';
import { useLocation } from 'react-router';
import { MessageSquarePlus } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { Button, IconButton } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import styles from './FeedbackButton.module.css';

export function FeedbackButton() {
  const { api } = useSession();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const send = async () => {
    if (!text.trim()) return;
    setState('sending');
    try {
      await api.generalFeedback({ comment: text.trim(), page: pathname });
      setState('sent');
      setText('');
    } catch {
      setState('failed');
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setState('idle');
      }}
    >
      <Popover.Trigger asChild>
        <IconButton label="Send feedback" icon={<MessageSquarePlus size={18} aria-hidden />} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.panel} align="end" sideOffset={6} collisionPadding={8}>
          {state === 'sent' ? (
            <p className={styles.done} role="status">
              Thanks. Your feedback went to the team that looks after DI, with the page you sent it from.
            </p>
          ) : (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className={styles.label} htmlFor="di-feedback">
                What’s working, or what isn’t?
              </label>
              <textarea id="di-feedback" className={styles.text} rows={4} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell us about this page or anything in DI." />
              {state === 'failed' && (
                <p className={styles.error} role="alert">
                  That didn’t send. Try again in a moment.
                </p>
              )}
              <div className={styles.actions}>
                <span className={styles.count}>{text.length}/500</span>
                <Button variant="primary" size="sm" type="submit" busy={state === 'sending'} disabled={!text.trim()}>
                  Send
                </Button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
