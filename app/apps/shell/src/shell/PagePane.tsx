// A real page beside the conversation. It runs on its own in-memory history, so links inside it stay
// in the pane and Back walks through them, while the task keeps its place. A view that fails stays
// in the pane; the conversation beside it keeps working. Routes mirror router.tsx for the views that
// open here; anything else, such as a task it starts, leaves through the main router.
import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, UNSAFE_LocationContext, UNSAFE_RouteContext, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, ExternalLink, MessageSquarePlus } from 'lucide-react';
import { Button, IconButton, Skeleton } from '@dinext/ui';
import type { AppId, ContextRef } from '@dinext/block-schemas';
import { RequireApp } from '../session/RequireApp.tsx';
import { useUi } from './uiStore.ts';
import styles from './PagePane.module.css';

const load = <K extends string>(open: () => Promise<Record<K, () => ReactNode>>, name: K) => lazy(() => open().then((m) => ({ default: m[name] })));
const TablesPage = load(() => import('../pages/TablesPage.tsx'), 'TablesPage');
const TablePage = load(() => import('../pages/TablesPage.tsx'), 'TablePage');
const ReportsPage = load(() => import('../pages/ReportsPage.tsx'), 'ReportsPage');
const ReportPage = load(() => import('../pages/ReportsPage.tsx'), 'ReportPage');
const ReferralsPage = load(() => import('../pages/ReferralsPage.tsx'), 'ReferralsPage');
const GoalsPage = load(() => import('../pages/GoalsPage.tsx'), 'GoalsPage');
const PipelinePage = load(() => import('../pages/PipelinePage.tsx'), 'PipelinePage');
const MemberPage = load(() => import('../pages/MemberPage.tsx'), 'MemberPage');
const AppViewPage = lazy(() => import('../pages/AppViewPage.tsx').then((m) => ({ default: m.AppViewPage })));
const CalendarPage = load(() => import('../pages/AppViewPage.tsx'), 'CalendarPage');
const FilesPage = load(() => import('../pages/AppViewPage.tsx'), 'FilesPage');
const QueriesPage = load(() => import('../pages/AppViewPage.tsx'), 'QueriesPage');
const MembersPage = load(() => import('../pages/AppViewPage.tsx'), 'MembersPage');

/** Blank router state, so the pane's own routes aren't read as children of the conversation's. */
const NO_ROUTE = { outlet: null, matches: [], isDataRoute: false };

class PaneBoundary extends Component<{ children: ReactNode; route: string }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidUpdate(prev: { route: string }) {
    if (prev.route !== this.props.route && this.state.failed) this.setState({ failed: false });
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className={styles.failed} role="alert">
        This view couldn’t be shown. Your conversation is safe. Try opening it as a page.
      </p>
    );
  }
}

const guard = (app: AppId, el: ReactNode) => <RequireApp app={app}>{el}</RequireApp>;

/** Anything that isn't a view, such as a new task, belongs to the main router. */
function Leave({ to }: { to: (path: string) => void }) {
  const { pathname, search } = useLocation();
  useEffect(() => to(`${pathname}${search}`), [to, pathname, search]);
  return null;
}

