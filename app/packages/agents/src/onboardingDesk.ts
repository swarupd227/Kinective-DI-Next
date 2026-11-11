// The Onboarding agent's record list, follow-up rules and adding people to onboarding (DI's Onboarding
// Manager beyond the touch points). Every change waits for approval.
import { z } from 'zod';
import { CoreError, RULE_CONDITIONS, TOUCH_TYPES, csvCells, type FileStore, type OnboardingDeskService, type OnbRule, type RuleMatch } from '@dinext/di-core';
import { ONB_CONDITIONS } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleTool } from './moduleAgent.ts';

const PRIORITIES = ['Low', 'Normal', 'High'] as const;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');

/** Reads a rule from plain words: "after 21 days with no direct deposit, call them, high priority". */
export function ruleFrom(t: string) {
  const s = t.toLowerCase();
  const condition =
    /direct deposit/.test(s) ? 'no_direct_deposit' : /debit card|card (?:not )?activ/.test(s) ? 'card_not_activated' : /e-?statements?/.test(s) ? 'no_estatements' : /one product|single product|second product|cross-?sell/.test(s) ? 'single_product' : /online|mobile|digital/.test(s) ? 'no_digital' : undefined;
  const afterDay = Number(/\b(?:day|after|by)\s+(\d{1,2})\b|\b(\d{1,2})\s+days?\b/.exec(s)?.slice(1).find(Boolean) ?? NaN);
  const touchType = /\bemail\b/.test(s) ? 'Email' : /\bletter\b/.test(s) ? 'Letter' : /secure message/.test(s) ? 'Secure message' : /\bvisit\b/.test(s) ? 'Visit' : 'Call';
  const priority = /\bhigh\b|urgent/.test(s) ? 'High' : /\blow\b/.test(s) ? 'Low' : 'Normal';
  const name = /\b(?:called|named)\s+["“]?([^"”]+?)["”]?(?:\s+in\b|$)/i.exec(t)?.[1];
  const group = /\bin (?:the )?(?:group )?["“]?([A-Z][\w ]+?)["”]? group\b|\bgroup ["“]?([^"”]+?)["”]?$/i.exec(t)?.slice(1).find(Boolean);
  return { condition, afterDay: Number.isFinite(afterDay) ? afterDay : undefined, touchType, priority, name, group };
}

