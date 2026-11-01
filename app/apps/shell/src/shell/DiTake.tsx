// DI's view at the top of a page: the action starts a task and opens it.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { DiTakeView } from '@dinext/blocks';
import type { DiTake as Take } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';

export function DiTake({ take }: { take: Take }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <DiTakeView
      take={take}
      busy={busy}
      onAct={(ask) => {
        setBusy(true);
        void startThread(ask).then((t) => navigate(`/c/${t}`), () => setBusy(false));
      }}
    />
  );
}
