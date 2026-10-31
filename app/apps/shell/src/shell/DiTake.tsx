// DI's view of a page, first, in a sentence, with the next step it would take. The figures below are
// for checking. The text and action come from the server, which ranks the work in code.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Sparkles } from 'lucide-react';
import { Button } from '@dinext/ui';
import type { DiTake as Take } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import styles from './DiTake.module.css';

export function DiTake({ take }: { take: Take }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { action } = take;
  return (
    <section className={styles.take} aria-label="DI’s view">
      <span className={styles.mark} aria-hidden>
        DI
      </span>
      <p className={styles.headline}>{take.headline}</p>
      {action && (
        <Button
          variant="primary"
          icon={<Sparkles size={14} aria-hidden />}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void startThread(action.ask).then((t) => navigate(`/c/${t}`), () => setBusy(false));
          }}
        >
          {action.label}
        </Button>
      )}
    </section>
  );
}
