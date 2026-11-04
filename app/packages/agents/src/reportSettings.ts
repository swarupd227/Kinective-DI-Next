// Report settings (today's DI Build Reports form: Basics, Configuration, Report Controls, Period and
// Hierarchy Info, Test/Preview Settings). The page shows them read-only; changes are asked of DI. On a
// draft a change is an ordinary draft save; on a saved report it waits on an approval card that shows
// each setting before and after. Code writes every label and value here.
import type { AppTile, ReportSettingsView } from '@dinext/block-schemas';
import type { SettingsChangeRow, SettingsFields, TemplateRow } from '@dinext/di-core';
import type { ReportDefinition } from '@dinext/tenant-db';

/** The tool's input, as the model and the offline planner give it. */
export interface SettingsInput {
  template_id?: string;
  name?: string;
  description?: string;
  period_type?: 'month' | 'quarter';
  use_period?: 'current' | 'previous';
  branch_control?: boolean;
  history_controls?: boolean;
  /** User class names, or ["everyone"] for anyone with Reports. */
  who_can_open?: string[];
  enabled?: boolean;
  show_queries?: boolean;
}

const KEYS: (keyof SettingsFields)[] = ['name', 'description', 'periodType', 'usePeriod', 'addHierarchyControls', 'addHistoryControls', 'controlClasses', 'enabled', 'showQueries'];

const LABEL: Record<keyof SettingsFields, string> = {
  name: 'Name',
  description: 'Description',
  periodType: 'Period type',
  usePeriod: 'Default period',
  addHierarchyControls: 'Branch control',
  addHistoryControls: 'History controls',
  controlClasses: 'Who can open it',
  enabled: 'Enabled',
  showQueries: 'Show queries',
};

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const onOff = (b: boolean) => (b ? 'On' : 'Off');

/** Who can open a report, in words. */
export const whoCanOpen = (classes: string[]) => (classes.length ? `${classes.join(', ')} ${classes.length === 1 ? 'class' : 'classes'}, and you` : 'Everyone with Reports');

function valueText(key: keyof SettingsFields, v: unknown, def: ReportDefinition): string {
  const period = def.settings.periodType === 'quarter' ? 'quarter' : 'month';
  switch (key) {
    case 'periodType':
      return v === 'quarter' ? 'Quarterly' : 'Monthly';
    case 'usePeriod':
      return v === 'previous' ? `The ${period} before the latest` : `The latest complete ${period}`;
    case 'addHierarchyControls':
    case 'addHistoryControls':
      return onOff(Boolean(v));
    case 'controlClasses':
      return whoCanOpen((v as string[]) ?? []);
    case 'enabled':
      return v ? 'Yes' : 'No, turned off';
    case 'showQueries':
      return v ? 'Yes, to Query Browser users' : 'No';
    default:
      return String(v ?? '') || '—';
  }
}

/** Matches class words ("Managers", "the executive class") to user classes; "everyone" clears the list. */
export function classesNamed(names: string[], classes: string[]): { classes: string[]; unknown: string[] } {
  const found: string[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase().replace(/^the /, '').replace(/ (class|classes|team|users?|group)$/, '');
    if (!n) continue;
    if (/^(everyone|anyone|all|all users|everybody)$/.test(n)) return { classes: [], unknown: [] };
    const hit = classes.find((c) => [c.toLowerCase(), `${c.toLowerCase()}s`].includes(n) || (c === 'Administrator' && /^admins?$/.test(n)));
    if (hit) {
      if (!found.includes(hit)) found.push(hit);
    } else unknown.push(raw.trim());
  }
  return { classes: found, unknown };
}

/** The input as settings fields: only what the user asked to change. */
export function fieldsFrom(a: SettingsInput, classes: string[]): { fields: SettingsFields; unknown: string[] } {
  const fields: SettingsFields = {};
  if (a.name !== undefined) fields.name = a.name.trim();
  if (a.description !== undefined) fields.description = a.description.trim();
  if (a.period_type) fields.periodType = a.period_type;
  if (a.use_period) fields.usePeriod = a.use_period;
  if (a.branch_control !== undefined) fields.addHierarchyControls = a.branch_control;
  if (a.history_controls !== undefined) fields.addHistoryControls = a.history_controls;
  if (a.enabled !== undefined) fields.enabled = a.enabled;
  if (a.show_queries !== undefined) fields.showQueries = a.show_queries;
  let unknown: string[] = [];
  if (a.who_can_open) {
    const r = classesNamed(a.who_can_open, classes);
    fields.controlClasses = r.classes;
    unknown = r.unknown;
  }
  return { fields, unknown };
}

