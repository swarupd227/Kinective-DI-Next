// Command palette (spec 6.15, 8.3): Ctrl/Cmd+K from anywhere. Typed results for named objects
// within purview; Enter on text that is not an exact match asks the Concierge (FE-SRCH-003).
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Building2, FileBarChart, Landmark, LayoutDashboard, LayoutGrid, MapPin, MessagesSquare, Moon, Rows4, Slash, Sparkles, Sun, Table2, UserRound, Workflow } from 'lucide-react';
import { usePreferences } from '@dinext/ui';
import type { SearchResult, SearchResultKind } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META, appLabel } from './apps.tsx';
import { SLASH_HELP } from './commands.ts';
import { looksLikeQuestion, startsWords } from './searchMatch.ts';
import { useUi } from './uiStore.ts';
import styles from './CommandPalette.module.css';

const kindIcon: Record<SearchResultKind, ReactNode> = {
  report: <FileBarChart size={16} aria-hidden />,
  table: <Table2 size={16} aria-hidden />,
  view: <Table2 size={16} aria-hidden />,
  member: <UserRound size={16} aria-hidden />,
  employee: <UserRound size={16} aria-hidden />,
  branch: <MapPin size={16} aria-hidden />,
  workflow: <Workflow size={16} aria-hidden />,
  thread: <MessagesSquare size={16} aria-hidden />,
  dashboard: <LayoutDashboard size={16} aria-hidden />,
  application: <Landmark size={16} aria-hidden />,
  organization: <Building2 size={16} aria-hidden />,
};

/** Words people use for a page that aren't in its name ("payouts" opens Goals & Incentives). */
const PAGE_WORDS: Partial<Record<string, string>> = {
  gi: 'payouts incentives goals scorecards',
  callreport: 'ncua call report 5300 ffiec 051 041 rcon riad regulatory report cdr',
  delinquency: 'delinquency past due aging roll rates vintage collections charge-offs 30+ 60+',
  membership: 'membership growth customer growth customers member penetration attrition churn members left net growth products per member cross-sell checking direct deposit digital adoption age',
  liquidity: 'liquidity borrowing capacity fhlb discount window contingency funding cash flow ladder deposit run clf',
  irr: 'interest rate risk alm alco nev eve nii at risk rate shock repricing gap sensitivity',
  lap: 'pipeline applications loans mortgages',
  rm: 'members customers member 360',
  indirect: 'dealers auto dealer',
  seg: 'employers employer groups seg',
  compliance: 'complaints issues problems',
  onboarding: 'new members welcome',
  campaigns: 'marketing',
  predictive: 'attrition churn leaving',
  datalogs: 'adjustments data logs',
  dq: 'checks data quality',
  users: 'people staff access',
  classes: 'roles permissions',
  integrations: 'uploads files sftp',
};

/** One order every time, so groups don't jump about as results arrive: places, then records, then people. */
const KIND_ORDER: SearchResultKind[] = ['report', 'dashboard', 'table', 'view', 'workflow', 'application', 'organization', 'branch', 'member', 'employee', 'thread'];

const kindLabel = (k: SearchResultKind, person: string) =>
  ({ report: 'Reports', table: 'Tables', view: 'Saved views', member: `${person[0]!.toUpperCase()}${person.slice(1)}s`, employee: 'Employees', branch: 'Branches', workflow: 'Workflows', thread: 'Conversations', dashboard: 'Dashboards', application: 'Loan applications', organization: 'Employer groups and dealers' })[k];

