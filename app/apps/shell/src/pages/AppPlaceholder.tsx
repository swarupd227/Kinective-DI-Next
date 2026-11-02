// Apps whose work runs through DI start the conversation from here. Views with no agent behind them
// yet say so plainly.
import { useNavigate, useParams } from 'react-router';
import { Construction, Sparkles } from 'lucide-react';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from '../shell/apps.tsx';
import page from './Page.module.css';

const PROMPTS: Record<string, string[]> = {
  reports: ['Show me last month\'s executive summary', 'Find the ALCO report'],
  workflows: ["What's in my referrals inbox?", 'Refer Suzanne Jackson for a HELOC, she prefers a call after 5 pm'],
  rm: ['Tell me about Suzanne Jackson before I call'],
  datalogs: ['Show the data logs waiting for approval', 'Show my returned data logs'],
  users: ['Who can approve incentives?', 'Create a user for Maria Gomez as a Westport MSR'],
  admin: ["Did last night's build finish?", 'Which checks failed?', 'Which uploaders missed their late-file time?'],
  seg: ['Which SEGs had the most new members?', 'Prepare me for my SEG meeting with Albany Medical'],
  callreport: ['Are we ready to file Q3?', 'Show schedule A changes over 10% from last quarter'],
};

export function AppPlaceholder({ app }: { app: string }) {
  const { module } = useParams();
  const { startThread } = useSession();
  const navigate = useNavigate();
  const key = app === 'module' ? (module ?? '') : app;
  const meta = APP_META[key];
  const agentLed = key in PROMPTS;
  const prompts = PROMPTS[key] ?? ['What can you do?'];
  return (
    <div className={page.center}>
      <span className={page.lockIcon} aria-hidden>
        {agentLed ? <Sparkles size={22} /> : <Construction size={22} />}
      </span>
      <h1 className={page.title}>{agentLed ? `${meta?.label ?? 'This'} runs through DI` : `${meta?.label ?? 'This view'} is not built yet`}</h1>
      <p className={page.lede}>
        {agentLed ? 'Ask here and DI does the work. Anything that changes data waits for your approval.' : `The classic ${meta?.label ?? ''} view is planned for ${meta?.phase ?? 'a later phase'}. In the meantime you can ask DI.`}
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
