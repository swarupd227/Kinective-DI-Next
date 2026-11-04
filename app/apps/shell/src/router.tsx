// Every view, thread and block has a URL (spec 11.4, FE-ARCH-010). Opening a URL never grants
// access: each route checks the session's apps, and the server enforces again.
// Routes other than Home load on demand to keep the initial bundle within budget (spec 11.1, 11.10).
import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { Root } from './Root.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { RequireApp } from './session/RequireApp.tsx';
import type { AppId } from '@dinext/block-schemas';

const ThreadPage = lazy(() => import('./pages/ThreadPage.tsx').then((m) => ({ default: m.ThreadPage })));
const NewThreadPage = lazy(() => import('./pages/NewThreadPage.tsx').then((m) => ({ default: m.NewThreadPage })));
const ConversationsPage = lazy(() => import('./pages/ConversationsPage.tsx').then((m) => ({ default: m.ConversationsPage })));
const TablesPage = lazy(() => import('./pages/TablesPage.tsx').then((m) => ({ default: m.TablesPage })));
const TablePage = lazy(() => import('./pages/TablesPage.tsx').then((m) => ({ default: m.TablePage })));
const AppPlaceholder = lazy(() => import('./pages/AppPlaceholder.tsx').then((m) => ({ default: m.AppPlaceholder })));
const AppViewPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.AppViewPage })));
const CalendarPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.CalendarPage })));
const FilesPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.FilesPage })));
const QueriesPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.QueriesPage })));
const EmailsPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.EmailsPage })));
const MembersPage = lazy(() => import('./pages/AppViewPage.tsx').then((m) => ({ default: m.MembersPage })));
const NotFound = lazy(() => import('./pages/NotFound.tsx').then((m) => ({ default: m.NotFound })));
const MemberPage = lazy(() => import('./pages/MemberPage.tsx').then((m) => ({ default: m.MemberPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage.tsx').then((m) => ({ default: m.ReportsPage })));
const ReferralsPage = lazy(() => import('./pages/ReferralsPage.tsx').then((m) => ({ default: m.ReferralsPage })));
const GoalsPage = lazy(() => import('./pages/GoalsPage.tsx').then((m) => ({ default: m.GoalsPage })));
const PipelinePage = lazy(() => import('./pages/PipelinePage.tsx').then((m) => ({ default: m.PipelinePage })));
const ReportPage = lazy(() => import('./pages/ReportsPage.tsx').then((m) => ({ default: m.ReportPage })));

const page = (el: ReactNode) => <Suspense fallback={null}>{el}</Suspense>;
const guarded = (app: AppId, el: ReactNode) => page(<RequireApp app={app}>{el}</RequireApp>);

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/home" replace /> },
          { path: 'home', element: <HomePage /> },
          { path: 'home/:tabId', element: <HomePage /> },
          { path: 'c', element: page(<ConversationsPage />) },
          { path: 'c/new', element: page(<NewThreadPage />) },
          { path: 'c/:threadId', element: page(<ThreadPage />) },
          { path: 'c/:threadId/b/:blockId', element: page(<ThreadPage />) },
          { path: 'tables', element: guarded('tables', <TablesPage />) },
          { path: 'tables/:tableId', element: guarded('tables', <TablePage />) },
          { path: 'reports', element: guarded('reports', <ReportsPage />) },
          { path: 'reports/:templateId', element: guarded('reports', <ReportPage />) },
          { path: 'reports/*', element: guarded('reports', <ReportsPage />) },
          { path: 'workflows/builder/*', element: guarded('wfbuilder', <AppViewPage app="wfbuilder" />) },
          { path: 'workflows/referrals/*', element: guarded('referrals', <ReferralsPage />) },
          { path: 'workflows/*', element: guarded('workflows', <AppViewPage app="workflows" />) },
          { path: 'tasks/*', element: guarded('tasks', <AppViewPage app="tasks" />) },
          { path: 'calendar/*', element: guarded('calendar', <CalendarPage />) },
          { path: 'files/*', element: guarded('files', <FilesPage />) },
          { path: 'datalogs/*', element: guarded('datalogs', <AppViewPage app="datalogs" />) },
          { path: 'queries/*', element: guarded('queries', <QueriesPage />) },
          { path: 'admin/classes/*', element: guarded('classes', <AppViewPage app="classes" />) },
          { path: 'integrations/*', element: guarded('integrations', <AppViewPage app="integrations" />) },
          { path: 'admin/users/*', element: guarded('users', <AppViewPage app="users" />) },
          { path: 'admin/*', element: guarded('admin', <AppViewPage app="admin" />) },
          // Everyone has email notifications: the person's own outbox and preferences.
          { path: 'settings/email', element: page(<EmailsPage />) },
          { path: 'members', element: guarded('rm', <MembersPage />) },
          { path: 'customers', element: guarded('rm', <MembersPage />) },
          { path: 'members/:ref', element: guarded('rm', <MemberPage />) },
          { path: 'customers/:ref', element: guarded('rm', <MemberPage />) },
          { path: 'm/lap/*', element: guarded('lap', <PipelinePage />) },
          { path: 'm/gi/*', element: guarded('gi', <GoalsPage />) },
          { path: 'm/campaigns/*', element: guarded('campaigns', <AppViewPage app="campaigns" />) },
          { path: 'm/onboarding/*', element: guarded('onboarding', <AppViewPage app="onboarding" />) },
          { path: 'm/compliance/*', element: guarded('compliance', <AppViewPage app="compliance" />) },
          { path: 'm/predictive/*', element: guarded('predictive', <AppViewPage app="predictive" />) },
          { path: 'dq/*', element: guarded('dq', <AppViewPage app="dq" />) },
          { path: 'm/indirect/*', element: guarded('indirect', <AppViewPage app="indirect" />) },
          { path: 'm/prospecting/*', element: guarded('prospecting', <AppViewPage app="prospecting" />) },
          { path: 'm/seg/*', element: guarded('seg', <AppViewPage app="seg" />) },
          { path: 'm/callreport/*', element: guarded('callreport', <AppViewPage app="callreport" />) },
          { path: 'm/:module/*', element: page(<AppPlaceholder app="module" />) },
          { path: '*', element: page(<NotFound />) },
        ],
      },
    ],
  },
]);
