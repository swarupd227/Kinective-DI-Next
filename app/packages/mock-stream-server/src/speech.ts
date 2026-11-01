// Speaking voice-initiated answers (spec 12.7: "the Experience Layer produces speakable text for
// each response block"). It follows a run's stream events: text and notice blocks are spoken as
// they finish, data answers state the build date, approval cards get their read-back, and a long
// run gets a short acknowledgement after 3 seconds (FE-VOICE-011). Tables and charts are not read.
import type { ApprovalCardBlock, StreamEvent } from '@dinext/block-schemas';
import { approvalReadBack, DATA_DATE, PHRASES, speakable, type VoiceGateway } from '@dinext/voice';

interface VoiceRun {
  threadId: string;
  dataAgent: boolean;
  saidDate: boolean;
  spoke: boolean;
  blocks: Map<string, { type: string; data: Record<string, unknown> }>;
  ack: NodeJS.Timeout;
}

const DATA_AGENTS = /Analytics|Briefing|Goals & Incentives/;

export function createSpeechTap(voice: VoiceGateway, opts: { mediumConfirm: () => boolean; speed: number }) {
  const runs = new Map<string, VoiceRun>();

  const say = (r: VoiceRun, text: string, meta: { approvalId?: string } = {}) => {
    if (!text.trim()) return;
    clearTimeout(r.ack);
    r.spoke = true;
    voice.speak(r.threadId, text, meta);
  };

  const end = (runId: string) => {
    const r = runs.get(runId);
    if (!r) return;
    clearTimeout(r.ack);
    runs.delete(runId);
  };

  return {
    /** A run started from a spoken request; its answer is spoken too. */
    begin(runId: string, threadId: string) {
      const r: VoiceRun = { threadId, dataAgent: false, saidDate: false, spoke: false, blocks: new Map(), ack: setTimeout(() => !r.spoke && say(r, PHRASES.working), 3000 * Math.max(opts.speed, 0.05)) };
      runs.set(runId, r);
    },

    event(e: StreamEvent) {
      const runId = (e as { runId?: string }).runId;
      const r = runId ? runs.get(runId) : undefined;
      if (!r) return;
      switch (e.type) {
        case 'routing':
          if (DATA_AGENTS.test(e.agent)) r.dataAgent = true;
          return;
        case 'block.start':
          r.blocks.set(e.block.id, { type: e.block.type, data: { ...(e.block.data as Record<string, unknown>) } });
          return;
        case 'block.patch': {
          const b = r.blocks.get(e.blockId);
          if (!b) return;
          for (const op of e.ops) if ((op.op === 'add' || op.op === 'replace') && /^\/\w+$/.test(op.path)) b.data[op.path.slice(1)] = op.value;
          return;
        }
        case 'token.delta': {
          const b = r.blocks.get(e.blockId);
          if (b) b.data.markdown = `${(b.data.markdown as string | undefined) ?? ''}${e.text}`;
          return;
        }
        case 'block.end': {
          const b = r.blocks.get(e.blockId);
          if (!b) return;
          if (b.type === 'text') {
            const date = r.dataAgent && !r.saidDate ? ` ${DATA_DATE}` : '';
            if (date) r.saidDate = true;
            say(r, `${speakable(String(b.data.markdown ?? ''))}${date}`);
          } else if (b.type === 'notice') {
            say(r, speakable(String(b.data.message ?? '')));
          }
          return;
        }
        case 'approval.requested': {
          const b = r.blocks.get(e.blockId);
          const card = b?.data as ApprovalCardBlock['data'] | undefined;
          if (card?.summary) say(r, approvalReadBack({ summary: card.summary, riskTier: card.riskTier }, opts.mediumConfirm()), { approvalId: e.approvalId });
          return;
        }
        case 'run.failed':
          say(r, speakable(e.error.userMessage));
          end(e.runId);
          return;
        case 'run.completed':
        case 'run.cancelled':
          end(e.runId);
          return;
      }
    },

    close() {
      for (const id of [...runs.keys()]) end(id);
    },
  };
}
