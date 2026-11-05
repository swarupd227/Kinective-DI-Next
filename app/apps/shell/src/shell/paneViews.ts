// Which views can open beside a conversation, so a task keeps its place while the person checks one.
// A conversation, Home and anything outside the app still navigate as a page.
import type { AppId } from '@dinext/block-schemas';

const BESIDE = /^\/(m\/|reports\b|tables\b|workflows\b|calendar\b|files\b|datalogs\b|queries\b|members\b|customers\b|admin\b|tasks\b|dq\b|integrations\b)/;

export const opensBeside = (path: string) => BESIDE.test(path);

/** The app's own name for a view: the longest app path that the link sits under. */
export function viewLabel(path: string, apps: { label: string; path: string }[]) {
  const route = path.split(/[?#]/)[0]!;
  const match = apps.filter((a) => route === a.path || route.startsWith(`${a.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return match?.label ?? 'View';
}

/** The app whose page shows a warehouse table's data, so a source chip opens the view people work
 *  in rather than raw rows. Tables no app owns stay with the table viewer. */
const OWNERS: [RegExp, AppId][] = [
  [/^mod_gi_/, 'gi'],
  [/^(mod_lap_|cdm_loan_application)/, 'lap'],
  [/^esp_com_/, 'referrals'],
  [/^cdm_party/, 'rm'],
  [/^onb_/, 'onboarding'],
  [/^cpm_/, 'compliance'],
  [/^cmp_/, 'campaigns'],
  [/^prs_/, 'prospecting'],
  [/^ind_/, 'indirect'],
  [/^seg_/, 'seg'],
  [/^cr_/, 'callreport'],
  [/^irr_/, 'irr'],
  [/^tsk_/, 'tasks'],
  [/^wf_/, 'workflows'],
  [/^esp_files/, 'files'],
  [/^esp_datalog/, 'datalogs'],
  [/^ops_dq_/, 'dq'],
];

export const sourceApp = (tableId: string) => OWNERS.find(([owns]) => owns.test(tableId))?.[1];
