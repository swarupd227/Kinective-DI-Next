// All dashboards: today's DI home grid, kept as a page for people who like to browse. Home shows the
// few that matter today; this lists every table, form and report this person can open.
import { HomeLauncher } from './HomeLauncher.tsx';
import page from './Page.module.css';

export function DashboardsPage() {
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>Browse</h1>
        <p className={page.lede}>Every table, form and report you can open. Press Ctrl K to find one by name, or ask DI to open it for you.</p>
      </header>
      <HomeLauncher />
    </div>
  );
}
