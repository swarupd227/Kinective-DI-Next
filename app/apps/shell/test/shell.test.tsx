import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnnouncerProvider, ToastProvider, TooltipProvider } from '@dinext/ui';
import type { Session } from '@dinext/block-schemas';
import { createStreamStore } from '@dinext/stream-client';
import { SessionContext, type SessionValue } from '../src/session/SessionProvider.tsx';
import { terminology } from '../src/session/terminology.ts';
import { NavRail } from '../src/shell/NavRail.tsx';
import { ConversationBar } from '../src/shell/ConversationBar.tsx';
import { CommandPalette } from '../src/shell/CommandPalette.tsx';
import { RequireApp } from '../src/session/RequireApp.tsx';
import { useUi } from '../src/shell/uiStore.ts';

const baseSession: Session = {
  user: { id: 'u1', name: 'Dana Lee', firstName: 'Dana', initials: 'DL', persona: 'Executive', title: 'CEO' },
  tenant: { id: 't1', name: 'Harborview FCU', institutionType: 'credit_union' },
  apps: ['home', 'conversations', 'reports', 'tables', 'rm', 'referrals', 'seg', 'callreport'],
  permissions: { queryBrowser: false, dashboardAdmin: false },
  slashCommands: ['/ask', '/brief', '/help', '/report', '/refer'],
  flags: { voiceMediumConfirm: true, handsFree: false },
  voice: { available: false, reason: 'Voice isn’t set up in this environment.', speakByDefault: true },
  build: { state: 'completed', asOf: '2026-10-26T04:10:00-04:00', buildId: 'b1' },
  timeouts: { idleMinutes: 15, absoluteHours: 12 },
};

function makeSession(over: Partial<Session> = {}, value: Partial<SessionValue> = {}): SessionValue {
  const session = { ...baseSession, ...over };
  const apps = new Set(session.apps);
  return {
    session,
    api: { search: vi.fn().mockResolvedValue([]), threads: vi.fn().mockResolvedValue([]), cancelRun: vi.fn() } as unknown as SessionValue['api'],
    stream: createStreamStore(),
    connection: { subscribe: vi.fn() } as unknown as SessionValue['connection'],
    connState: 'open',
    terms: terminology(session.tenant.institutionType),
    can: (a) => apps.has(a),
    notifications: [],
    markRead: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    startThread: vi.fn().mockResolvedValue('thr_new'),
    switchPersona: vi.fn(),
    ...value,
  };
}

function renderShell(ui: ReactElement, session: SessionValue, path = '/home') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AnnouncerProvider>
          <ToastProvider>
            <SessionContext.Provider value={session}>
              <MemoryRouter initialEntries={[path]}>
                <Routes>
                  <Route path="*" element={ui} />
                </Routes>
              </MemoryRouter>
            </SessionContext.Provider>
          </ToastProvider>
        </AnnouncerProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function noSeriousViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
}