const current = (def: ReportDefinition, key: keyof SettingsFields): unknown => (key === 'name' ? def.name : key === 'description' ? def.description : def.settings[key as keyof ReportDefinition['settings']]);

const same = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

/** What changes: each field as it is and as it would be. Fields already set that way drop out. */
export function settingsDiff(def: ReportDefinition, want: SettingsFields) {
  const before: SettingsFields = {};
  const after: SettingsFields = {};
  const changes: { label: string; before: string; after: string }[] = [];
  for (const key of KEYS) {
    if (want[key] === undefined) continue;
    const was = current(def, key);
    if (same(was, want[key])) continue;
    (before as Record<string, unknown>)[key] = was;
    (after as Record<string, unknown>)[key] = want[key];
    // "Default period" reads in the period type the report will have.
    const shown = { ...def, settings: { ...def.settings, periodType: want.periodType ?? def.settings.periodType } };
    changes.push({ label: LABEL[key], before: valueText(key, was, def), after: valueText(key, want[key], shown).slice(0, 400) });
  }
  return { before, after, changes };
}

/** The definition with the fields applied; a draft saves this as it is. */
export function applySettings(def: ReportDefinition, f: SettingsFields): ReportDefinition {
  const { name, description, ...settings } = f;
  return { ...def, name: name ?? def.name, description: description ?? def.description, settings: { ...def.settings, ...settings }, layoutVersion: def.layoutVersion + 1 };
}

/** "Made it quarterly", "turned off the branch control": one line per change, for the chat. */
export function settingsDone(changes: { label: string; after: string }[]) {
  return changes.map((c) => `${c.label}: ${c.after}`).join('; ');
}

// ---- the Settings view ---------------------------------------------------------------------------

const NIGHTLY = 'Not used: DI runs every report on the nightly build.';

