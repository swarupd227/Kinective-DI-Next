// AI usage ledger and answer feedback (spec 8.21, 26.10). The application account can add to these
// tables but never change them, so a run record stays as it was written (AI-GRD-090). The October
// history is demo data, marked as such, so a report has something to show before anyone has used DI.
export const GOVERNANCE_DDL = [
  `CREATE TABLE ai_run (
     run_id VARCHAR(40) PRIMARY KEY,
     at DATETIME(3) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     thread_id VARCHAR(40) NOT NULL,
     agent VARCHAR(60) NOT NULL,
     intent VARCHAR(40) NOT NULL,
     mode VARCHAR(16) NOT NULL,
     question VARCHAR(500) NOT NULL,
     outcome VARCHAR(24) NOT NULL,
     model VARCHAR(60) NULL,
     input_tokens INT NOT NULL,
     output_tokens INT NOT NULL,
     cache_read_tokens INT NOT NULL,
     cost_usd DECIMAL(10,6) NOT NULL,
     tool_calls JSON NOT NULL,
     source VARCHAR(8) NOT NULL,
     KEY ix_run_at (at),
     KEY ix_run_user (user_id, at)
   )`,
  `CREATE TABLE ai_feedback (
     feedback_id INT AUTO_INCREMENT PRIMARY KEY,
     run_id VARCHAR(40) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     at DATETIME(3) NOT NULL,
     rating VARCHAR(4) NOT NULL,
     comment VARCHAR(500) NULL,
     KEY ix_fb_run (run_id, feedback_id)
   )`,
];

export const GOVERNANCE_APPEND_TABLES = ['ai_run', 'ai_feedback'];

const WORK: [agent: string, intent: string, model: string, tool: string, input: Record<string, string>, questions: string[]][] = [
  ['Analytics Q&A', 'data_question', 'claude-sonnet-5-5', 'semantic_query', { metric: 'loan_balance' }, ['Show loan growth by branch for Q3 vs Q2', 'What is our delinquency ratio?', 'Show deposits by category']],
  ['Report Builder', 'report_request', 'claude-opus-5-5', 'report_run', { template: 'executive_summary' }, ['Show me last month’s executive summary', 'Get me ready for Thursday’s ALCO meeting']],
  ['Referrals', 'referral_request', 'claude-sonnet-5-5', 'referral_list', { box: 'team' }, ['Show my overdue referrals', 'What’s in my referrals inbox?']],
  ['Loan Pipeline', 'pipeline_question', 'claude-sonnet-5-5', 'pipeline_stalled', { view: 'branch' }, ['Show my stalled applications', 'Show the pipeline by product']],
  ['Goals & Incentives', 'module_task', 'claude-sonnet-5-5', 'gi_scorecard', { period: '2026-10-31' }, ['How am I doing on my goals this month?', 'Who on my team is behind on goals?']],
  ['Operations', 'module_task', 'claude-haiku-5-5', 'ops_build_status', {}, ['Did last night’s build finish?', 'Which checks failed?']],
];

const USERS: [id: string, weight: number][] = [['user:9229', 5], ['user:4410', 9], ['user:1002', 3], ['user:5120', 6], ['user:6101', 4], ['user:6004', 3]];

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0').slice(-width);

/** A month of runs, the same on every seed. */
export function generateGovernance() {
  let seed = 20261001;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = USERS.flatMap(([id, w]) => Array.from({ length: w }, () => id));
  const runs: unknown[][] = [];
  for (let day = 1; day <= 31; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    const weekday = ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    for (let i = 0, count = weekday ? 12 + Math.floor(next() * 12) : 2; i < count; i++) {
      const [agent, intent, model, tool, input, questions] = WORK[Math.floor(next() * WORK.length)]!;
      const inputTokens = 1800 + Math.floor(next() * 9000);
      const outputTokens = 120 + Math.floor(next() * 900);
      const rate = model.includes('opus') ? [5, 25] : model.includes('haiku') ? [1, 5] : [3, 15];
      const at = `${date} ${String(8 + Math.floor(next() * 9)).padStart(2, '0')}:${String(Math.floor(next() * 60)).padStart(2, '0')}:00.000`;
      runs.push([`R-${date.replaceAll('-', '')}-${hex(Math.floor(next() * 65536), 4)}${hex(i, 1)}`, at, pool[Math.floor(next() * pool.length)]!, `thr_demo${day}${i}`, agent, intent, 'demo', questions[Math.floor(next() * questions.length)]!, 'answer', model, inputTokens, outputTokens, Math.floor(inputTokens * 0.6), Math.round((inputTokens * rate[0]! + outputTokens * rate[1]!) * 100) / 1e8, JSON.stringify([{ name: tool, input, ok: true, ms: 180 + Math.floor(next() * 900) }]), 'demo']);
    }
  }
  const dateOf = (r: unknown[]) => String(r[1]).slice(0, 19);
  // Only an administrator changes users, so these are Sam's runs.
  const adminRuns = runs.filter((r) => r[4] === 'Operations' && r[2] === 'user:1002').slice(0, 3);
  const approvals = adminRuns.map((r, i) => {
    const summary = ['Create user Ana Ruiz as Lender at Westport', 'Lock Priya Shah', 'Unlock Priya Shah'][i]!;
    return [`apr_demo_${i + 1}`, i ? 'ops.iam_user_status' : 'ops.iam_user_create', JSON.stringify({ summary }), `sha256:${'0'.repeat(63)}${i}`, 'high', r[2], r[0], r[3], 'executed', dateOf(r), dateOf(r), r[2], dateOf(r), 'click'];
  });
  return { runs, approvals };
}
