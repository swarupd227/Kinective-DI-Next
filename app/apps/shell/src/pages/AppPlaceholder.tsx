// Classic views not built yet say so plainly and offer the conversational path meanwhile.
import { useNavigate, useParams } from 'react-router';
import { Construction } from 'lucide-react';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from '../shell/apps.tsx';
import page from './Page.module.css';

const PROMPTS: Record<string, string[]> = {
  reports: ['Show me last month\'s executive summary', 'Find the ALCO report'],
  workflows: ["What's in my referrals inbox?", 'Refer Suzanne Jackson for a HELOC, she prefers a call after 5 pm'],
  rm: ['Tell me about Suzanne Jackson before I call'],
};

export function AppPlaceholder({ app }: { app: string }) {
  const { module } = useParams();
  const { startThread } = useSession();
  const navigate = useNavigate();
  const key = app === 'module' ? (module ?? '') : app;
  const meta = APP_META[key];
  const prompts = PROMPTS[key] ?? ['What can you do?'];
  return (
    <div className={page.center}>
      <span className={page.lockIcon} aria-hidden>
        <Construction size={22} />
      </span>
      <h1 className={page.title}>{meta?.label ?? 'This view'} is not built yet</h1>
      <p className={page.lede}>
        The classic {meta?.label ?? ''} view is planned for {meta?.phase ?? 'a later phase'}. In the meantime you can ask DI.
      </p>
      <ul className={page.prompts} aria-label="Ask instead">
        {prompts.map((p) => (
          <li key={p}>
            <button type="button" className={page.prompt} onClick={() => void startThread(p).then((id) => navigate(`/c/${id}`))}>
              {p}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
