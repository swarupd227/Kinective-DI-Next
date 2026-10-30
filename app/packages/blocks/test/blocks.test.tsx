import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { AnnouncerProvider, TooltipProvider } from '@dinext/ui';
import type { Block } from '@dinext/block-schemas';
import {
  approvalHighFixture,
  approvalMediumFixture,
  chartFixture,
  kpiFixture,
  kpiGroupFixture,
  member360Fixture,
  memberCardFixture,
  noticeFixtures,
  planStepsFixture,
  reportCanvasFixture,
  tableFixture,
  textFixture,
} from '@dinext/block-schemas/fixtures';
import { BlockHostProvider, BlockRenderer, safeHref, type BlockHost } from '../src/index.ts';

// ECharts needs a real layout engine; component tests check the frame and the table view instead.
vi.mock('../src/chart/EChart.tsx', () => ({ EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }));

function renderBlock(ui: ReactElement, host: BlockHost = {}) {
  return render(
    <TooltipProvider>
      <AnnouncerProvider>
        <BlockHostProvider value={host}>{ui}</BlockHostProvider>
      </AnnouncerProvider>
    </TooltipProvider>,
  );
}

async function expectNoSeriousA11yViolations(container: HTMLElement) {
  // Colour contrast is checked against tokens in the tokens package; jsdom cannot compute it.
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const cases: [string, Block][] = [
  ['text', textFixture],
  ['kpi', kpiFixture],
  ['kpi_group', kpiGroupFixture],
  ['chart', chartFixture],
  ['plan_steps', planStepsFixture],
  ['approval medium', approvalMediumFixture()],
  ['approval high', approvalHighFixture()],
  ['member_card', memberCardFixture],
  ['member_360', member360Fixture],
  ['report_canvas', reportCanvasFixture],
  ...noticeFixtures.map((n) => [`notice ${n.data.kind}`, n] as [string, Block]),
];

describe('every block in every state has no serious accessibility violations (FE-ARCH-100, FE-ARCH-101)', () => {
  for (const [name, block] of cases) {
    it(`${name}: complete`, async () => {
      const { container } = renderBlock(<BlockRenderer block={block} status="complete" />);
      await screen.findAllByRole(block.type === 'approval_card' ? 'region' : 'article');
      await expectNoSeriousA11yViolations(container);
    });
    it(`${name}: loading`, async () => {
      const { container } = renderBlock(<BlockRenderer block={{ ...block, data: {} }} status="loading" />);
      await expectNoSeriousA11yViolations(container);
    });
  }
});

describe('frame', () => {
  it('shows source chips and the nightly-build freshness, never "live" (FE-EXP-110)', () => {
    renderBlock(<BlockRenderer block={kpiGroupFixture} />);
    const sources = screen.getByRole('list', { name: 'Sources' });
    expect(within(sources).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/Data as of nightly build/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(live|real time|real-time)\b/i);
  });

  it('shows a locked source without a link (spec 6.13)', () => {
    renderBlock(<BlockRenderer block={approvalHighFixture()} />, { onSourceOpen: () => {} });
    expect(screen.getByText('Tier table v3').closest('button')).toBeNull();
    expect(screen.getByText('(no access)')).toBeInTheDocument();
  });

  it('marks the block busy while loading', () => {
    renderBlock(<BlockRenderer block={{ ...textFixture, data: {} }} status="loading" />);
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('validation and safety (spec 9.1, FE-GEN-010)', () => {
  it('renders a notice instead of an unknown block type', () => {
    renderBlock(<BlockRenderer block={{ ...textFixture, type: 'hologram', data: { html: '<img src=x onerror=alert(1)>' } } as unknown as Block} />);
    expect(screen.getByText('This kind of result cannot be shown here yet.')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('strips raw HTML from markdown and blocks links outside the allow-list', async () => {
    const md = 'Hello <script>alert(1)</script><b>bold</b> [deep](/reports/periodic/1) [evil](https://evil.example/x) [js](javascript:alert(1))';
    renderBlock(<BlockRenderer block={{ ...textFixture, data: { markdown: md } }} />);
    // The Markdown renderer is lazy-loaded (bundle budget), so wait for it.
    expect(await screen.findByRole('link', { name: 'deep' }, { timeout: 5000 })).toHaveAttribute('href', '/reports/periodic/1');
    expect(document.querySelector('script, b')).toBeNull();
    expect(screen.queryByRole('link', { name: 'evil' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'js' })).toBeNull();
  });

  it('allows only relative deep links and Kinective help over https', () => {
    expect(safeHref('/c/thr_1')).toBe('/c/thr_1');
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('https://help.kinective.com/a')).toBe('https://help.kinective.com/a');
    expect(safeHref('http://help.kinective.com/a')).toBeNull();
  });

  it('offers a table view for charts (FE-GEN-002)', async () => {
    const user = userEvent.setup();
    renderBlock(<BlockRenderer block={chartFixture} />);
    await user.click(await screen.findByRole('radio', { name: 'Table view' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Westport' })).toBeInTheDocument();
    expect(within(table).getByText('$200.6M')).toBeInTheDocument();
  });

  it('shows a no-data notice, never an empty chart frame', () => {
    renderBlock(<BlockRenderer block={{ ...chartFixture, data: { ...chartFixture.data, dataset: { ...chartFixture.data.dataset, source: [] } } }} />);
    expect(screen.getByText('No rows matched.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('kpi', () => {
  it('describes the change in words for screen readers, not colour alone', () => {
    renderBlock(<BlockRenderer block={{ ...kpiGroupFixture }} />);
    expect(screen.getByText(/Up 4 bp vs prior build, unfavourable/)).toBeInTheDocument();
    expect(screen.getByText(/Down 0.1% vs prior build, unfavourable/)).toBeInTheDocument();
  });
});

describe('approval card (spec 6.10, 9.7, 12.5)', () => {
  const ok = { ok: true as const, decision: 'approved' as const, by: 'Dana Lee', at: '2026-10-26T14:05:00Z' };

  it('sends the preview hash and idempotency key with the decision (FE-API-010, FE-EXP-083)', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(ok);
    const card = approvalMediumFixture();
    renderBlock(<BlockRenderer block={card} />, { onDecision });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    const [, body, key] = onDecision.mock.calls[0]!;
    expect(key).toBe(card.data.idempotencyKey);
    expect(body).toMatchObject({ decision: 'approve', channel: 'click', clientContext: { previewHash: card.data.previewHash, blockVersionSeen: '1.2.0' } });
  });

  it('records keyboard activation as the keyboard channel, and Ctrl+Enter approves', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(ok);
    renderBlock(<BlockRenderer block={approvalMediumFixture()} />, { onDecision });
    screen.getByRole('button', { name: 'Approve' }).focus();
    await user.keyboard('{Enter}');
    expect(onDecision.mock.calls[0]![1]).toMatchObject({ channel: 'keyboard' });
  });

  it('high risk: requires the typed key value and a note, and never offers voice (FE-EXP-081)', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(ok);
    renderBlock(<BlockRenderer block={approvalHighFixture()} />, { onDecision, voiceMediumAllowed: true });
    expect(screen.getByText('Voice: not allowed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.getByText('Type $9,720.00 exactly to approve.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Type the total to confirm'), '$9,720.00');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.getByText('A note is required for this approval.')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Note/), 'Checked with HR');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0]![1]).toMatchObject({ typedConfirmation: '$9,720.00', note: 'Checked with HR' });
  });

  it('runs step-up and retries with the token when the server asks (FE-EXP-082)', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED' }).mockResolvedValueOnce(ok);
    const onStepUp = vi.fn().mockResolvedValue('stp_token');
    renderBlock(<BlockRenderer block={approvalMediumFixture()} />, { onDecision, onStepUp });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(2));
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[1]![1]).toMatchObject({ stepUpToken: 'stp_token' });
  });

  it('shows a clear message when the preview changed (409 PREVIEW_CHANGED)', async () => {
    const user = userEvent.setup();
    renderBlock(<BlockRenderer block={approvalMediumFixture()} />, { onDecision: vi.fn().mockResolvedValue({ ok: false, code: 'PREVIEW_CHANGED' }) });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/updated after you opened it/)).toBeInTheDocument();
  });

  it('cannot be approved once expired (FE-GEN-031)', () => {
    const card = approvalMediumFixture();
    renderBlock(<BlockRenderer block={{ ...card, data: { ...card.data, expiresAt: '2020-01-01T00:00:00Z' } }} />, { onDecision: vi.fn() });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText('Expired. Ask again')).toBeInTheDocument();
  });

  it('asks for a note before returning', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue({ ...ok, decision: 'returned' });
    renderBlock(<BlockRenderer block={approvalMediumFixture()} />, { onDecision });
    await user.click(screen.getByRole('button', { name: 'Return with note' }));
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Note/)).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Return with note' }));
    expect(onDecision).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Note/), 'Wrong branch');
    await user.click(screen.getByRole('button', { name: 'Return with note' }));
    expect(onDecision.mock.calls[0]![1]).toMatchObject({ decision: 'return', note: 'Wrong branch' });
  });

  it('becomes a read-only record once resolved', () => {
    const card = approvalMediumFixture();
    renderBlock(<BlockRenderer block={{ ...card, data: { ...card.data, resolution: { decision: 'approved', by: 'Dana Lee', at: '2026-10-26T14:05:00Z', channel: 'voice' } } }} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Approved').closest('[role=status]')).toHaveTextContent(/Approved by Dana Lee at .* \(voice\)/);
  });
});

describe('plan steps', () => {
  it('expands operations and offers Stop for a running run (FE-EXP-061, FE-EXP-090)', async () => {
    const user = userEvent.setup();
    const onCancelRun = vi.fn();
    renderBlock(<BlockRenderer block={planStepsFixture} />, { onCancelRun });
    const toggle = screen.getAllByRole('button', { name: '1 operation' })[0]!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('semantic.query')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onCancelRun).toHaveBeenCalledWith('R-20261026-0051');
  });

  it('hides SQL unless the user may view it', async () => {
    const user = userEvent.setup();
    const block = { ...planStepsFixture, data: { ...planStepsFixture.data, steps: [{ ...planStepsFixture.data.steps[0]!, operations: [{ name: 'query.run', sql: 'SELECT 1' }] }] } };
    const { unmount } = renderBlock(<BlockRenderer block={block} />, { canViewSql: false });
    await user.click(screen.getByRole('button', { name: '1 operation' }));
    expect(screen.queryByText('SELECT 1')).toBeNull();
    unmount();
    renderBlock(<BlockRenderer block={block} />, { canViewSql: true });
    await user.click(screen.getByRole('button', { name: '1 operation' }));
    expect(screen.getByText('SELECT 1')).toBeInTheDocument();
  });
});

describe('table', () => {
  it('renders declared columns with formatted values', async () => {
    renderBlock(<BlockRenderer block={tableFixture} />);
    expect(await screen.findByText('Westport', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Q3 balance')).toBeInTheDocument();
  });
});

describe('report canvas (spec 8.5, 8.9)', () => {
  it('re-runs in place when a control changes, without a conversation turn (spec 8.5)', async () => {
    const rerun = { ...reportCanvasFixture, id: 'blk_rptAlcoDraft0002', data: { ...reportCanvasFixture.data, periodLabel: 'Aug 2026', controls: reportCanvasFixture.data.controls.map((c) => (c.id === 'period' ? { ...c, value: '2026-08' } : c)) } };
    const runReport = vi.fn(async () => rerun);
    const onAction = vi.fn();
    const { container } = renderBlock(<BlockRenderer block={reportCanvasFixture} />, { runReport, onAction });
    const month = await screen.findByRole('combobox', { name: 'Month' }, { timeout: 4000 });
    await userEvent.selectOptions(month, '2026-08');
    expect(runReport).toHaveBeenCalledWith('draft_a1b2c3', { period: '2026-08', node: 'all' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Month' })).toHaveValue('2026-08'));
    expect(onAction).not.toHaveBeenCalled();
    await expectNoSeriousA11yViolations(container);
  });

  it('shows each agent change with Accept and Revert, and the layout tools in edit mode (FE-BLD-002, FE-BLD-003)', async () => {
    const editReport = vi.fn(async () => reportCanvasFixture);
    renderBlock(<BlockRenderer block={reportCanvasFixture} />, { editReport, runReport: vi.fn() });
    const review = await screen.findByRole('region', { name: 'Changes to review' }, { timeout: 4000 });
    expect(review).toHaveTextContent('1 change to review');
    await userEvent.click(within(review).getByRole('button', { name: 'Revert: Made “Loan growth by branch” a bar chart' }));
    expect(editReport).toHaveBeenLastCalledWith('draft_a1b2c3', { kind: 'revert', editId: 'e1' }, { period: '2026-09', node: 'all' });
    await userEvent.click(screen.getByRole('button', { name: 'Move Loan growth by branch earlier' }));
    expect(editReport).toHaveBeenLastCalledWith('draft_a1b2c3', { kind: 'move', widgetId: 'c1', position: 0 }, expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'Make Total loans wider' }));
    expect(editReport).toHaveBeenLastCalledWith('draft_a1b2c3', { kind: 'resize', widgetId: 'k1', size: 'full' }, expect.anything());
    // The first widget cannot move earlier.
    expect(screen.getByRole('button', { name: 'Move Total loans earlier' })).toBeDisabled();
  });

  it('turns Save into a request in the conversation, never a direct write (FE-GEN-021)', async () => {
    const onAction = vi.fn();
    renderBlock(<BlockRenderer block={reportCanvasFixture} />, { onAction, runReport: vi.fn(), editReport: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Save…' }, { timeout: 4000 }));
    expect(onAction.mock.calls[0]![1]).toMatchObject({ kind: 'ask_followup', params: { question: 'Save the ALCO pack report in My Reports' } });
  });
});

describe('member records (spec 8.24)', () => {
  it('the card shows masked identity and scores, and hands "Why?" and "Open" to the host with the token only', async () => {
    const onAction = vi.fn();
    const { container } = renderBlock(<BlockRenderer block={memberCardFixture} />, { onAction });
    expect(await screen.findByRole('heading', { name: 'Suzanne Jackson' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('…4521')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Attrition risk' })).toHaveAttribute('aria-valuetext', 'Medium, 6 of 10');
    await userEvent.click(screen.getByRole('button', { name: 'Why? Attrition risk' }));
    expect(onAction.mock.calls[0]![1]).toMatchObject({ kind: 'explain', params: { memberRef: memberCardFixture.data.memberRef, question: 'Why is Suzanne’s attrition risk medium?' } });
    await userEvent.click(screen.getByRole('button', { name: 'Open Member 360' }));
    expect(onAction.mock.calls[1]![1]).toMatchObject({ kind: 'open_record', params: { memberRef: memberCardFixture.data.memberRef, label: 'Suzanne Jackson' } });
    expect(container.textContent).not.toMatch(/10004521/);
    await expectNoSeriousA11yViolations(container);
  });

  it('a pick-list card offers only "Choose"', async () => {
    renderBlock(<BlockRenderer block={{ ...memberCardFixture, data: { ...memberCardFixture.data, selected: false } }} />);
    expect(await screen.findByRole('button', { name: /^Choose Suzanne Jackson, number ending 4521, Westport$/ }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('the 360 has every dashboard section as keyboard tabs (FE-RM-001)', async () => {
    const { container } = renderBlock(<BlockRenderer block={member360Fixture} />);
    const tabs = await screen.findAllByRole('tab', {}, { timeout: 4000 });
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Accounts', 'Digital', 'Cross-sell & growth', 'Loan apps1', 'Engagement & retention', 'Opportunities2', 'Interactions4', 'Rewards', 'Contact', 'Household']);
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveFocus();
    expect(within(screen.getByRole('tabpanel')).getByText('Share Savings')).toBeInTheDocument();
    await userEvent.keyboard('{End}');
    expect(within(screen.getByRole('tabpanel')).getByText('1 more person outside your branches, not shown.')).toBeInTheDocument();
    await expectNoSeriousA11yViolations(container);
  });

  it('opportunities offer Refer only when a referral type exists, and Member declined always', async () => {
    const onAction = vi.fn();
    renderBlock(<BlockRenderer block={member360Fixture} />, { onAction });
    await userEvent.click(await screen.findByRole('tab', { name: /Opportunities/ }, { timeout: 4000 }));
    expect(screen.queryByRole('button', { name: 'Refer Suzanne Jackson for Checking' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Refer Suzanne Jackson for Credit card' }));
    await userEvent.click(screen.getByRole('button', { name: 'Suzanne Jackson declined Checking' }));
    expect(onAction.mock.calls.map((c) => c[1])).toMatchObject([
      { kind: 'run_operation', operation: 'referral.create', params: { question: 'Open a Credit card referral for Suzanne Jackson' } },
      { kind: 'run_operation', operation: 'relationship.suggestion.decline', riskTier: 'low', params: { question: 'Suzanne Jackson declined the Checking offer' } },
    ]);
  });
});
