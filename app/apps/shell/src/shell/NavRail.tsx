// Navigation rail (spec 6.2, FE-EXP-003): only apps the user's class permits and the tenant has
// licensed. Collapses to icons with tooltips; on phones it becomes a menu drawer.
import { NavLink } from 'react-router';
import clsx from 'clsx';
import { Tooltip } from '@dinext/ui';
import type { AppId } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from './apps.tsx';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './NavRail.module.css';

const GROUPS: { id: 'core' | 'modules' | 'admin'; label: string }[] = [
  { id: 'core', label: 'Apps' },
  { id: 'modules', label: 'Solutions' },
  { id: 'admin', label: 'Administration' },
];

export function NavRail() {
  const { session } = useSession();
  const bp = useBreakpoint();
  const { navExpanded, mobileNavOpen, setMobileNav } = useUi();
  const phone = bp === 'phone';
  // Laptop and tablet widths keep the rail as icons (spec 10.10).
  const expanded = phone || (navExpanded && bp === 'desktop');
  if (phone && !mobileNavOpen) return null;

  // Banks never see credit-union-only modules, even if a licence record lists them (FE-EXP-003).
  const bank = session.tenant.institutionType === 'bank';
  const apps = session.apps.filter((a): a is AppId => a in APP_META && !(bank && (a === 'seg' || a === 'callreport')));
  return (
    <>
      {phone && <button type="button" className={styles.scrim} aria-label="Close menu" onClick={() => setMobileNav(false)} />}
      <nav className={clsx(styles.rail, expanded && styles.expanded, phone && styles.drawer)} aria-label="Apps" data-region="nav" tabIndex={-1}>
        {GROUPS.map((g) => {
          const items = apps.filter((a) => APP_META[a]!.group === g.id);
          if (!items.length) return null;
          return (
            <div key={g.id} className={styles.group}>
              {expanded ? <p className={styles.groupLabel}>{g.label}</p> : <span className={styles.sep} aria-hidden />}
              <ul>
                {items.map((a) => {
                  const meta = APP_META[a]!;
                  const link = (
                    // A plain className: Tooltip's Slot would stringify NavLink's function form. NavLink sets
                    // aria-current="page" on the active app, which the CSS styles.
                    <NavLink to={meta.path} className={styles.item} aria-label={expanded ? undefined : meta.label} end={a === 'home'}>
                      <span className={styles.icon}>{meta.icon}</span>
                      {expanded && <span className={styles.label}>{meta.label}</span>}
                    </NavLink>
                  );
                  return (
                    <li key={a}>
                      {expanded ? (
                        link
                      ) : (
                        <Tooltip content={meta.label} side="right">
                          {link}
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </>
  );
}
