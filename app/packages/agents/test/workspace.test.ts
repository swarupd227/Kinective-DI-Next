// @vitest-environment node
// Queries, the calendar and files against the seeded warehouse. No model calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, CalendarService, CalendarStore, FileStore, IssueService, OnboardingService, OperationsService, QueryService, RetentionService, checkUpload, findFiles, folderNamed, foldersFor } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, calendarModule, filesModule, parseWhen, runModuleOffline, spokenWhen, type ModuleContext, type ModuleOutcome, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);
const TODAY = '2026-11-02'; // a Monday

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe('reading days and times', () => {
  it('reads them relative to today, and the card reads them back', () => {
    const w = parseWhen('a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral', TODAY);
    expect(w).toMatchObject({ date: '2026-11-03', time: '14:00' });
    expect(spokenWhen(`${w.date} ${w.time}`, TODAY)).toBe('Tuesday 3 November at 2 pm');
    expect(parseWhen('Thursday', TODAY).date).toBe('2026-11-05');
    expect(parseWhen('Monday at 9', TODAY)).toMatchObject({ date: '2026-11-09', time: '09:00' });
    expect(parseWhen('tomorrow at 9:30 am for an hour', TODAY)).toMatchObject({ date: '2026-11-03', time: '09:30', minutes: 60 });
    expect(parseWhen('5 November at noon', TODAY)).toMatchObject({ date: '2026-11-05', time: '12:00' });
    expect(parseWhen('Nov 12 at 3', TODAY)).toMatchObject({ date: '2026-11-12', time: '15:00' });
    expect(parseWhen('January 4 at 10 am', TODAY).date).toBe('2027-01-04');
    expect(spokenWhen('2027-01-04 10:00', TODAY)).toBe('Monday 4 January 2027 at 10 am');
    expect(parseWhen('31 November at 2 pm', TODAY).date).toBeUndefined();
    expect(parseWhen('my 3 pm dealer visit', TODAY)).toEqual({ time: '15:00', rest: 'my dealer visit' });
  });
});

describe('uploads and folders', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  it('checks type by content, size and name, never by what the browser says', () => {
    expect(checkUpload('C:\\Users\\me\\Rate sheet.pdf', pdf)).toMatchObject({ name: 'Rate sheet.pdf', type: 'PDF', mime: 'application/pdf', sizeKb: 1 });
    expect(checkUpload('rates.csv', Buffer.from('a,b\n1,2\n')).type).toBe('CSV');
    expect(() => checkUpload('setup.exe', pdf)).toThrow('Only PDF, image, Office, CSV and text files');
    expect(() => checkUpload('fake.pdf', Buffer.from('MZ binary'))).toThrow('doesn’t look like a PDF');
    expect(() => checkUpload('notes.txt', Buffer.from([0x41, 0x00, 0x42]))).toThrow('binary');
    expect(() => checkUpload('big.pdf', Buffer.concat([pdf, Buffer.alloc(5 * 1024 * 1024)]))).toThrow('up to 5 MB');
    expect(() => checkUpload('empty.txt', Buffer.alloc(0))).toThrow('empty');
  });

  it('names folders and keeps restricted ones to those who hold them', () => {
    expect(folderNamed('the Lending > Dealer Docs folder')).toBe('Lending/Dealer Docs');
    expect(folderNamed('my files')).toBe('My Files');
    expect(folderNamed('board packs')).toBe('Board Packs');
    expect(foldersFor(['files'])).toEqual(['My Files', 'Compliance/Policies', 'Marketing']);
    expect(foldersFor(['files', 'files-board'])).toContain('Board Packs');
    expect(foldersFor(['calendar'])).toEqual([]);
    expect(findFiles('board pack', foldersFor(['files']))).toEqual([]);
  });

  it('routes calendar and file changes without taking other modules’ requests', () => {
    const gateway = new ModuleGateway(null as never, [calendarModule(async () => ({ today: TODAY, items: [] }), null, async () => [], () => TODAY), filesModule(null, () => TODAY)]);
    const cases: [string, string | undefined][] = [
      ['Schedule a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral', 'calendar'],
      ['Move my 3 pm dealer visit to Thursday', 'calendar'],
      ['Cancel the branch huddle', 'calendar'],
      ['Sync my calendar with Outlook', 'calendar'],
      ['Save this file to the Lending > Dealer Docs folder', 'files'],
      ['Move Westport huddle notes.txt to the Marketing folder', 'files'],
      ['Delete Westport huddle notes.txt', 'files'],
      ['Move Acme Manufacturing to Pre-Qualified', undefined],
      ['Log a visit to Smith Ford: met the finance manager', undefined],
      ['Export the Q3 5300 for upload', undefined],
      ['Which uploaders missed their late-file time?', undefined],
      ['Send me the branch scorecard every Monday', undefined],
      ['Save this report in the Finance / ALCO folder', undefined],
      ['Create a task for Ana Ruiz to call the Jacksons about the HELOC', undefined],
    ];
    for (const [q, id] of cases) expect([q, gateway.match(q)?.id]).toEqual([q, id]);
  });
});

