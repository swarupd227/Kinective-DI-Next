import type { ReactNode } from 'react';
import {
  Calendar,
  ClipboardList,
  Database,
  FileBarChart,
  FolderOpen,
  Home,
  Landmark,
  MessagesSquare,
  Network,
  Settings,
  Share2,
  SquareTerminal,
  Table2,
  Target,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import type { AppId } from '@dinext/block-schemas';

export interface AppMeta {
  label: string;
  icon: ReactNode;
  path: string;
  group: 'core' | 'modules' | 'admin';
  /** Phase the classic view is scheduled for (spec 33.2), shown on placeholder screens. */
  phase?: string;
}

const i = (Icon: typeof Home) => <Icon size={18} aria-hidden />;

export const APP_META: Record<string, AppMeta> = {
  home: { label: 'Home', icon: i(Home), path: '/home', group: 'core' },
  conversations: { label: 'Conversations', icon: i(MessagesSquare), path: '/c', group: 'core' },
  reports: { label: 'Reports', icon: i(FileBarChart), path: '/reports', group: 'core', phase: 'Phase 1, report builder slice' },
  tables: { label: 'Tables', icon: i(Table2), path: '/tables', group: 'core' },
  workflows: { label: 'Workflows', icon: i(Workflow), path: '/workflows', group: 'core', phase: 'Phase 1, referrals slice' },
  calendar: { label: 'Calendar', icon: i(Calendar), path: '/calendar', group: 'core', phase: 'Phase 2' },
  files: { label: 'Files', icon: i(FolderOpen), path: '/files', group: 'core', phase: 'Phase 2' },
  datalogs: { label: 'Data Logs', icon: i(ClipboardList), path: '/datalogs', group: 'core', phase: 'Phase 2' },
  queries: { label: 'Queries', icon: i(SquareTerminal), path: '/queries', group: 'core', phase: 'Phase 3' },
  rm: { label: 'Relationship Manager', icon: i(UserRound), path: '/members', group: 'modules', phase: 'Phase 1, member 360 slice' },
  referrals: { label: 'Referrals', icon: i(Share2), path: '/workflows/referrals/inbox', group: 'modules', phase: 'Phase 1, referrals slice' },
  lap: { label: 'Loan Pipeline', icon: i(Landmark), path: '/m/lap', group: 'modules', phase: 'Phase 1, lending slice' },
  gi: { label: 'Goals & Incentives', icon: i(Target), path: '/m/gi', group: 'modules', phase: 'Phase 2' },
  seg: { label: 'SEG Management', icon: i(Network), path: '/m/seg', group: 'modules', phase: 'Phase 3' },
  callreport: { label: '5300 Call Report', icon: i(Database), path: '/m/callreport', group: 'modules', phase: 'Phase 3' },
  users: { label: 'Users', icon: i(Users), path: '/admin/users', group: 'admin', phase: 'Phase 3' },
  admin: { label: 'Admin', icon: i(Settings), path: '/admin', group: 'admin', phase: 'Phase 3' },
};

export const appFor = (id: AppId) => APP_META[id]!;
