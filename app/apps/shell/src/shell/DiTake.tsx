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
        setBusy(true);
        void startThread(ask).then((t) => navigate(`/c/${t}`), () => setBusy(false));
      }}
    />
  );
}