describe.skipIf(!up)('workspace apps against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let queries: QueryService;
  let calendar: CalendarService;
  let events: CalendarStore;
  let files: FileStore;
  let gateway: ModuleGateway;
  let cal: ModuleSpec;
  let fil: ModuleSpec;
  const me = { id: 'user:caltest1', name: 'Cal Tester' };
  const turn = (text: string, modules: string[], user = { id: 'user:9229', name: 'Dana Lee' }): ModuleTurn => ({ runId: 'R-test', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { ...user, title: 'Tester' }, tenant: { name: 'Harborview' }, modules });
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
  /** Runs an approved change's apply a second time, as a retried request would. */
  const applyAgain = async (spec: ModuleSpec, o: { out: ModuleOutcome; t: ModuleTurn }) => {
    const payload = o.out.approval!.record.payload as { tool: string; apply: unknown };
    await spec.tools.find((x) => x.name === payload.tool)!.apply!(payload.apply as never, { approvalId: o.out.approval!.record.approvalId, userId: o.t.user.id }, ctxOf(o.t));
  };
  const cleanUp = async () => {
    await admin.query("DELETE FROM cal_event WHERE owner_user_id LIKE 'user:caltest%'");
    await admin.query("DELETE FROM fil_file WHERE owner_user_id LIKE 'user:filtest%'");
    await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:caltest%' OR requested_by LIKE 'user:filtest%'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    await cleanUp();
    queries = new QueryService(pool);
    events = new CalendarStore(pool);
    files = new FileStore(pool);
    calendar = new CalendarService({ onboarding: new OnboardingService(pool) as never, issues: new IssueService(pool) as never, retention: new RetentionService(pool) as never, meetings: events });
    const ops = new OperationsService(pool);
    const staff = async (name: string) => (await ops.users()).filter((u) => name.toLowerCase().split(/\s+/).every((w) => u.name.toLowerCase().split(/\s+/).includes(w))).map((u) => ({ userId: u.userId, name: u.name }));
    cal = calendarModule(async (ctx) => ({ today: '2026-10-25', items: await calendar.events({ userId: ctx.user.id, canUse: () => true, ctx }) }), events, staff, () => TODAY);
    fil = filesModule(files, () => TODAY);
    gateway = new ModuleGateway(new ApprovalStore(pool), [cal, fil]);
  });
  afterAll(async () => {
    await cleanUp();
    await admin.end();
    await pool.end();
  });

  describe('queries', () => {
    it('runs a SELECT over curated tables and caps the rows', async () => {
      const r = await queries.run('SELECT loan_category, COUNT(*) AS n FROM cdm_loan GROUP BY loan_category');
      expect(r.tables).toEqual(['cdm_loan']);
      expect(r.columns).toEqual(['loan_category', 'n']);
      const many = await queries.run('SELECT loan_id FROM cdm_loan');
      expect(many.rows).toHaveLength(500);
      expect(many.truncated).toBe(true);
    });

    it.each([
      ['a write', 'UPDATE cdm_loan SET balance = 0'],
      ['a second statement', 'SELECT 1 AS a; DROP TABLE cdm_loan'],
      ['the AI ledger', 'SELECT question FROM ai_run'],
      ['users', 'SELECT name FROM iam_user'],
      ['a comma join', 'SELECT l.balance, u.name FROM cdm_loan l, iam_user u'],
      ['a subquery', 'SELECT a FROM (SELECT question AS a FROM ai_run) t'],
      ['contact details', 'SELECT party_id FROM cdm_party_contact'],
      ['birth dates', 'SELECT birth_date FROM cdm_party'],
      ['select star', 'SELECT * FROM cdm_party'],
      ['another institution', 'SELECT party_id FROM dinext_t_test_bank.cdm_party'],
      ['another institution, quoted', 'SELECT party_id FROM `dinext_t_test_bank`.`cdm_party`'],
      ['a table hidden by an escaped quote', "SELECT 'x\\'' AS a, name FROM iam_user WHERE 1 = '1'"],
      ['system tables', 'SELECT table_name FROM information_schema.tables'],
      ['writing a file', "SELECT 1 AS a INTO OUTFILE 'x'"],
      ['a comment', 'SELECT 1 AS a -- x'],
      ['uploaded files', 'SELECT name FROM fil_file'],
    ])('refuses %s', async (_name, sql) => {
      await expect(queries.run(sql)).rejects.toThrow();
    });
  });

  describe('calendar', () => {
    it('merges dated work in date order, and leaves out what a person can’t use', async () => {
      const all = await calendar.events({ canUse: () => true, ctx: {} });
      expect(new Set(all.map((e) => e.kind))).toEqual(new Set(['Touch point', 'Issue due', 'Certificates']));
      expect(all.map((e) => e.date)).toEqual([...all.map((e) => e.date)].sort());
      const none = await calendar.events({ canUse: (s) => s === 'onboarding', ctx: {} });
      expect(new Set(none.map((e) => e.kind))).toEqual(new Set(['Touch point']));
    });

    it('keeps to the purview', async () => {
      const west = await calendar.events({ canUse: (s) => s === 'compliance', ctx: { purviewBranches: ['Westport'] } });
      const all = await calendar.events({ canUse: (s) => s === 'compliance', ctx: {} });
      expect(west.length).toBeLessThan(all.length);
      expect(west.every((e) => e.detail.endsWith('Westport'))).toBe(true);
    });

    it('shows a person their own events and the ones they’re invited to', async () => {
      const marcus = await calendar.events({ userId: 'user:5120', canUse: () => false, ctx: {} });
      expect(marcus.map((e) => e.title)).toEqual(['8:30 am Branch huddle', '3 pm Dealer visit: Smith Ford']);
      const ana = await calendar.events({ userId: 'user:6101', canUse: () => false, ctx: {} });
      expect(ana.find((e) => e.title.includes('Branch huddle'))?.detail).toBe('From Marcus Reed');
      expect((await calendar.events({ userId: 'user:6004', canUse: () => false, ctx: {} })).some((e) => e.title.includes('huddle'))).toBe(false);
    });

    it('answers what’s due, and refuses without access', async () => {
      expect(await said(cal, turn('What’s due this week?', ['calendar']))).toMatch(/\d+ items?\*\* through/);
      expect(await said(cal, turn('What’s due this week?', []))).toContain('isn’t part of your DI access');
      expect(await said(cal, turn('Schedule a follow-up with Suzanne Jackson next Tuesday at 2 pm', []))).toContain('isn’t part of your DI access');
    });

    it('adds an event to your own calendar at low risk, once', async () => {
      const o = await run(cal, turn('Schedule a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral', ['calendar'], me));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('**Tuesday 3 November at 2 pm**');
      const changes = (o.out.approval!.record.payload as { changes: { label: string; after: string }[] }).changes;
      expect(changes).toEqual(expect.arrayContaining([{ label: 'When', before: '—', after: 'Tuesday 3 November at 2 pm' }, { label: 'With', before: '—', after: 'Suzanne Jackson' }, { label: 'About', before: '—', after: 'HELOC referral' }]));
      expect(await events.forUser(me.id)).toEqual([]);
      await approve(o);
      await applyAgain(cal, o);
      const mine = await events.forUser(me.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ title: 'Follow-up with Suzanne Jackson', startsAt: '2026-11-03 14:00', endsAt: '2026-11-03 14:30', withWhom: 'Suzanne Jackson', withUserId: null, source: 'HELOC referral', link: '/referrals' });
      const page = await calendar.events({ userId: me.id, canUse: () => false, ctx: {} });
      expect(page).toEqual([expect.objectContaining({ date: '2026-11-03', kind: 'Event', title: '2 pm Follow-up with Suzanne Jackson', detail: 'With Suzanne Jackson · HELOC referral' })]);
    });

    it('is medium risk when it invites a colleague, who then sees it; nobody else does', async () => {
      const o = await run(cal, turn('Schedule a meeting with Ana Ruiz on Thursday at 10 am to review her pipeline', ['calendar'], me));
      expect(o.out.approval?.record.riskTier).toBe('medium');
      const payload = o.out.approval!.record.payload as { notify: { userId: string }[] };
      expect(payload.notify).toEqual([expect.objectContaining({ userId: 'user:6101', link: '/calendar' })]);
      await approve(o);
      expect((await events.forUser('user:6101')).some((m) => m.ownerUserId === me.id && m.startsAt === '2026-11-05 10:00')).toBe(true);
      // Outside your own and invited events, an event reads as not found.
      expect(await said(cal, turn('Cancel the pipeline meeting', ['calendar'], { id: 'user:5120', name: 'Marcus Reed' }))).toContain('no scheduled event matching');
    });

    it('moves an event, keeping its length; a second apply changes nothing', async () => {
      const add = await run(cal, turn('Book a dealer visit to Lakeside Honda on Wednesday at 3 pm for an hour', ['calendar'], me));
      expect(add.out.approval?.record.riskTier).toBe('low');
      await approve(add);
      const o = await run(cal, turn('Move my 3 pm dealer visit to Thursday', ['calendar'], me));
      expect(o.out.approval?.record.riskTier).toBe('low');
      expect(o.text).toContain('from Wednesday 4 November at 3 pm to **Thursday 5 November at 3 pm**');
      await approve(o);
      await applyAgain(cal, o);
      const visit = (await events.forUser(me.id)).find((m) => m.title.startsWith('Dealer visit'))!;
      expect(visit).toMatchObject({ startsAt: '2026-11-05 15:00', endsAt: '2026-11-05 16:00' });
      const withAna = await run(cal, turn('Move the meeting with Ana Ruiz to Friday at 11 am', ['calendar'], me));
      expect(withAna.out.approval?.record.riskTier).toBe('medium');
      expect(withAna.text).toContain('**Friday 6 November at 11 am**');
    });

    it('cancels at the right risk, and only your own events', async () => {
      const ana = await run(cal, turn('Cancel the meeting with Ana Ruiz', ['calendar'], me));
      expect(ana.out.approval?.record.riskTier).toBe('medium');
      expect(await said(cal, turn('Cancel the pipeline meeting', ['calendar'], { id: 'user:6101', name: 'Ana Ruiz' }))).toContain('Cal Tester’s event');
      const o = await run(cal, turn('Cancel my dealer visit', ['calendar'], me));
      expect(o.out.approval?.record.riskTier).toBe('low');
      await approve(o);
      await applyAgain(cal, o);
      expect((await events.forUser(me.id)).some((m) => m.title.startsWith('Dealer visit'))).toBe(false);
      const [[row]] = (await admin.query("SELECT status FROM cal_event WHERE owner_user_id = ? AND title LIKE 'Dealer visit%'", [me.id])) as unknown as [[{ status: string }]];
      expect(row.status).toBe('Cancelled');
    });

    it('asks rather than guessing a day or time, and won’t schedule in the past', async () => {
      const r = await run(cal, turn('Schedule a call with Suzanne Jackson next Tuesday', ['calendar'], me));
      expect(r.out.approval).toBeUndefined();
      expect(r.text).toBe('What time on Tuesday 3 November? I can’t schedule it without one.');
      expect(r.out.asked).toBe(true);
      expect(await said(cal, turn('Schedule a call with Suzanne Jackson at 2 pm', ['calendar'], me))).toContain('Which day?');
      expect(await said(cal, turn('Schedule a review on 2026-10-30 at 2 pm', ['calendar'], me))).toContain('has passed');
      expect(await said(cal, turn('Sync my calendar with Outlook', ['calendar'], me))).toContain('isn’t built');
      expect(await said(cal, turn('Move my lunch with Bob to Friday', ['calendar'], me))).toContain('no scheduled event matching');
    });
  });

  describe('files', () => {
    const lender = { id: 'user:filtest1', name: 'Fil Tester' };
    const other = { id: 'user:filtest2', name: 'Fil Other' };
    const LENDING = ['files', 'files-lending'];
    const pdf = Buffer.from('%PDF-1.4\n% Filtest rate card\n');

    it('finds a document and names who can see a folder', async () => {
      expect(findFiles('dealer agreement for Smith Ford')[0]?.name).toContain('Smith Ford');
      expect(gateway.match('Find the dealer agreement for Smith Ford')?.id).toBe('files');
      expect(await said(fil, turn('Find the dealer agreement for Smith Ford', LENDING))).toContain('found');
      expect(await said(fil, turn('Who can see the Board Packs folder?', ['files']))).toContain('Board Packs');
      // Outside the person's folders, a file isn't found.
      expect(await said(fil, turn('Find the October board pack', ['files']))).toContain('outside your access');
    });

    it('saves a staged upload to a shared folder at medium risk, once, and says it isn’t scanned', async () => {
      expect(await said(fil, turn('Save this file to the Lending > Dealer Docs folder', LENDING, lender))).toContain('no uploaded file waiting');
      const staged = await files.stage({ name: 'Filtest rate card.pdf', body: pdf, owner: { userId: lender.id, name: lender.name }, on: TODAY });
      expect((await files.list(lender.id, foldersFor(LENDING))).some((f) => f.fileId === staged.fileId)).toBe(false);
      const o = await run(fil, turn('Save this file to the Lending > Dealer Docs folder', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('medium');
      expect(o.text).toContain('It hasn’t been virus scanned');
      await approve(o);
      await applyAgain(fil, o);
      const saved = (await files.list(lender.id, foldersFor(LENDING))).filter((f) => f.name === 'Filtest rate card.pdf');
      expect(saved).toEqual([expect.objectContaining({ fileId: staged.fileId, folder: 'Lending/Dealer Docs' })]);
      expect((await files.content(lender.id, foldersFor(LENDING), staged.fileId))?.body.equals(pdf)).toBe(true);
      // Someone without the Lending folder can neither list nor download it.
      expect(await files.content(other.id, foldersFor(['files']), staged.fileId)).toBeNull();
      expect(await said(fil, turn('Find Filtest', ['files'], other))).toContain('outside your access');
      expect(await said(fil, turn('Find Filtest', LENDING, other))).toContain('**1 file** found');
    });

    it('saves to My Files at low risk, refuses a folder you can’t use, and a file you didn’t upload', async () => {
      await files.stage({ name: 'Filtest notes.txt', body: Buffer.from('Call the Jacksons back.\n'), owner: { userId: lender.id, name: lender.name }, on: TODAY });
      expect(await said(fil, turn('Save “Filtest notes.txt” to the Board Packs folder', LENDING, lender))).toContain('You can’t put files in Board Packs');
      expect(await said(fil, turn('Save “Quarterly plan.docx” to my files', LENDING, lender))).toContain('None of the files you uploaded today');
      expect(await said(fil, turn('Save “Filtest notes.txt” to my files', LENDING, other))).toContain('no uploaded file waiting');
      const o = await run(fil, turn('Save “Filtest notes.txt” to my files', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('low');
      await approve(o);
      const mine = await files.list(lender.id, foldersFor(LENDING));
      const notes = mine.find((f) => f.name === 'Filtest notes.txt')!;
      expect(notes.folder).toBe('My Files');
      expect(await files.content(other.id, foldersFor(LENDING), notes.fileId!)).toBeNull();
    });

    it('moves a file at medium risk, after which others with that folder can open it', async () => {
      const o = await run(fil, turn('Move Filtest notes.txt to the Marketing folder', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('medium');
      await approve(o);
      await applyAgain(fil, o);
      const notes = (await files.list(other.id, foldersFor(['files']))).find((f) => f.name === 'Filtest notes.txt')!;
      expect(notes.folder).toBe('Marketing');
      expect((await files.content(other.id, foldersFor(['files']), notes.fileId!))?.body.toString()).toBe('Call the Jacksons back.\n');
      expect(await said(fil, turn('Move Filtest notes.txt to the Marketing folder', LENDING, lender))).toContain('already in Marketing');
    });

    it('deletes to the Recycle Bin at medium risk, never for good, and won’t touch a sample', async () => {
      const o = await run(fil, turn('Delete Filtest notes.txt', LENDING, lender));
      expect(o.out.approval?.record.riskTier).toBe('medium');
      expect(o.text).toContain('Recycle Bin');
      await approve(o);
      await applyAgain(fil, o);
      expect((await files.list(lender.id, foldersFor(LENDING))).some((f) => f.name === 'Filtest notes.txt')).toBe(false);
      const [[row]] = (await admin.query("SELECT status, previous_folder FROM fil_file WHERE owner_user_id = ? AND name = 'Filtest notes.txt'", [lender.id])) as unknown as [[{ status: string; previous_folder: string }]];
      expect(row).toEqual({ status: 'Recycle Bin', previous_folder: 'Marketing' });
      expect(await said(fil, turn('Delete the Smith Ford dealer agreement', LENDING, lender))).toContain('sample document with no content');
      expect(await said(fil, turn('Delete Filtest notes.txt', [], lender))).toContain('isn’t part of your DI access');
    });
  });
});
