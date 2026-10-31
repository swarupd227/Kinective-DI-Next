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
const NotFound = lazy(() => import('./pages/NotFound.tsx').then((m) => ({ default: m.NotFound })));
const MemberPage = lazy(() => import('./pages/MemberPage.tsx').then((m) => ({ default: m.MemberPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage.tsx').then((m) => ({ default: m.ReportsPage })));
const ReferralsPage = lazy(() => import('./pages/ReferralsPage.tsx').then((m) => ({ default: m.ReferralsPage })));
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
          { path: 'workflows/referrals/*', element: guarded('referrals', <ReferralsPage />) },
          { path: 'workflows/*', element: guarded('workflows', <AppPlaceholder app="workflows" />) },
          { path: 'calendar/*', element: guarded('calendar', <AppPlaceholder app="calendar" />) },
          { path: 'files/*', element: guarded('files', <AppPlaceholder app="files" />) },
          { path: 'datalogs/*', element: guarded('datalogs', <AppPlaceholder app="datalogs" />) },
          { path: 'queries/*', element: guarded('queries', <AppPlaceholder app="queries" />) },
          { path: 'admin/users/*', element: guarded('users', <AppPlaceholder app="users" />) },
          { path: 'admin/*', element: guarded('admin', <AppPlaceholder app="admin" />) },
          { path: 'members', element: guarded('rm', <AppPlaceholder app="rm" />) },
          { path: 'customers', element: guarded('rm', <AppPlaceholder app="rm" />) },
          { path: 'members/:ref', element: guarded('rm', <MemberPage />) },
          { path: 'customers/:ref', element: guarded('rm', <MemberPage />) },
          { path: 'm/:module/*', element: page(<AppPlaceholder app="module" />) },
          { path: '*', element: page(<NotFound />) },
        ],
      },
    ],
  },
]);
