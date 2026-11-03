// @vitest-environment node
// Repeating calendar events and restoring files from the Recycle Bin. Reading the words needs no
// warehouse; the rest runs against the seeded one. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, CalendarService, CalendarStore, FileStore, describeEnd, describeRule, firstOccurrence, foldersFor, occurrences } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, calendarModule, filesModule, parseRepeat, runModuleOffline, type ModuleContext, type ModuleOutcome, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);
const TODAY = '2026-11-02'; // a Monday

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe('reading a repeat', () => {
  it('reads how often and when it ends, leaving the day and time', () => {
    expect(parseRepeat('a team huddle every Monday at 9 am', TODAY)).toEqual({ freq: 'weekly', interval: 1, weekday: 1, rest: 'a team huddle at 9 am' });
    expect(parseRepeat('a check-in every other week on Thursday at 10 am for 6 weeks', TODAY)).toMatchObject({ freq: 'weekly', interval: 2, forWeeks: 6, rest: 'a check-in on Thursday at 10 am' });
    expect(parseRepeat('a review biweekly on Fridays at 2 pm', TODAY)).toMatchObject({ freq: 'weekly', interval: 2, weekday: 5 });
    expect(parseRepeat('a weekly check-in on Thursdays at 10 am', TODAY)).toMatchObject({ freq: 'weekly', interval: 1, weekday: 4 });
    expect(parseRepeat('board prep monthly on the 1st at 8 am until June', TODAY)).toMatchObject({ freq: 'monthly', monthDay: 1, until: '2027-06-30', rest: 'board prep at 8 am' });
    expect(parseRepeat('lunch on the 15th of every month at noon until 15 December', TODAY)).toMatchObject({ freq: 'monthly', monthDay: 15, until: '2026-12-15' });
    expect(parseRepeat('a call every Tuesday at 3 pm 4 times', TODAY)).toMatchObject({ weekday: 2, count: 4 });
    expect(parseRepeat('a stand-up every day at 9 am', TODAY).unsupported).toBe('daily');
    expect(parseRepeat('a follow-up next Tuesday at 2 pm', TODAY)).toEqual({ rest: 'a follow-up next Tuesday at 2 pm' });
  });

  it('works out the dates in code, capped, with short months on their last day', () => {
    const weekly = { freq: 'weekly' as const, interval: 1, weekday: 1 };
    expect(firstOccurrence(weekly, '2026-11-03')).toBe('2026-11-09');
    const twelve = occurrences(weekly, '2026-11-09');
    expect(twelve).toHaveLength(12);
    expect(twelve.at(-1)).toBe('2027-01-25');
    expect(occurrences({ ...weekly, interval: 2, until: '2026-12-16' }, '2026-11-05')).toEqual(['2026-11-05', '2026-11-19', '2026-12-03']);
    expect(occurrences({ freq: 'monthly', interval: 1, monthDay: 31, count: 4 }, '2027-01-31')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(occurrences({ ...weekly, until: '2030-01-01' }, '2026-11-09')).toHaveLength(52);
    expect(describeRule({ freq: 'monthly', interval: 1, monthDay: 1 })).toBe('Monthly on the 1st');
    expect(describeRule({ ...weekly, interval: 2, weekday: 4 })).toBe('Every other Thursday');
    expect(describeEnd(weekly, twelve, TODAY)).toBe('After 12 times, last on Monday 25 January 2027');
  });
});

describe.skipIf(!up)('repeating events and file restores against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let events: CalendarStore;
  let files: FileStore;
  let gateway: ModuleGateway;
  let cal: ModuleSpec;
  let fil: ModuleSpec;
  const me = { id: 'user:caltest9', name: 'Rec Tester' };
  const turn = (text: string, modules: string[], user = me): ModuleTurn => ({ runId: 'R-test', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { ...user, title: 'Tester' }, tenant: { name: 'Harborview' }, modules });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    const out = await runModuleOffline(spec, t, { gateway }, r.sink);
    return { text: r.texts[0]!, out, t };
  };
  const said = async (spec: ModuleSpec, t: ModuleTurn) => (await run(spec, t)).text;
  const ctxOf = (t: ModuleTurn): ModuleContext => ({ user: t.user, modules: t.modules, runId: t.runId, threadId: t.threadId });
  const approve = async (o: { out: ModuleOutcome; t: ModuleTurn }) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: o.t.user.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, ctxOf(o.t));
  };
  const applyAgain = async (spec: ModuleSpec, o: { out: ModuleOutcome; t: ModuleTurn }) => {
    const payload = o.out.approval!.record.payload as { tool: string; apply: unknown };
    await spec.tools.find((x) => x.name === payload.tool)!.apply!(payload.apply as never, { approvalId: o.out.approval!.record.approvalId, userId: o.t.user.id }, ctxOf(o.t));
  };
  const changes = (o: { out: ModuleOutcome }) => (o.out.approval!.record.payload as { changes: { label: string; after: string }[] }).changes;
  const huddles = async () => (await events.forUser(me.id)).filter((m) => m.title === 'Team huddle');
  const cleanUp = async () => {
    await admin.query("DELETE FROM cal_occurrence WHERE event_id IN (SELECT event_id FROM cal_event WHERE owner_user_id LIKE 'user:caltest9%')");
    await admin.query("DELETE FROM cal_series WHERE event_id IN (SELECT event_id FROM cal_event WHERE owner_user_id LIKE 'user:caltest9%')");
    await admin.query("DELETE FROM cal_event WHERE owner_user_id LIKE 'user:caltest9%'");
    await admin.query("DELETE FROM fil_file WHERE owner_user_id LIKE 'user:filtest9%'");
    await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:caltest9%' OR requested_by LIKE 'user:filtest9%'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    await cleanUp();
    events = new CalendarStore(pool);
    files = new FileStore(pool);
    cal = calendarModule(async () => ({ today: TODAY, items: [] }), events, async (name) => (name === 'Ana Ruiz' ? [{ userId: 'user:6101', name: 'Ana Ruiz' }] : []), () => TODAY);
    fil = filesModule(files, () => TODAY);
    gateway = new ModuleGateway(new ApprovalStore(pool), [cal, fil]);
  });
  afterAll(async () => {
    await cleanUp();
    await admin.end();
    await pool.end();
  });

  describe('repeating events', () => {
    it('adds a weekly series at low risk, once, reading back the rule and its first dates', async () => {
      const o = await run(cal, turn('Schedule a team huddle every Monday at 9 am', ['calendar']));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('**every Monday at 9 am**: 12 dates from Monday 9 November to Monday 25 January 2027');
      expect(changes(o)).toEqual(expect.arrayContaining([{ label: 'Repeats', before: '—', after: 'Every Monday at 9 am' }, { label: 'First dates', before: '—', after: 'Monday 9 November, Monday 16 November, Monday 23 November, then 9 more' }, { label: 'Ends', before: '—', after: 'After 12 times, last on Monday 25 January 2027' }]));
      await approve(o);
      await applyAgain(cal, o);
      const [[n]] = (await admin.query("SELECT COUNT(*) AS n FROM cal_event e JOIN cal_series s ON s.event_id = e.event_id WHERE e.owner_user_id = ?", [me.id])) as unknown as [[{ n: number }]];
      expect(Number(n.n)).toBe(1);
      const dates = await huddles();
      expect(dates.map((m) => m.startsAt.slice(0, 10))).toEqual(occurrences({ freq: 'weekly', interval: 1, weekday: 1 }, '2026-11-09'));
      expect(dates[0]).toMatchObject({ startsAt: '2026-11-09 09:00', endsAt: '2026-11-09 09:30', rule: 'Every Monday', occursOn: '2026-11-09' });
      // The calendar page shows each date, with the rule in its detail.
      const page = await new CalendarService({ onboarding: { list: async () => ({ asOf: TODAY, items: [] }) } as never, issues: { list: async () => ({ items: [] }) } as never, retention: { maturing: async () => ({ items: [] }) } as never, meetings: events }).events({ userId: me.id, canUse: () => false, ctx: {} });
      expect(page.filter((e) => e.title === '9 am Team huddle')).toHaveLength(12);
      expect(page[0]!.detail).toBe('Your calendar · Every Monday');
    });

    it('reads other repeats, invites a colleague at medium risk, and asks rather than guessing', async () => {
      const o = await run(cal, turn('Set up a check-in with Ana Ruiz every other week on Thursday at 10 am for 6 weeks', ['calendar']));
      expect(o.out.approval?.record.riskTier).toBe('medium');
      expect(changes(o)).toEqual(expect.arrayContaining([{ label: 'Repeats', before: '—', after: 'Every other Thursday at 10 am' }, { label: 'First dates', before: '—', after: 'Thursday 5 November, Thursday 19 November, Thursday 3 December' }, { label: 'Ends', before: '—', after: 'Until Wednesday 16 December, 3 times' }]));
      const monthly = await run(cal, turn('Book a board prep meeting monthly on the 1st at 8 am until June', ['calendar']));
      expect(changes(monthly)).toEqual(expect.arrayContaining([{ label: 'Event', before: '—', after: 'Board prep meeting' }, { label: 'Repeats', before: '—', after: 'Monthly on the 1st at 8 am' }, { label: 'Ends', before: '—', after: 'Until Wednesday 30 June 2027, 7 times' }]));
      expect(await said(cal, turn('Schedule a huddle every day at 9 am', ['calendar']))).toContain('daily repeats aren’t built');
      const noTime = await run(cal, turn('Schedule a team huddle every Monday', ['calendar']));
      expect(noTime.text).toContain('What time');
      expect(noTime.out.asked).toBe(true);
      expect(await said(cal, turn('Schedule a review monthly at 2 pm', ['calendar']))).toContain('Which day of the month');
    });

    it('cancels one date or the whole series, asking which when it isn’t said', async () => {
      const ask = await run(cal, turn('Cancel the team huddle', ['calendar']));
      expect(ask.out.approval).toBeUndefined();
      expect(ask.out.asked).toBe(true);
      expect(ask.text).toBe('Team huddle repeats: every Monday at 9 am. Cancel just the next one, on Monday 9 November at 9 am, or the whole series?');
      // The answer comes back joined to the question, as the Concierge passes it.
      const one = await run(cal, turn('Cancel the team huddle: just this one', ['calendar']));
      expect(one.out.approval?.record.riskTier).toBe('low');
      expect(one.text).toContain('on Monday 9 November at 9 am only. The rest of the series goes ahead');
      await approve(one);
      await applyAgain(cal, one);
      const left = await huddles();
      expect(left).toHaveLength(11);
      expect(left[0]!.startsAt).toBe('2026-11-16 09:00');
      // A day named means that date.
      const named = await run(cal, turn('Cancel the team huddle on 23 November', ['calendar']));
      expect(changes(named)[0]).toEqual({ label: 'Team huddle', before: 'Scheduled, Monday 23 November at 9 am', after: 'Cancelled, this date only' });
    });

    it('moves one date only, and a second apply changes nothing', async () => {
      const o = await run(cal, turn('Move the team huddle on 16 November to Tuesday 17 November at 10 am', ['calendar']));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('Only that date moves; the rest of the series stays every Monday');
      await approve(o);
      await applyAgain(cal, o);
      const moved = (await huddles()).find((m) => m.occursOn === '2026-11-16')!;
      expect(moved).toMatchObject({ startsAt: '2026-11-17 10:00', endsAt: '2026-11-17 10:30', moved: true });
      expect(await huddles()).toHaveLength(11);
      const again = await run(cal, turn('Move the team huddle on 17 November to 11 am', ['calendar']));
      await approve(again);
      await applyAgain(cal, again);
      expect((await huddles()).find((m) => m.occursOn === '2026-11-16')!.startsAt).toBe('2026-11-17 11:00');
      expect(await said(cal, turn('Move the whole team huddle series to 10 am', ['calendar']))).toContain('isn’t built');
    });

    it('cancels the whole series', async () => {
      const o = await run(cal, turn('Cancel the whole team huddle series', ['calendar']));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('every date of **Team huddle**');
      await approve(o);
      await applyAgain(cal, o);
      expect(await huddles()).toEqual([]);
    });
  });

  describe('restoring files', () => {
    const lender = { id: 'user:filtest9', name: 'Fil Restorer' };
    const LENDING = ['files', 'files-lending'];
    const stageAndSave = async (name: string, folder: string) => {
      const f = await files.stage({ name, body: Buffer.from(`${name}\n`), owner: { userId: lender.id, name: lender.name }, on: TODAY });
      await files.save({ fileId: f.fileId, folder }, { approvalId: `apr_${f.fileId}_restore_test`, on: TODAY });
      return f.fileId;
    };

    it('restores a deleted file to its folder at low risk, once', async () => {
      const id = await stageAndSave('Filtest9 memo.txt', 'My Files');
      expect(await said(fil, turn('Restore Filtest9 memo.txt', LENDING, lender))).toContain('isn’t in the Recycle Bin: it’s in My Files');
      await files.recycle({ fileId: id, from: 'My Files' });
      expect(await said(fil, turn('What’s in my Recycle Bin?', LENDING, lender))).toContain('**1 file** in your Recycle Bin');
      // Someone else's My Files reads as not found.
      expect(await said(fil, turn('Restore Filtest9 memo.txt', LENDING, { id: 'user:filtest99', name: 'Other' }))).toContain('no file called');
      const o = await run(fil, turn('Restore Filtest9 memo.txt', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('to **My Files**, the folder it was deleted from');
      await approve(o);
      await applyAgain(fil, o);
      expect((await files.list(lender.id, foldersFor(LENDING))).find((f) => f.fileId === id)).toMatchObject({ folder: 'My Files' });
      expect(await files.binned(lender.id, foldersFor(LENDING))).toEqual([]);
    });

    it('refuses a file from a folder the person can’t see', async () => {
      const id = await stageAndSave('Filtest9 dealer memo.txt', 'Lending/Dealer Docs');
      await files.recycle({ fileId: id, from: 'Lending/Dealer Docs' });
      expect(await said(fil, turn('Restore Filtest9 dealer memo.txt', ['files'], lender))).toContain('outside your access');
      const o = await run(fil, turn('Restore Filtest9 dealer memo.txt', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(await said(fil, turn('Empty my recycle bin', LENDING, lender))).toContain('can’t be deleted for good');
    });
  });
});