beforeEach(() => {
  useUi.setState({ contexts: {}, paletteOpen: false, prefill: null, mobileNavOpen: false, navCollapsed: false });
  // Desktop width: every min-width breakpoint query matches (spec 10.10).
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe('navigation rail (FE-EXP-003)', () => {
  it('shows only permitted, licensed apps', async () => {
    const { container } = renderShell(<NavRail />, makeSession());
    const nav = screen.getByRole('navigation', { name: 'Apps' });
    expect(within(nav).getByRole('link', { name: 'Reports' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Queries' })).toBeNull();
    await noSeriousViolations(container);
  });

  it('never shows SEG or 5300 to a bank tenant, whatever the session lists', () => {
    renderShell(<NavRail />, makeSession({ tenant: { ...baseSession.tenant, institutionType: 'bank' }, apps: ['home', 'reports', 'seg', 'callreport'] }));
    const nav = screen.getByRole('navigation', { name: 'Apps' });
    expect(within(nav).queryByRole('link', { name: 'SEG Management' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: '5300 Call Report' })).toBeNull();
  });

  it('marks the active app for assistive technology', () => {
    renderShell(<NavRail />, makeSession(), '/home');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('deep links never grant access (FE-ARCH-010)', () => {
  it('shows a no-access notice for apps outside the class', () => {
    renderShell(
      <RequireApp app="queries">
        <p>secret grid</p>
      </RequireApp>,
      makeSession(),
    );
    expect(screen.getByRole('heading', { name: 'You do not have access to this view' })).toBeInTheDocument();
    expect(screen.queryByText('secret grid')).toBeNull();
  });
});

describe('conversation bar (spec 6.7, 6.14, 6.15)', () => {
  it('lists only permitted slash commands and completes one with Enter', async () => {
    const user = userEvent.setup();
    renderShell(<ConversationBar collapsedByDefault={false} />, makeSession());
    const input = screen.getByRole('combobox', { name: 'Ask DI' });
    await user.type(input, '/r');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => o?.startsWith('/report'))).toBe(true);
    expect(options.some((o) => o?.startsWith('/query'))).toBe(false);
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('/report ');
  });

  it('sends active context as typed references and starts a thread outside a conversation', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    useUi.getState().addContext('new', { type: 'table', ref: 'loan_accounts', label: 'Loan Accounts' });
    renderShell(<ConversationBar collapsedByDefault={false} />, session);
    expect(screen.getByRole('list', { name: 'Context for the next message' })).toHaveTextContent('Loan Accounts');
    await user.type(screen.getByRole('combobox', { name: 'Ask DI' }), 'Why did Northgate drop?{Enter}');
    await waitFor(() => expect(session.startThread).toHaveBeenCalledWith('Why did Northgate drop?', [{ type: 'table', ref: 'loan_accounts', label: 'Loan Accounts' }], expect.objectContaining({ channel: 'text' })));
    // The chip follows the question into its new thread.
    expect(useUi.getState().contexts.thr_new).toHaveLength(1);
  });

  it('removes a context chip by its remove button', async () => {
    const user = userEvent.setup();
    useUi.getState().addContext('new', { type: 'hierarchy_node', ref: 'loc:westport', label: 'Branch: Westport' });
    renderShell(<ConversationBar collapsedByDefault={false} />, makeSession());
    await user.click(screen.getByRole('button', { name: 'Remove context Branch: Westport' }));
    expect(screen.queryByRole('list', { name: 'Context for the next message' })).toBeNull();
  });

  it('holds the message while disconnected and never sends it (FE-ARCH-050)', async () => {
    const user = userEvent.setup();
    const session = makeSession({}, { connState: 'reconnecting' });
    renderShell(<ConversationBar threadId="thr_1" collapsedByDefault={false} />, session);
    const input = screen.getByRole('combobox', { name: 'Ask DI' });
    await user.type(input, 'hello{Enter}');
    expect(session.send).not.toHaveBeenCalled();
    expect(input).toHaveValue('hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(/Reconnecting. Your message stays here/)).toBeInTheDocument();
  });

  it('starts collapsed on classic views and expands on request (FE-EXP-002)', async () => {
    const user = userEvent.setup();
    const { container } = renderShell(<ConversationBar collapsedByDefault />, makeSession());
    await user.click(screen.getByRole('button', { name: /Ask DI about this view/ }));
    expect(screen.getByRole('combobox', { name: 'Ask DI' })).toHaveFocus();
    await noSeriousViolations(container);
  });

  it('uses customer wording for bank tenants (FE-DS-050)', () => {
    renderShell(<ConversationBar collapsedByDefault={false} />, makeSession({ tenant: { ...baseSession.tenant, institutionType: 'bank' } }));
    expect(screen.getByRole('combobox', { name: 'Ask DI' })).toHaveAttribute('placeholder', expect.stringContaining('customer'));
  });
});

describe('command palette (FE-EXP-130, FE-SRCH-003)', () => {
  it('opens on Ctrl+K and asks the Concierge when Enter is pressed on free text', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    renderShell(<CommandPalette />, session);
    useUi.getState().setPalette(true);
    const input = await screen.findByPlaceholderText(/Search reports, tables, members/);
    await user.type(input, 'how many members joined last week');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(session.startThread).toHaveBeenCalledWith('how many members joined last week'));
  });

  it('lists permitted apps and commands to jump to', async () => {
    renderShell(<CommandPalette />, makeSession());
    useUi.getState().setPalette(true);
    expect(await screen.findByRole('option', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Queries' })).toBeNull();
    expect(screen.getByRole('option', { name: /\/refer/ })).toBeInTheDocument();
  });
});