export function settingsView(t: TemplateRow, who: { userId: string; canViewSql: boolean }, extra: { pins: number; schedules: number; lastChange: SettingsChangeRow | null }): ReportSettingsView {
  const d = t.definition;
  const s = d.settings;
  const status = t.status === 'draft' ? 'draft' : t.status === 'stock' ? 'stock' : 'published';
  const mine = t.ownerUserId === who.userId;
  const canChange = status === 'draft' || (status === 'published' && mine);
  const changeNote =
    status === 'stock'
      ? 'This is a stock report every user starts with, so its settings can’t be changed. Ask DI to make a copy, then change the copy.'
      : status === 'draft'
        ? 'This is your private draft: ask DI to change a setting and it changes at once. Saving it is approved on a card.'
        : mine
          ? 'Ask DI to change a setting. Each change shows on a card, before and after, and happens only when you approve it.'
          : `This report belongs to ${t.ownerName}. Only they can change its settings.`;
  const period = s.periodType === 'quarter' ? 'quarter' : 'month';
  const restricted = status === 'published' && s.controlClasses.length > 0;
  const field = (label: string, value: string, used = true) => ({ label, value, used });
  const tiles: AppTile[] = [
    { label: 'Period', value: s.periodType === 'quarter' ? 'Quarterly' : 'Monthly', detail: s.usePeriod === 'previous' ? `Opens on the ${period} before the latest` : `Opens on the latest complete ${period}` },
    { label: 'Who can open it', value: status === 'draft' ? 'Only you' : restricted ? `${s.controlClasses.length} ${s.controlClasses.length === 1 ? 'class' : 'classes'}` : 'Everyone', detail: status === 'draft' ? 'Private until saved' : restricted ? s.controlClasses.join(', ') : 'With Reports access' },
    { label: 'Status', value: s.enabled === false ? 'Turned off' : 'On', detail: s.enabled === false ? 'Doesn’t run; others can’t see it' : status === 'stock' ? 'Stock report' : status === 'draft' ? 'Draft' : 'Saved report', tone: s.enabled === false ? 'warning' : 'neutral' },
    { label: 'Home and schedules', value: `${extra.pins} · ${extra.schedules}`, detail: `${extra.pins === 1 ? '1 Home pin' : `${extra.pins} Home pins`}, ${extra.schedules === 1 ? '1 schedule' : `${extra.schedules} schedules`}` },
  ];
  const classes = status === 'stock' ? `${s.controlClasses.join(', ') || '—'} (kept from DI for reference: every Report Viewer can open stock reports)` : status === 'draft' ? 'Only you, until it’s saved' : whoCanOpen(s.controlClasses);
  const controls = ['period', ...(s.addHierarchyControls ? ['node'] : [])];
  return {
    templateId: t.templateId,
    name: d.name,
    status,
    owner: t.ownerName,
    canChange,
    changeNote,
    tiles,
    groups: [
      { id: 'basics', title: 'Basics', fields: [field('Report ID', t.templateId), field('Name', d.name), field('Description', d.description || '—')] },
      {
        id: 'configuration',
        title: 'Configuration',
        fields: [field('App', 'Reports'), field('Folder', t.status === 'draft' ? 'Drafts (private)' : t.folder), field('Control user classes', classes), field('Enabled?', s.enabled === false ? 'No: it doesn’t run, and only you can see it' : 'Yes'), field('CSS stylesheet?', 'Not used: every report uses the Kinective theme.', false)],
      },
      {
        id: 'controls',
        title: 'Report controls',
        fields: [
          field('Allow real-time controls', NIGHTLY, false),
          field('Control IDs', controls.join(', ')),
          field('Control defaults', `Period: ${s.usePeriod === 'previous' ? `the ${period} before the latest` : `the latest complete ${period}`}${s.addHierarchyControls ? '. Branch: your own branch, or all branches if you see them all' : ''}`),
          field('Drilldown tables', 'Not built: ask DI a follow-up question about a figure instead.', false),
        ],
      },
      {
        id: 'period',
        title: 'Period and hierarchy info',
        fields: [
          field('Choose hierarchy ID', s.addHierarchyControls ? 'Branch' : 'None: the report shows all branches in your access'),
          field('Period type', s.periodType === 'quarter' ? 'Quarterly' : 'Monthly'),
          field('Hierarchy ID', s.addHierarchyControls ? 'branch' : '—'),
          field('Report ID', t.templateId),
          field('Add history controls', `${yesNo(s.addHistoryControls)}. Trend sections show the history; there is no separate history picker.`),
          field('Custom period?', 'Not used: reports run for complete months or quarters from the nightly build.', false),
          field('Add start/end date controls', 'Not used: reports run for complete months or quarters from the nightly build.', false),
          field('Use period', s.usePeriod === 'previous' ? 'Previous' : 'Current'),
          field('Add hierarchy controls', yesNo(s.addHierarchyControls)),
        ],
      },
      {
        id: 'test',
        title: 'Test and preview settings',
        fields: [
          field('Test template?', 'Not used: a draft is the test copy. It’s private until you save it.', false),
          field('Test period type', 'Not used: a draft runs with the same period controls as the report.', false),
          field('Preview PDF', 'Not built: export to Excel or CSV instead.', false),
          field('Download PDF', 'Not built: export to Excel or CSV instead.', false),
          field('Show queries', `${yesNo(s.showQueries)}${s.showQueries ? (who.canViewSql ? ': shown under the report, to Query Browser users' : ': only Query Browser users see them, so you don’t') : ''}`),
          field('Test data cache?', NIGHTLY, false),
          field('Test start/end date', 'Not used: reports run for complete months or quarters from the nightly build.', false),
        ],
      },
    ],
    prompts: canChange
      ? [`Make it ${s.periodType === 'quarter' ? 'monthly' : 'quarterly'}`, s.usePeriod === 'previous' ? 'Use the current period by default' : 'Use the previous period by default', s.addHierarchyControls ? 'Turn off the branch control' : 'Turn on the branch control', ...(status === 'published' ? ['Only Managers and Executives can run it', s.enabled === false ? 'Enable this report' : 'Disable this report'] : []), ...(who.canViewSql ? [s.showQueries ? 'Hide the queries' : 'Show the queries'] : [])]
      : status === 'stock'
        ? [`Make a copy of the ${d.name}`]
        : [],
    ...(extra.lastChange ? { lastChange: `Last changed by ${extra.lastChange.userName} on ${new Date(extra.lastChange.createdAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` } : {}),
  };
}

// ---- reading settings requests (offline planner) ---------------------------------------------------

