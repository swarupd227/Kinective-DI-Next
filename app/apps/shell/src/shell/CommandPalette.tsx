// Command palette (spec 6.15, 8.3): Ctrl/Cmd+K from anywhere. Typed results for named objects
// within purview; Enter on text that is not an exact match asks the Concierge (FE-SRCH-003).
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { FileBarChart, LayoutDashboard, MapPin, MessagesSquare, Moon, Rows4, Slash, Sparkles, Sun, Table2, UserRound, Workflow } from 'lucide-react';
import { usePreferences } from '@dinext/ui';
import type { SearchResult, SearchResultKind } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from './apps.tsx';
import { SLASH_HELP } from './commands.ts';
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
};

const kindLabel = (k: SearchResultKind, person: string) =>
  ({ report: 'Reports', table: 'Tables', view: 'Saved views', member: `${person[0]!.toUpperCase()}${person.slice(1)}s`, employee: 'Employees', branch: 'Branches', workflow: 'Workflows', thread: 'Conversations', dashboard: 'Dashboards' })[k];

export function CommandPalette() {
  const { session, api, startThread, terms } = useSession();
  const { paletteOpen, setPalette, setPrefill } = useUi();
  const { resolvedTheme, setTheme, density, setDensity } = usePreferences();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Results are kept with the query they answer, so stale replies never show under newer text.
  const [found, setFound] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
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
  const results = found.q === query.trim() ? found.results : [];
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const exact = results.some((r) => r.label.toLowerCase() === q);
  const grouped = [...results.reduce((m, r) => m.set(r.kind, [...(m.get(r.kind) ?? []), r]), new Map<SearchResultKind, SearchResult[]>()).entries()];
  const apps = session.apps.filter((a) => APP_META[a] && match(APP_META[a]!.label));
  const slash = session.slashCommands.filter((c) => match(`${c} ${SLASH_HELP[c]?.hint ?? ''}`));
  const recent = (threads.data ?? []).filter((t) => match(t.title)).slice(0, q ? 5 : 4);

  const askItem = q && (
    <Command.Group heading="Ask DI">
      <Command.Item value={`ask:${query}`} onSelect={() => void ask(query.trim())} className={styles.item}>
        <Sparkles size={16} aria-hidden className={styles.askIcon} />
        <span className={styles.label}>
          Ask DI: <strong>{query.trim()}</strong>
        </span>
        <span className={styles.hint}>Enter</span>
      </Command.Item>
    </Command.Group>
  );

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setOpen}
      label="Search or ask DI"
      shouldFilter={false}
      loop
      overlayClassName={styles.overlay}
      contentClassName={styles.dialog}
    >
      <Command.Input value={query} onValueChange={setQuery} placeholder={`Search reports, tables, ${terms.persons}, branches… or ask a question`} className={styles.input} />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>No matches. Press Enter to ask DI.</Command.Empty>
        {!exact && askItem}
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
        {exact && askItem}
        {recent.length > 0 && (
          <Command.Group heading="Recent conversations">
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
        {apps.length > 0 && (
          <Command.Group heading="Go to">
            {apps.map((a) => (
              <Command.Item key={a} value={`app:${a}`} onSelect={() => go(APP_META[a]!.path)} className={styles.item}>
                <span className={styles.icon}>{APP_META[a]!.icon}</span>
                <span className={styles.label}>{APP_META[a]!.label}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
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