function Inside({ label, threadId, leave }: { label: string; threadId?: string; leave: (path: string) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const here = `${location.pathname}${location.search}`;
  const { setPrefill, moveContext, removeContext } = useUi.getState();

  // A record open here is what "this" means in the conversation beside it (FE-EXP-051). Views add
  // their chip to the new-task composer, so it moves across, and leaves with the record.
  const pending = useUi((s) => s.contexts.new);
  const moved = useRef<ContextRef[]>([]);
  useEffect(() => {
    if (!threadId || !pending?.length) return;
    moved.current.push(...pending);
    moveContext('new', threadId);
  }, [pending, threadId, moveContext]);
  useEffect(
    () => () => {
      if (threadId) for (const chip of moved.current.splice(0)) removeContext(threadId, chip);
    },
    [here, threadId, removeContext],
  );

  return (
    <div className={styles.frame}>
      <div className={styles.tools}>
        {location.key !== 'default' && <IconButton label="Back" icon={<ArrowLeft size={16} aria-hidden />} onClick={() => void navigate(-1)} />}
        <span className={styles.gap} />
        {threadId && (
          <Button size="sm" variant="ghost" icon={<MessageSquarePlus size={14} aria-hidden />} onClick={() => setPrefill(`About ${label}: `)}>
            Ask about this
          </Button>
        )}
        <IconButton label="Open as a page" icon={<ExternalLink size={16} aria-hidden />} onClick={() => leave(here)} />
      </div>
      <div className={styles.view}>
        <PaneBoundary route={here}>
          <Suspense fallback={<Skeleton height="320px" radius="md" />}>
            <Routes>
              <Route path="/tables" element={guard('tables', <TablesPage />)} />
              <Route path="/tables/:tableId" element={guard('tables', <TablePage />)} />
              <Route path="/reports" element={guard('reports', <ReportsPage />)} />
              <Route path="/reports/:templateId" element={guard('reports', <ReportPage />)} />
              <Route path="/workflows/referrals/*" element={guard('referrals', <ReferralsPage />)} />
              <Route path="/workflows/builder/*" element={guard('wfbuilder', <AppViewPage app="wfbuilder" />)} />
              <Route path="/workflows/*" element={guard('workflows', <AppViewPage app="workflows" />)} />
              <Route path="/calendar/*" element={guard('calendar', <CalendarPage />)} />
              <Route path="/files/*" element={guard('files', <FilesPage />)} />
              <Route path="/datalogs/*" element={guard('datalogs', <AppViewPage app="datalogs" />)} />
              <Route path="/queries/*" element={guard('queries', <QueriesPage />)} />
              <Route path="/tasks/*" element={guard('tasks', <AppViewPage app="tasks" />)} />
              <Route path="/dq/*" element={guard('dq', <AppViewPage app="dq" />)} />
              <Route path="/integrations/mappings" element={guard('integrations', <AppViewPage app="coremap" />)} />
              <Route path="/integrations/*" element={guard('integrations', <AppViewPage app="integrations" />)} />
              <Route path="/admin/classes/*" element={guard('classes', <AppViewPage app="classes" />)} />
              <Route path="/admin/users/*" element={guard('users', <AppViewPage app="users" />)} />
              <Route path="/admin/*" element={guard('admin', <AppViewPage app="admin" />)} />
              <Route path="/members" element={guard('rm', <MembersPage />)} />
              <Route path="/customers" element={guard('rm', <MembersPage />)} />
              <Route path="/members/:ref" element={guard('rm', <MemberPage />)} />
              <Route path="/customers/:ref" element={guard('rm', <MemberPage />)} />
              <Route path="/m/lap/*" element={guard('lap', <PipelinePage />)} />
              <Route path="/m/gi/*" element={guard('gi', <GoalsPage />)} />
              <Route path="/m/campaigns/*" element={guard('campaigns', <AppViewPage app="campaigns" />)} />
              <Route path="/m/onboarding/*" element={guard('onboarding', <AppViewPage app="onboarding" />)} />
              <Route path="/m/compliance/*" element={guard('compliance', <AppViewPage app="compliance" />)} />
              <Route path="/m/predictive/*" element={guard('predictive', <AppViewPage app="predictive" />)} />
              <Route path="/m/indirect/*" element={guard('indirect', <AppViewPage app="indirect" />)} />
              <Route path="/m/prospecting/*" element={guard('prospecting', <AppViewPage app="prospecting" />)} />
              <Route path="/m/seg/*" element={guard('seg', <AppViewPage app="seg" />)} />
              <Route path="/m/callreport/*" element={guard('callreport', <AppViewPage app="callreport" />)} />
              <Route path="/m/irr/*" element={guard('irr', <AppViewPage app="irr" />)} />
              <Route path="/m/delinquency/*" element={guard('delinquency', <AppViewPage app="delinquency" />)} />
              <Route path="/m/liquidity/*" element={guard('liquidity', <AppViewPage app="liquidity" />)} />
              <Route path="/m/membership/*" element={guard('membership', <AppViewPage app="membership" />)} />
              <Route path="/m/cfo/*" element={guard('cfo', <AppViewPage app="cfo" />)} />
              <Route path="/m/gl/*" element={guard('gl', <AppViewPage app="gl" />)} />
              <Route path="*" element={<Leave to={leave} />} />
            </Routes>
          </Suspense>
        </PaneBoundary>
      </div>
    </div>
  );
}

export function PagePane({ path, label, threadId }: { path: string; label: string; threadId?: string }) {
  const outer = useNavigate();
  const leave = useMemo(
    () => (to: string) => {
      useUi.getState().closeWorkspace();
      void outer(to);
    },
    [outer],
  );
  return (
    <UNSAFE_RouteContext.Provider value={NO_ROUTE}>
      <UNSAFE_LocationContext.Provider value={null as never}>
        <MemoryRouter key={path} initialEntries={[path]}>
          <Inside label={label} threadId={threadId} leave={leave} />
        </MemoryRouter>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_RouteContext.Provider>
  );
}
