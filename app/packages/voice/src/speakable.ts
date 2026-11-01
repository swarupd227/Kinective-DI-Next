// Turning on-screen answers into text written for listening (spec 7.11). Short sentences, rounded
// figures said as words, no tables read aloud, the data date stated, and never more than the last
// four digits of a number that identifies a person or account (FE-VOICE-071).

const SCALE_WORD: Record<string, string> = { K: 'thousand', M: 'million', B: 'billion', T: 'trillion' };

export function speakable(markdown: string): string {
  let t = markdown
    // Markdown to plain words.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n+/g, '. ')
    .replace(/[“”]/g, '"');

  t = t
    // Masked identifiers: "…4521" and "(…4521)".
    .replace(/\(?…(\d{4})\)?/g, 'ending in $1')
    // Long digit runs that are not amounts are never read in full.
    .replace(/(?<![\d,.$#])\d{8,}(?![\d,.])/g, (m) => `ending in ${m.slice(-4)}`)
    // Compact money: $1.21B, -$1.1M, $9.7K.
    .replace(/([−-])?\$(\d+(?:\.\d+)?)([KMBT])\b/g, (_m, neg: string | undefined, n: string, s: string) => `${neg ? 'minus ' : ''}${n} ${SCALE_WORD[s]} dollars`)
    .replace(/([−-])?\$(\d[\d,]*(?:\.\d+)?)/g, (_m, neg: string | undefined, n: string) => `${neg ? 'minus ' : ''}${n.replace(/\.00$/, '')} dollars`)
    .replace(/(\d+(?:\.\d+)?)\s*bp\b/g, '$1 basis points')
    .replace(/(\d+(?:\.\d+)?)%/g, '$1 percent')
    .replace(/(\d+)\+/g, '$1 plus')
    .replace(/#(\d+)/g, 'number $1')
    .replace(/−/g, 'minus ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

/** Splits text into sentences, so each can be captioned while it plays (FE-A11Y-011). */
export function sentences(text: string): string[] {
  return text
    // An initial, as in "J. Ortiz", isn't the end of a sentence.
    .split(/(?<=[.!?])(?<!\b[A-Z]\.)\s+(?=[A-Z0-9"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The read-back for an approval card (spec 7.6). Voice never completes a high-risk approval. */
export function approvalReadBack(card: { summary: string; riskTier: 'low' | 'medium' | 'high' }, voiceMediumConfirm: boolean): string {
  if (card.riskTier === 'high') return 'This needs your approval on screen.';
  const action = card.summary.replace(/^Send/, 'This will send').replace(/^Approve/, 'This will approve');
  const sentence = /^This will/.test(action) ? action : `This will ${action[0]!.toLowerCase()}${action.slice(1)}`;
  if (card.riskTier === 'medium' && !voiceMediumConfirm) return `${sentence}. Please check it and press Approve.`;
  return `${sentence}. Say confirm, or press Approve.`;
}

/** Fixed phrases, so the client never asks the gateway to say arbitrary text. */
export const PHRASES = {
  needs_screen_approval: 'This needs your approval on screen.',
  press_approve: 'Please check the card and press Approve.',
  say_confirm: 'I didn’t catch a clear yes. Say confirm, or press Approve.',
  not_heard: 'I didn’t hear anything. Hold the microphone and try again.',
  working: 'Working on that. I’ll show the steps on screen.',
} as const;

/** Spoken data answers state the build they come from (FE-VOICE-091). */
export const DATA_DATE = 'Based on last night’s build.';