export function CommandPalette() {
  const { session, api, startThread, terms } = useSession();
  const { paletteOpen, setPalette, setPrefill } = useUi();
  const { resolvedTheme, setTheme, density, setDensity } = usePreferences();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Results are kept with the query they answer, so stale replies never show under newer text.
  const [found, setFound] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
  // Once the person moves through the list (keys or pointer), Enter opens what they picked.
  const [moved, setMoved] = useState(false);
  const [picked, setPicked] = useState('');
  const threads = useQuery({ queryKey: ['threads', ''], queryFn: () => api.threads(), enabled: paletteOpen });

  // Debounced so results arrive within the 300 ms budget of the last keystroke (FE-SRCH-001).
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => api.search(q, ctrl.signal).then((results) => setFound({ q, results }), () => {}), 80);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, api]);

  const setOpen = (open: boolean) => {
    setPalette(open);
    if (!open) setQuery('');
  };
  const close = () => setOpen(false);
  const go = (path: string) => {
    close();
    navigate(path);
  };
  const ask = async (text: string) => {
    close();
    const id = await startThread(text);
    navigate(`/c/${id}`);
  };

  const q = query.trim().toLowerCase();
  const loading = Boolean(q) && found.q !== query.trim();
  // While the next answer is on its way, earlier results that still match stay put instead of vanishing.
  const results = found.q === query.trim() ? found.results : found.results.filter((r) => startsWords(q, `${r.label} ${r.detail ?? ''}`));
  const match = (s: string) => !q || startsWords(q, s);
  const grouped = KIND_ORDER.map((k) => [k, results.filter((r) => r.kind === k)] as const).filter(([, items]) => items.length > 0);
  const question = looksLikeQuestion(query);
  // Until the person picks, Enter opens the best match, or asks DI when it's a question or nothing matches.
  const bank = session.tenant.institutionType === 'bank';
  const apps = session.apps.filter((a) => APP_META[a] && match(`${appLabel(a, bank)} ${PAGE_WORDS[a] ?? ''}`));
  const dashboards = match('all dashboards browse');
  // Pages come first once something is typed: "5300" opens the Call Report, not a member whose number ends 5300.
  const best = q && apps[0] ? `app:${apps[0]}` : grouped[0] ? `${grouped[0][1][0]!.kind}:${grouped[0][1][0]!.id}` : q && dashboards ? 'app:dashboards' : null;
  const auto = question || !best ? `ask:${query}` : best;
  const slash = session.slashCommands.filter((c) => match(`${c} ${SLASH_HELP[c]?.hint ?? ''}`));
  const recent = (threads.data ?? []).filter((t) => match(t.title)).slice(0, q ? 5 : 4);

  const goTo = (apps.length > 0 || dashboards) && (
    <Command.Group heading="Go to">
      {apps.map((a) => (
        <Command.Item key={a} value={`app:${a}`} onSelect={() => go(APP_META[a]!.path)} className={styles.item}>
          <span className={styles.icon}>{APP_META[a]!.icon}</span>
          <span className={styles.label}>{appLabel(a, bank)}</span>
        </Command.Item>
      ))}
      {dashboards && (
        <Command.Item value="app:dashboards" onSelect={() => go('/dashboards')} className={styles.item}>
          <span className={styles.icon}>
            <LayoutGrid size={16} aria-hidden />
          </span>
          <span className={styles.label}>All dashboards</span>
          <span className={styles.detail}>Every table, form and report you can open</span>
        </Command.Item>
      )}
    </Command.Group>
  );

  const askItem = q && (
    <Command.Group heading="Ask DI">
      <Command.Item value={`ask:${query}`} onSelect={() => void ask(query.trim())} className={styles.item}>
        <Sparkles size={16} aria-hidden className={styles.askIcon} />
        <span className={styles.label}>
          Ask DI: <strong>{query.trim()}</strong>
        </span>
        {(question || results.length === 0) && <span className={styles.hint}>Enter</span>}
      </Command.Item>
    </Command.Group>
  );

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setOpen}
      label="Search or ask DI"
      shouldFilter={false}
      value={moved ? picked : q ? auto : undefined}
      onValueChange={setPicked}
      loop
      overlayClassName={styles.overlay}
      contentClassName={styles.dialog}
    >
      <Command.Input
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          setMoved(false);
        }}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) setMoved(true);
        }} placeholder={`Search reports, tables, ${terms.persons}, branches… or ask a question`} className={styles.input} />
      <Command.List className={styles.list} onPointerMove={() => setMoved(true)}>
        {q && goTo}
        {loading && results.length === 0 && <Command.Loading className={styles.empty}>Searching…</Command.Loading>}
        {grouped.map(([kind, items]) => (
          <Command.Group key={kind} heading={kindLabel(kind, terms.person)}>
            {items.map((r) => (
              <Command.Item key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`} onSelect={() => go(r.link)} className={styles.item}>
                <span className={styles.icon}>{kindIcon[r.kind]}</span>
                <span className={styles.label}>{r.label}</span>
                {r.detail && <span className={styles.detail}>{r.detail}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
        {recent.length > 0 && (
          <Command.Group heading="Recent tasks">
            {recent.map((t) => (
              <Command.Item key={t.threadId} value={`thread:${t.threadId}`} onSelect={() => go(`/c/${t.threadId}`)} className={styles.item}>
                <span className={styles.icon}>
                  <MessagesSquare size={16} aria-hidden />
                </span>
                <span className={styles.label}>{t.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {!q && goTo}
        {slash.length > 0 && (
          <Command.Group heading="Commands">
            {slash.map((c) => (
              <Command.Item
                key={c}
                value={`slash:${c}`}
                onSelect={() => {
                  close();
                  setPrefill(`${c} `);
                }}
                className={styles.item}
              >
                <span className={styles.icon}>
                  <Slash size={16} aria-hidden />
                </span>
                <span className={styles.label}>{c}</span>
                {SLASH_HELP[c] && <span className={styles.detail}>{SLASH_HELP[c].hint}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {match('theme dark light density compact comfortable') && (
          <Command.Group heading="Preferences">
            <Command.Item value="pref:theme" onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} className={styles.item}>
              <span className={styles.icon}>{resolvedTheme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}</span>
              <span className={styles.label}>Switch to {resolvedTheme === 'dark' ? 'light' : 'dark'} theme</span>
            </Command.Item>
            <Command.Item value="pref:density" onSelect={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} className={styles.item}>
              <span className={styles.icon}>
                <Rows4 size={16} aria-hidden />
              </span>
              <span className={styles.label}>Use {density === 'compact' ? 'comfortable' : 'compact'} density</span>
            </Command.Item>
          </Command.Group>
        )}
        {/* Always last, so it's in the same place every time. */}
        {askItem}
      </Command.List>
      <footer className={styles.footer}>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open or ask
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </footer>
    </Command.Dialog>
  );
}
