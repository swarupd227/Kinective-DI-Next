// DI's view at the top of a page: its action, and the other steps it can take, each start a task and open it.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { DiTakeView } from '@dinext/blocks';
import type { DiTake as Take } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';

export function DiTake({ take, more }: { take: Take; more?: string[] }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <DiTakeView
      take={take}
      more={more}
      busy={busy}
      onAct={(ask) => {
        // A half sentence ("Create a task to ") is for the user to finish, so it opens as a draft.
        if (/\s$/.test(ask)) return void navigate('/c/new', { state: { draft: ask } });
        setBusy(true);
        void startThread(ask).then((t) => navigate(`/c/${t}`), () => setBusy(false));
      }}
    />
  );
}
