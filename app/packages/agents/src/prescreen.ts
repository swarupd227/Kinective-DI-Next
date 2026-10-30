// Pre-screen (spec 23.3.1 step 3, 26.4). Identifiers are replaced before any model call: SSNs and
// card numbers are never sent (AI-GRD-030); account numbers become session tokens (AI-GRD-031).

export interface Prescreened {
  text: string;
  /** Token to original value, kept server-side only. */
  tokens: Record<string, string>;
  findings: { kind: 'ssn' | 'card' | 'account'; token: string }[];
  blocked: boolean;
}

export const MAX_INPUT_CHARS = 4000;

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

export function prescreen(input: string, counter = { n: 0 }): Prescreened {
  const tokens: Record<string, string> = {};
  const findings: Prescreened['findings'] = [];
  const blocked = input.length > MAX_INPUT_CHARS;
  const mint = (kind: Prescreened['findings'][number]['kind'], value: string) => {
    const token = `⟨${kind === 'account' ? 'ACCT' : kind.toUpperCase()}_${++counter.n}⟩`;
    tokens[token] = value;
    findings.push({ kind, token });
    return token;
  };
  let text = input.slice(0, MAX_INPUT_CHARS);
  // Zero-width and control characters are stripped (spec 26.3 sanitising).
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  text = text.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => mint('ssn', m));
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && luhn(digits) ? mint('card', m.trim()) : m;
  });
  // Bare runs of 8 to 17 digits read as account or loan numbers. Years and amounts are shorter.
  text = text.replace(/\b\d{8,17}\b/g, (m) => mint('account', m));
  return { text, tokens, findings, blocked };
}