export function onboardingDeskPlan(t: string): { tool: string; args: Record<string, unknown> } | null {
  const s = t.toLowerCase();
  if (/\b(?:upload|bulk|import|from (?:the |my |this )?(?:file|list|csv))\b/.test(s) && /\bonboard/.test(s)) return { tool: 'onb_add_bulk', args: { file: /\b([\w.-]+\.csv)\b/i.exec(t)?.[1] ?? '' } };
  const add = /\b(?:add|enroll|start)\s+((?:[A-Z][\w'-]*\s?){2,3}|\d{6,})\s+(?:to|in|into|on)\s+onboarding\b/i.exec(t);
  if (add) return { tool: 'onb_add', args: { member: add[1]!.trim() } };
  if (/\brules?\b/.test(s)) {
    const ref = /\brule\s+["“]([^"”]+)["”]|\brule\s+#?(\d+)\b/i.exec(t);
    const which = ref?.[1] ?? ref?.[2];
    if (/\b(?:copy|reuse|duplicate|clone)\b/.test(s) && which) {
      const r = ruleFrom(t.replace(ref![0], ''));
      return { tool: 'onb_rule_copy', args: { rule: which, ...(r.name ? { name: r.name } : {}), ...(r.group ? { group: r.group } : {}), ...(r.afterDay ? { after_day: r.afterDay } : {}) } };
    }
    if (/\b(?:turn|switch) (?:on|off)\b|\b(?:pause|stop|disable|enable|activate|deactivate)\b/.test(s) && which) return { tool: 'onb_rule_switch', args: { rule: which, active: /\b(?:on|enable|activate)\b/.test(s) && !/\b(?:off|pause|stop|disable|deactivate)\b/.test(s) } };
    if (/\b(?:run|apply|who (?:does|would)|catch(?:es)?)\b/.test(s) && which) return { tool: 'onb_rule_run', args: { rule: which } };
    if (/\b(?:create|add|new|set up|make)\b/.test(s)) {
      const r = ruleFrom(t);
      return { tool: 'onb_rule_create', args: { name: r.name ?? '', group: r.group ?? 'Standard', condition: r.condition ?? '', after_day: r.afterDay ?? 0, touch: '', touch_type: r.touchType, priority: r.priority } };
    }
    return { tool: 'onb_rules', args: {} };
  }
  if (/\brecords?\b|\bsubscribed\b|\blast activity\b|\baccount open(?:ed)? date\b|\bwhole list\b|\beveryone in onboarding\b/.test(s)) return { tool: 'onb_records', args: { ...(/\bnot subscribed|unsubscribed\b/.test(s) ? { subscribed: false } : /\bsubscribed\b/.test(s) ? { subscribed: true } : {}), ...(/\bhigh priority\b/.test(s) ? { priority: 'High' } : {}) } };
  return null;
}

export function onboardingDeskTools(desk: OnboardingDeskService, files: FileStore | null, spec: () => ModuleSpec, need: (ctx: ModuleContext) => void): ModuleTool[] {
  const ruleRows = (rules: OnbRule[]) => rules.map((r) => ({ id: `#${r.ruleId}`, name: r.name, group: r.group, when: `After day ${r.afterDay}: ${r.conditionLabel}`, then: `${r.touch} (${r.touchType.toLowerCase()}, ${r.priority.toLowerCase()} priority)`, active: r.active ? 'On' : 'Off', made: `${r.createdBy}, ${r.createdOn}${r.copiedFrom ? `, copied from #${r.copiedFrom}` : ''}` }));
  const ruleCols = [text('id', 'Rule'), text('name', 'Name'), text('group', 'Group'), text('when', 'When'), text('then', 'Then'), text('active', 'Active'), text('made', 'Made by')];
  return [
    {
      name: 'onb_records',
      description: 'Everyone in onboarding with DI’s record columns: when they started, the next touch point with its type, due date and priority, status, progress, owner, whether they’re subscribed to the onboarding messages, the account open date and their last activity. Filter by subscribed or priority.',
      input: z.object({ subscribed: z.boolean().optional(), priority: z.enum(PRIORITIES).optional() }).strict(),
      run: async (a: { subscribed?: boolean; priority?: string }, ctx) => {
        need(ctx);
        const x = await desk.records(ctx, a);
        if (!x.total) return { text: 'No one in onboarding matches that.' };
        const behind = x.items.filter((i) => i.status === 'Behind').length;
        const unsub = x.items.filter((i) => i.subscribed === false).length;
        return {
          text: `**${x.total.toLocaleString('en-US')} people** in onboarding${a.subscribed === false ? ' not subscribed to the messages' : a.subscribed ? ' subscribed to the messages' : ''}: ${behind} behind on a touch point${a.subscribed === undefined ? `, ${unsub} not subscribed to the onboarding messages` : ''}.`,
          blocks: [
            moduleTable(spec(), 'Onboarding records', ctx.runId, 'onboarding.records', [text('name', 'Member'), text('branch', 'Branch'), { field: 'started', headerName: 'Started', type: 'date' }, text('touchType', 'Touch type'), text('nextTouch', 'Next touch point'), { field: 'nextDue', headerName: 'Due', type: 'date' }, text('priority', 'Priority'), text('status', 'Status'), text('progress', 'Done'), text('owner', 'Owner'), text('subscribed', 'Subscribed'), { field: 'accountOpened', headerName: 'Account opened', type: 'date' }, { field: 'lastActivity', headerName: 'Last activity', type: 'date' }], x.items.slice(0, 500).map((i) => ({ ...i, subscribed: yesNo(i.subscribed), nextDue: i.nextDue ?? '', accountOpened: i.accountOpened ?? '', lastActivity: i.lastActivity ?? '' }))),
          ],
        };
      },
    },
    {
      name: 'onb_rules',
      description: 'The onboarding follow-up rules, by group: what each watches for, after which day, the task it creates, and whether it’s on.',
      input: z.object({}).strict(),
      run: async (_: unknown, ctx) => {
        need(ctx);
        const rules = await desk.rules();
        if (!rules.length) return { text: 'There are no follow-up rules yet. Try “Create a follow-up rule: after day 21 with no direct deposit, call them, high priority”.' };
        const groups = [...new Set(rules.map((r) => r.group))];
        return {
          text: `**${rules.length} follow-up rules** in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'} (${groups.join(', ')}); ${rules.filter((r) => r.active).length} are on.`,
          blocks: [moduleTable(spec(), 'Follow-up rules', ctx.runId, 'onboarding.rules', ruleCols, ruleRows(rules))],
          suggestions: [`Who does rule #${rules[0]!.ruleId} catch today?`, `Copy rule #${rules[0]!.ruleId} as a 45-day version`],
        };
      },
    },
    {
      name: 'onb_rule_create',
      description: `Create a follow-up rule: after which day of onboarding (1 to 90), the condition (${RULE_CONDITIONS.join(', ')}), the task to create, its touch type (${TOUCH_TYPES.join(', ')}) and priority, in a named group. Needs approval.`,
      input: z.object({ name: z.string().max(80), group: z.string().min(2).max(60), condition: z.string().max(30), after_day: z.number().int().min(0).max(90), touch: z.string().max(60), touch_type: z.enum(TOUCH_TYPES), priority: z.enum(PRIORITIES) }).strict(),
      run: async (a: { name: string; group: string; condition: string; after_day: number; touch: string; touch_type: (typeof TOUCH_TYPES)[number]; priority: (typeof PRIORITIES)[number] }, ctx) => {
        need(ctx);
        if (!RULE_CONDITIONS.includes(a.condition as never)) return { text: `What should the rule watch for? It can be: ${Object.values(ONB_CONDITIONS).join('; ')}.` };
        if (!a.after_day) return { text: 'After which day of onboarding should it check, from 1 to 90?' };
        const label = ONB_CONDITIONS[a.condition]!;
        const touch = a.touch || `Follow up: ${label}`;
        const name = a.name || `${label[0]!.toUpperCase()}${label.slice(1)} by day ${a.after_day}`;
        const would = await desk.matches({ ruleId: -1, name, group: a.group, condition: a.condition, conditionLabel: label, afterDay: a.after_day, touch, touchType: a.touch_type, priority: a.priority, active: true, createdBy: ctx.user.name, createdOn: '', copiedFrom: null }, ctx);
        return {
          change: {
            summary: `Create the follow-up rule “${name}”`,
            changes: [
              { label: 'Rule', before: '—', after: `${name}, in ${a.group}` },
              { label: 'When', before: '—', after: `From day ${a.after_day}: ${label}` },
              { label: 'Then', before: '—', after: `${touch} (${a.touch_type.toLowerCase()}, ${a.priority.toLowerCase()} priority), for the person’s onboarding owner` },
              { label: 'Today', before: '—', after: `${would.length} ${would.length === 1 ? 'person matches' : 'people match'}` },
            ],
            text: `I’ve prepared the rule **${name}**. Today it would catch **${would.length}** ${would.length === 1 ? 'person' : 'people'}; once it’s saved, ask me to run it to create their tasks.`,
            done: `Saved the follow-up rule “${name}” in ${a.group}.`,
            risk: 'low',
            apply: { name, group: a.group, condition: a.condition, afterDay: a.after_day, touch, touchType: a.touch_type, priority: a.priority, createdBy: ctx.user.name, copiedFrom: null },
          },
        };
      },
      apply: async (p: Parameters<OnboardingDeskService['createRule']>[0], meta) => {
        await desk.createRule(p, { approvalId: meta.approvalId });
      },
    },
    {
      name: 'onb_rule_copy',
      description: 'Reuse a rule: copy it under a new name, optionally into another group or with a different day. Needs approval.',
      input: z.object({ rule: z.string().min(1).max(80), name: z.string().max(80).optional(), group: z.string().max(60).optional(), after_day: z.number().int().min(1).max(90).optional() }).strict(),
      run: async (a: { rule: string; name?: string; group?: string; after_day?: number }, ctx) => {
        need(ctx);
        const r = await desk.rule(a.rule);
        const afterDay = a.after_day ?? r.afterDay;
        const name = a.name ?? (a.after_day ? r.name.replace(/\d+/, String(afterDay)) : `${r.name} (copy)`);
        return {
          change: {
            summary: `Copy rule #${r.ruleId} as “${name}”`,
            changes: [
              { label: 'Rule', before: `${r.name}, in ${r.group}`, after: `${name}, in ${a.group ?? r.group}` },
              { label: 'When', before: `From day ${r.afterDay}`, after: `From day ${afterDay}: ${r.conditionLabel}` },
            ],
            text: `I’ve prepared a copy of **${r.name}** as **${name}**${a.group ? ` in ${a.group}` : ''}.`,
            done: `Copied rule #${r.ruleId} as “${name}”.`,
            risk: 'low',
            apply: { name, group: a.group ?? r.group, condition: r.condition, afterDay, touch: r.touch, touchType: r.touchType, priority: r.priority, createdBy: ctx.user.name, copiedFrom: r.ruleId },
          },
        };
      },
      apply: async (p: Parameters<OnboardingDeskService['createRule']>[0], meta) => {
        await desk.createRule(p, { approvalId: meta.approvalId });
      },
    },
    {
      name: 'onb_rule_switch',
      description: 'Turn a follow-up rule on or off. Needs approval.',
      input: z.object({ rule: z.string().min(1).max(80), active: z.boolean() }).strict(),
      run: async (a: { rule: string; active: boolean }, ctx) => {
        need(ctx);
        const r = await desk.rule(a.rule);
        if (r.active === a.active) return { text: `Rule #${r.ruleId}, ${r.name}, is already ${a.active ? 'on' : 'off'}.` };
        return {
          change: { summary: `Turn rule #${r.ruleId} ${a.active ? 'on' : 'off'}`, changes: [{ label: r.name, before: r.active ? 'On' : 'Off', after: a.active ? 'On' : 'Off' }], text: `I’ve prepared turning **${r.name}** ${a.active ? 'on' : 'off'}.`, done: `Rule #${r.ruleId} is ${a.active ? 'on' : 'off'}.`, risk: 'low', apply: { ruleId: r.ruleId, active: a.active } },
        };
      },
      apply: async (p: { ruleId: number; active: boolean }) => {
        await desk.setActive(p.ruleId, p.active);
      },
    },
    {
      name: 'onb_rule_run',
      description: 'Run a follow-up rule: who it catches today, and their follow-up tasks created on approval (once per person per rule).',
      input: z.object({ rule: z.string().min(1).max(80) }).strict(),
      run: async (a: { rule: string }, ctx) => {
        need(ctx);
        const r = await desk.rule(a.rule);
        const people = await desk.matches(r, ctx);
        if (!people.length) return { text: `**${r.name}** catches no one today: everyone past day ${r.afterDay} has moved on from “${r.conditionLabel}”, or already has its task.` };
        const table = moduleTable(spec(), `${r.name}: who it catches`, ctx.runId, 'onboarding.rule.matches', [text('name', 'Member'), text('branch', 'Branch'), { field: 'day', headerName: 'Day of onboarding', type: 'count' }], people.map((p) => ({ name: p.name, branch: p.branch, day: p.day })));
        if (!r.active) return { text: `**${r.name}** is off; it would catch **${people.length}** today. Turn it on to create their tasks.`, blocks: [table] };
        return {
          change: {
            summary: `Create ${people.length} follow-up ${people.length === 1 ? 'task' : 'tasks'} from “${r.name}”`,
            changes: people.slice(0, 20).map((p) => ({ label: `${p.name}, ${p.branch}`.slice(0, 80), before: '—', after: `${r.touch}, due today` })),
            text: `**${r.name}** catches **${people.length}** ${people.length === 1 ? 'person' : 'people'} today (${r.conditionLabel}, past day ${r.afterDay}). Each gets “${r.touch}” for their onboarding owner once you approve.`,
            done: `Created ${people.length} follow-up ${people.length === 1 ? 'task' : 'tasks'} from “${r.name}”.`,
            risk: 'low',
            apply: { ruleId: r.ruleId, people },
          },
          blocks: [table],
        };
      },
      apply: async (p: { ruleId: number; people: RuleMatch[] }) => {
        const r = (await desk.rules()).find((x) => x.ruleId === p.ruleId);
        if (!r) throw new CoreError('NOT_FOUND', 'That rule no longer exists.');
        await desk.runRule(r, p.people);
      },
    },
    {
      name: 'onb_add',
      description: 'Add someone to onboarding by name or member number: their five touch points start today, with the user as owner, and they’re subscribed to the onboarding messages. Needs approval.',
      input: z.object({ member: z.string().min(2).max(80) }).strict(),
      run: async (a: { member: string }, ctx) => {
        need(ctx);
        const x = await desk.resolve([a.member], ctx);
        if (!x.ready.length) return { text: x.problems[0]?.problem ?? `I couldn’t find ${a.member}.` };
        const p = x.ready[0]!;
        return {
          change: {
            summary: `Add ${p.name} to onboarding`,
            changes: [{ label: `${p.name}, ${p.branch}`, before: 'Not in onboarding', after: 'Welcome call in 2 days, then day 14, 30, 60 and 90' }],
            text: `I’ve prepared adding **${p.name}** to onboarding, with you as owner. The welcome call is due in 2 days.`,
            done: `Added ${p.name} to onboarding.`,
            risk: 'low',
            apply: { people: [{ partyId: p.partyId, branchId: p.branchId }], assigneeId: ctx.employeeId ?? null },
          },
        };
      },
      apply: async (p: { people: { partyId: number; branchId: number }[]; assigneeId: number | null }) => {
        await desk.add(p.people, p.assigneeId);
      },
    },
    {
      name: 'onb_add_bulk',
      description: 'Add people to onboarding from an uploaded CSV with a member number or name per row: says which rows won’t load and why, and starts the rest on approval.',
      input: z.object({ file: z.string().max(120) }).strict(),
      run: async (a: { file: string }, ctx) => {
        need(ctx);
        if (!files) return { text: 'Uploads aren’t set up for this institution.' };
        const staged = await files.stagedContent(ctx.user.id, a.file || undefined);
        if (!/\.csv$/i.test(staged.name)) return { text: `${staged.name} isn’t a CSV. Save the list as CSV with a member number or name column.` };
        const lines = staged.body.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
        const head = csvCells(lines[0] ?? '').map((h) => h.toLowerCase());
        const col = Math.max(0, head.findIndex((h) => /member|customer|name|number/.test(h)));
        const x = await desk.resolve(lines.slice(1, 501).map((l) => csvCells(l)[col] ?? ''), ctx);
        const problems = x.problems.map((p) => ({ line: String(p.line + 1), problem: p.problem }));
        const table = problems.length ? [moduleTable(spec(), 'Rows that won’t load', ctx.runId, 'onboarding.bulk.problems', [text('line', 'Row'), text('problem', 'Why')], problems)] : [];
        if (!x.ready.length) return { text: `None of the rows in **${staged.name}** can be added.`, blocks: table };
        return {
          change: {
            summary: `Add ${x.ready.length} ${x.ready.length === 1 ? 'person' : 'people'} to onboarding from ${staged.name}`,
            changes: x.ready.slice(0, 20).map((p) => ({ label: `${p.name}, ${p.branch}`.slice(0, 80), before: 'Not in onboarding', after: 'Five touch points from today' })),
            text: `**${staged.name}**: **${x.ready.length}** can be added${problems.length ? ` and ${problems.length} won’t load (listed below)` : ''}. Their touch points start today, with you as owner, once you approve.`,
            done: `Added ${x.ready.length} ${x.ready.length === 1 ? 'person' : 'people'} to onboarding.`,
            risk: 'medium',
            apply: { people: x.ready.map((p) => ({ partyId: p.partyId, branchId: p.branchId })), assigneeId: ctx.employeeId ?? null },
          },
          blocks: table,
        };
      },
      apply: async (p: { people: { partyId: number; branchId: number }[]; assigneeId: number | null }) => {
        await desk.add(p.people, p.assigneeId);
      },
    },
  ];
}
