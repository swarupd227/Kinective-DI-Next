// Voice overlay states (spec 7.12) and accessibility, with a stub voice client.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { createStore } from 'zustand/vanilla';
import { TooltipProvider } from '@dinext/ui';
import { VoiceContext, type VoiceValue } from '../src/voice/VoiceProvider.tsx';
import { VoiceOverlay } from '../src/voice/VoiceOverlay.tsx';
import type { VoiceClient, VoiceState } from '../src/voice/voiceClient.ts';

function withVoice(ui: ReactElement, state: Partial<VoiceState>, value: Partial<VoiceValue> = {}) {
  const store = createStore<VoiceState>(() => ({ phase: 'idle', partial: '', level: 0, caption: '', error: null, noisy: false, readBacks: [], ...state }));
  const v: VoiceValue = {
    available: true,
    client: { store } as unknown as VoiceClient,
    speak: true,
    setSpeak: vi.fn(),
    rate: 1,
    setRate: vi.fn(),
    finals: createStore(() => ({ seq: 0, final: null })),
    ...value,
  };
  return { ...render(<TooltipProvider><VoiceContext.Provider value={v}>{ui}</VoiceContext.Provider></TooltipProvider>), v };
}

const overlay = (props: Partial<Parameters<typeof VoiceOverlay>[0]> = {}) => <VoiceOverlay review={null} notice={null} onSend={vi.fn()} onEdit={vi.fn()} onStop={vi.fn()} {...props} />;

async function noSeriousViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => x.id)).toEqual([]);
}

describe('voice overlay', () => {
  it('shows nothing while idle', () => {
    const { container } = withVoice(overlay(), { phase: 'idle' });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a visible Listening indicator with what is being heard (FE-VOICE-072)', async () => {
    const onStop = vi.fn();
    const { container } = withVoice(overlay({ onStop }), { phase: 'listening', partial: 'show loan growth', level: 0.1 });
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    expect(screen.getByText('“show loan growth”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop listening' }));
    expect(onStop).toHaveBeenCalled();
    await noSeriousViolations(container);
  });

  it('shows the understood text with Edit and a Send countdown (FE-VOICE-050)', async () => {
    const onSend = vi.fn();
    const onEdit = vi.fn();
    withVoice(overlay({ review: { text: 'Show loan growth for Q3 versus Q2', reason: 'countdown', secondsLeft: 2 }, onSend, onEdit }), { phase: 'idle' });
    expect(screen.getByText('Show loan growth for Q3 versus Q2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send (2)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onSend).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
  });

  it('asks the user to check low-confidence text and spoken numbers before sending', () => {
    const { rerender } = withVoice(overlay({ review: { text: 'Show member …4521', reason: 'identifier' } }), {});
    expect(screen.getByText(/used only to find the record on screen/)).toBeInTheDocument();
    rerender(<TooltipProvider><VoiceContext.Provider value={{ available: true, client: null, speak: true, setSpeak: vi.fn(), rate: 1, setRate: vi.fn(), finals: createStore(() => ({ seq: 0, final: null })) }}>{overlay({ review: { text: 'Shoe loans', reason: 'confidence' } })}</VoiceContext.Provider></TooltipProvider>);
    expect(screen.getByText('Is this right? Check it before sending.')).toBeInTheDocument();
  });

  it('offers who a spoken member number could be, to pick on screen (spec 7.9)', async () => {
    const onChoose = vi.fn();
    const matches = [
      { kind: 'member' as const, id: 'mbr_q-LFkkQn1x8UPxgUqaaGUQ', label: 'Suzanne Jackson', detail: '…4521 · Westport', link: '/members/mbr_q-LFkkQn1x8UPxgUqaaGUQ' },
      { kind: 'member' as const, id: 'mbr_haDJnXeIiJuitTIdeziXRw', label: 'Ivan Taylor', detail: '…4521 · Westport', link: '/members/mbr_haDJnXeIiJuitTIdeziXRw' },
    ];
    const { container, rerender } = withVoice(overlay({ review: { text: 'Pull up member …4521', reason: 'identifier', matches: null } }), {});
    expect(screen.getByRole('status')).toHaveTextContent('Looking up who that is…');
    rerender(<TooltipProvider><VoiceContext.Provider value={{ available: true, client: null, speak: true, setSpeak: vi.fn(), rate: 1, setRate: vi.fn(), finals: createStore(() => ({ seq: 0, final: null })) }}>{overlay({ review: { text: 'Pull up member …4521', reason: 'identifier', matches }, onChoose })}</VoiceContext.Provider></TooltipProvider>);
    expect(screen.getByText('Did you mean:')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Suzanne Jackson/ }));
    expect(onChoose).toHaveBeenCalledWith(matches[0]);
    await noSeriousViolations(container);
  });

  it('captions the sentence being spoken and lets the user turn speech off', async () => {
    const { v } = withVoice(overlay(), { phase: 'speaking', caption: 'Loan balances grew 2.4 percent in Q3.' });
    expect(screen.getByText('Loan balances grew 2.4 percent in Q3.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Answers are spoken. Turn off' }));
    expect(v.setSpeak).toHaveBeenCalledWith(false);
  });

  it('keeps errors readable and announced', () => {
    withVoice(overlay(), { phase: 'error', error: 'Voice is unavailable. You can keep typing.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Voice is unavailable. You can keep typing.');
  });
});
