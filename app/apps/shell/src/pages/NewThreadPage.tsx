// /c/new starts a conversation. With ?q= (links from Home, search and lists) it asks at once and
// replaces the URL with the new thread's.
import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../session/SessionProvider.tsx';
import { EmptyConversation } from '../conversation/Turns.tsx';
import page from './Page.module.css';

export function NewThreadPage() {
  const [params] = useSearchParams();
  const q = params.get('q');
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.home() });

  useEffect(() => {
    if (!q || started.current) return;
    started.current = true;
    startThread(q).then(
      (id) => navigate(`/c/${id}`, { replace: true }),
      () => (started.current = false),
    );
  }, [q, startThread, navigate]);

  return (
    <div className={`${page.page} ${page.narrow}`}>
      <EmptyConversation title={q ? 'Asking DI…' : 'What would you like to know?'}>
        {!q && (
          <ul className={page.prompts} aria-label="Try asking">
            {(home.data?.suggestions ?? []).map((s) => (
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
