import type { ReactNode } from 'react';
import {
  Brain,
  BriefcaseBusiness,
  Calendar,
  Car,
  HeartPulse,
  ListChecks,
  Plug,
  Settings2,
  ShieldUser,
  Megaphone,
  ShieldCheck,
  UserPlus,
  ClipboardList,
  Database,
  Gauge,
  TrendingDown,
  Droplets,
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
  conversations: { label: 'All tasks', icon: i(MessagesSquare), path: '/c', group: 'core' },
  reports: { label: 'Reports', icon: i(FileBarChart), path: '/reports', group: 'core', phase: 'Phase 1, report builder slice' },
  tables: { label: 'Tables', icon: i(Table2), path: '/tables', group: 'core' },
  workflows: { label: 'Workflows', icon: i(Workflow), path: '/workflows', group: 'core', phase: 'Phase 1, referrals slice' },
  tasks: { label: 'Tasks', icon: i(ListChecks), path: '/tasks', group: 'core' },
  calendar: { label: 'Calendar', icon: i(Calendar), path: '/calendar', group: 'core', phase: 'Phase 2' },
  files: { label: 'Files', icon: i(FolderOpen), path: '/files', group: 'core', phase: 'Phase 2' },
  datalogs: { label: 'Data Logs', icon: i(ClipboardList), path: '/datalogs', group: 'core', phase: 'Phase 2' },
  dq: { label: 'Data Quality', icon: i(HeartPulse), path: '/dq', group: 'core' },
  queries: { label: 'Queries', icon: i(SquareTerminal), path: '/queries', group: 'core', phase: 'Phase 3' },
  rm: { label: 'Relationship Manager', icon: i(UserRound), path: '/members', group: 'modules', phase: 'Phase 1, member 360 slice' },
  referrals: { label: 'Referrals', icon: i(Share2), path: '/workflows/referrals/inbox', group: 'modules', phase: 'Phase 1, referrals slice' },
  lap: { label: 'Loan Pipeline', icon: i(Landmark), path: '/m/lap', group: 'modules', phase: 'Phase 1, lending slice' },
  gi: { label: 'Goals & Incentives', icon: i(Target), path: '/m/gi', group: 'modules', phase: 'Phase 2' },
  indirect: { label: 'Indirect Lending', icon: i(Car), path: '/m/indirect', group: 'modules' },
  prospecting: { label: 'Prospecting', icon: i(BriefcaseBusiness), path: '/m/prospecting', group: 'modules' },
  campaigns: { label: 'Campaign Success', icon: i(Megaphone), path: '/m/campaigns', group: 'modules' },
  onboarding: { label: 'Onboarding Manager', icon: i(UserPlus), path: '/m/onboarding', group: 'modules' },
  compliance: { label: 'Compliance', icon: i(ShieldCheck), path: '/m/compliance', group: 'modules' },
  predictive: { label: 'Predictive Analytics', icon: i(Brain), path: '/m/predictive', group: 'modules' },
  seg: { label: 'SEG Management', icon: i(Network), path: '/m/seg', group: 'modules', phase: 'Phase 3' },
  callreport: { label: '5300 Call Report', icon: i(Database), path: '/m/callreport', group: 'modules', phase: 'Phase 3' },
  irr: { label: 'Interest Rate Risk', icon: i(Gauge), path: '/m/irr', group: 'modules' },
  delinquency: { label: 'Delinquency', icon: i(TrendingDown), path: '/m/delinquency', group: 'modules' },
  liquidity: { label: 'Liquidity', icon: i(Droplets), path: '/m/liquidity', group: 'modules' },
  wfbuilder: { label: 'Workflow Builder', icon: i(Settings2), path: '/workflows/builder', group: 'admin' },
  integrations: { label: 'Integrations', icon: i(Plug), path: '/integrations', group: 'admin' },
  classes: { label: 'Classes', icon: i(ShieldUser), path: '/admin/classes', group: 'admin' },
  users: { label: 'Users', icon: i(Users), path: '/admin/users', group: 'admin', phase: 'Phase 3' },
  admin: { label: 'Admin', icon: i(Settings), path: '/admin', group: 'admin', phase: 'Phase 3' },
};

export const appFor = (id: AppId) => APP_META[id]!;
