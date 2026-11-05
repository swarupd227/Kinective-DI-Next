// /c/new starts a task. With ?q= (links from Home, search and lists) it asks at once and replaces
// the URL with the new thread's.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import { ConversationBar } from '../shell/ConversationBar.tsx';
import { EmptyConversation } from '../conversation/Turns.tsx';
import page from './Page.module.css';

export function NewThreadPage() {
  const [params] = useSearchParams();
  const q = params.get('q');
  /** A sentence to finish, from a page such as Reports ("Build me a monthly report with "). */
  const draft = (useLocation().state as { draft?: string } | null)?.draft;
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.home() });

  const start = useCallback(() => {
    if (!q || started.current) return;
    started.current = true;
    setFailed(false);
    startThread(q).then(
      (id) => navigate(`/c/${id}`, { replace: true }),
      () => {
        started.current = false;
        setFailed(true);
      },
    );
  }, [q, startThread, navigate]);

  useEffect(start, [start]);

  return (
    <div className={`${page.page} ${page.narrow}`}>
      <EmptyConversation title={failed ? 'That didn’t start' : q ? 'Starting…' : 'What should we work on?'}>
        {failed && (
          <>
            <p className={page.lede} role="alert">
              DI couldn’t be reached, so nothing was asked. Your question is still here.
            </p>
            <Button variant="primary" onClick={start}>
              Try again
            </Button>
          </>
        )}
        {!q && <ConversationBar collapsedByDefault={false} hero draft={draft} />}
        {!q && (
          <ul className={page.prompts} aria-label="Try asking">
            {(home.data?.suggestions ?? []).slice(0, 4).map((s) => (
              <li key={s}>
                <button type="button" className={page.prompt} onClick={() => void startThread(s).then((id) => navigate(`/c/${id}`, { replace: true }))}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </EmptyConversation>
    </div>
  );
}