export type SettingsAsk = { intent: 'settings_show'; target: string } | { intent: 'copy'; target: string; name?: string } | { intent: 'settings'; target: string; set: Omit<SettingsInput, 'template_id'> };

const strip = (s: string) => s.trim().replace(/^["“'‘]|["”'’]$/g, '').trim();

/** Reads a settings request. `target` names the report, or is empty for the one on screen. */
export function parseSettingsRequest(text: string): SettingsAsk | null {
  const t = text.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
  const lower = t.toLowerCase();
  const tgt = (s: string | undefined) => {
    const x = (s ?? '').trim().replace(/^(the|this|my) /, '').replace(/\breport$/, '').trim();
    return /^(it|this|that|report|)$/.test(x) ? '' : x;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(?:show|open|what are)(?: me)? (?:the )?(?:report )?settings(?: (?:for|of|on) (.+))?$/.exec(lower))) return { intent: 'settings_show', target: tgt(m[1]) };
  if ((m = /^what are (?:the )?(.+?)(?:'s)? settings$/.exec(lower))) return { intent: 'settings_show', target: tgt(m[1]) };
  if ((m = /^(?:make|create) (?:me )?a copy of (.+?)(?: (?:called|named) (.+))?$/i.exec(t)) || (m = /^copy (.+?)(?: as (.+))?$/i.exec(t))) return { intent: 'copy', target: tgt(m[1]!.toLowerCase()), ...(m[2] ? { name: strip(m[2]) } : {}) };
  if ((m = /^rename (.+?) to (.+)$/i.exec(t))) return { intent: 'settings', target: tgt(m[1]!.toLowerCase()), set: { name: strip(m[2]!) } };
  if ((m = /^(?:make|switch|change|set|turn) (.+?) (?:to |into )?(?:a )?(quarterly|monthly)(?: report)?$/.exec(lower))) return { intent: 'settings', target: tgt(m[1]), set: { period_type: m[2] === 'quarterly' ? 'quarter' : 'month' } };
  if ((m = /^(?:use|default to|open on|start on) (?:the )?(previous|prior|current|latest) (?:period|month|quarter)(?: by default)?(?: (?:for|on|in) (.+))?$/.exec(lower))) return { intent: 'settings', target: tgt(m[2]), set: { use_period: /previous|prior/.test(m[1]!) ? 'previous' : 'current' } };
  if ((m = /^(turn off|remove|hide|drop|turn on|add|show) (?:the |a )?(branch|history) (?:control|controls|picker|filter)(?: (?:on|in|from|for|to) (.+))?$/.exec(lower))) {
    const on = /^(turn on|add|show)$/.test(m[1]!);
    return { intent: 'settings', target: tgt(m[3]), set: m[2] === 'branch' ? { branch_control: on } : { history_controls: on } };
  }
  if ((m = /^only (?:the )?(.+?) (?:classes? )?(?:can|may|should) (?:run|open|see|use) (.+)$/.exec(lower))) return { intent: 'settings', target: tgt(m[2]), set: { who_can_open: m[1]!.split(/,|\band\b|\bor\b/).map((x) => x.trim()).filter(Boolean) } };
  if ((m = /^(?:let|allow) (?:everyone|anyone|all users) (?:to )?(?:run|open|see|use) (.+)$/.exec(lower))) return { intent: 'settings', target: tgt(m[1]), set: { who_can_open: ['everyone'] } };
  if ((m = /^(show|include|hide|stop showing|don't show) (?:the )?(?:generated )?(?:queries|sql)(?: (?:for|in|on|under) (.+))?$/.exec(lower))) return { intent: 'settings', target: tgt(m[2]), set: { show_queries: /^(show|include)$/.test(m[1]!) } };
  if ((m = /^(?:disable|turn off|switch off|deactivate) (.+)$/.exec(lower))) return { intent: 'settings', target: tgt(m[1]), set: { enabled: false } };
  if ((m = /^(?:enable|re-?enable|turn on|switch on|reactivate|turn back on) (.+?)(?: again| back on)?$/.exec(lower))) return { intent: 'settings', target: tgt(m[1]), set: { enabled: true } };
  return null;
}

/** Words that start a settings request, for the Concierge's follow-up routing. */
export const SETTINGS_FOLLOW_UP = /^(use|default to|turn|only|let|allow|disable|enable|re-?enable|rename|hide|show the (queries|sql|settings)|include the queries|stop showing|copy|what are the settings)\b/i;
