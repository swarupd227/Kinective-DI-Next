// Ctrl K matching on the page, the same rule the server ranks with (mock-stream-server/src/search.ts).

/** Each typed word has to start a word in the text ("board" finds Board report, not Onboarding). */
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9$%]+/).filter(Boolean);
export const startsWords = (q: string, text: string) => {
  const ws = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const toks = tokens(text);
  return ws.every((w) => toks.some((t) => t.startsWith(w)));
};

/** A question goes to DI on Enter even when something matches one of its words. */
export const looksLikeQuestion = (q: string) => /\?\s*$/.test(q) || /^(why|what|how|which|who|when|where|is|are|was|were|can|could|should|do|does|did|show|compare|brief|tell|list|give|find|explain|summari[sz]e)\b/i.test(q.trim());
