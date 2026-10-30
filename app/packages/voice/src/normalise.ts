// Normalising spoken banking language (spec 7.7). The input box shows the result, so the user sees
// what was understood before it is sent. SSNs and card numbers are removed before anything is
// stored (spec 7.9), and spoken member or account numbers are flagged for on-screen lookup
// (FE-VOICE-051), never acted on from voice alone.
import type { SpokenIdentifier } from '@dinext/block-schemas';

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const DIGIT_WORDS = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const ORDINAL_QUARTER: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };
const UNITS = /^(dollars?|bucks|percent|bips|bps|basis|days?|months?|years?|plus|k)$/i;

const isNumberWord = (w: string) => w in ONES || w in TENS || w in SCALES || w === 'hundred';

/** Parses a run of number words, such as "two point five million" or "sixty thousand". */
function parseWords(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let decimals = '';
  let inDecimal = false;
  let seen = false;
  for (const w of words) {
    if (w === 'and' || w === 'a') continue;
    if (w === 'point') {
      inDecimal = true;
      continue;
    }
    if (inDecimal && w in ONES && ONES[w]! < 10) {
      decimals += String(ONES[w]);
      continue;
    }
    if (w in ONES) current += ONES[w]!;
    else if (w in TENS) current += TENS[w]!;
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w in SCALES) {
      total += (current + (decimals ? Number(`0.${decimals}`) : 0) || 1) * SCALES[w]!;
      current = 0;
      decimals = '';
      inDecimal = false;
    } else return null;
    seen = true;
  }
  if (!seen) return null;
  return total + current + (decimals ? Number(`0.${decimals}`) : 0);
}

const grouped = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export interface Normalised {
  /** The transcript with SSNs and card numbers removed. */
  text: string;
  /** What goes in the input box and, once the user agrees, to the Concierge. */
  normalised: string;
  identifiers: SpokenIdentifier[];
  redactions: string[];
}

export function normaliseTranscript(raw: string): Normalised {
  const redactions: string[] = [];
  const identifiers: SpokenIdentifier[] = [];
  let t = ` ${raw.trim()} `;

  // Spoken digit strings ("four five two one") become digits first, so they are not summed.
  const digitRun = new RegExp(`\\b(?:(?:${DIGIT_WORDS.join('|')})[\\s,-]+){2,}(?:${DIGIT_WORDS.join('|')})\\b`, 'gi');
  t = t.replace(digitRun, (m) => m.toLowerCase().split(/[\s,-]+/).map((w) => String(ONES[w] ?? '')).join(''));

  // Remove what must never be stored (spec 7.9), whether dictated or recognised as numerals.
  t = t.replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b(?=.{0,20}\b(social|ssn)\b)|\b(?:social security|ssn)\b[^\d]{0,20}\d{3}[- ]?\d{2}[- ]?\d{4}/gi, () => {
    redactions.push('SSN');
    return '[SSN removed]';
  });
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    redactions.push('SSN');
    return '[SSN removed]';
  });
  t = t.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, '');
    if (d.length < 13 || !luhn(d)) return m;
    redactions.push('CARD');
    return '[card number removed] ';
  });
  const text = t.trim();

  // Member and account numbers: keep only the last four, for an on-screen lookup.
  t = t.replace(/\b(member|customer|account|loan|share)(?:\s+(?:number|no\.?|#))?\s+(?:ending(?:\s+in)?\s+)?(\d{4,17})\b/gi, (_m, kind: string, digits: string) => {
    const last4 = digits.slice(-4);
    identifiers.push({ kind: /account|loan|share/i.test(kind) ? 'account' : 'member', last4 });
    return `${kind.toLowerCase()} …${last4}`;
  });

  // Report names spoken as digits, before the number words are summed.
  t = t.replace(/\b(?:five three hundred|fifty three hundred|5\s*300|5,300|53 hundred)\b(?:\s*call report)?/gi, '5300 Call Report');

  // Number words to numerals, when they are clearly a quantity.
  t = t.replace(/\b[a-z]+(?:[\s-]+[a-z]+)*\b/gi, (phrase) => {
    const words = phrase.split(/([\s-]+)/);
    let out = '';
    let i = 0;
    while (i < words.length) {
      const w = words[i]!.toLowerCase();
      // A run starts on a count; "thousand" after a numeral ("60 thousand") is handled below.
      if (!isNumberWord(w) || w === 'oh' || w in SCALES || w === 'hundred') {
        out += words[i];
        i++;
        continue;
      }
      let j = i;
      const run: string[] = [];
      while (j < words.length) {
        const x = words[j]!.toLowerCase();
        if (/^[\s-]+$/.test(x)) {
          j++;
          continue;
        }
        if (isNumberWord(x) || ((x === 'point' || x === 'and') && run.length)) {
          run.push(x);
          j++;
        } else break;
      }
      while (run.length && (run.at(-1) === 'and' || run.at(-1) === 'point')) {
        run.pop();
        j -= 2;
      }
      const next = words.slice(j).find((x) => !/^[\s-]+$/.test(x)) ?? '';
      const value = parseWords(run);
      const quantity = run.length > 1 || UNITS.test(next) || value! >= 10;
      if (value === null || !quantity) {
        out += words.slice(i, j).join('');
      } else {
        out += grouped(value);
        // Keep the separator before the next word.
        const sep = words[j - 1] && /^[\s-]+$/.test(words[j - 1]!) ? words[j - 1] : '';
        out += sep;
      }
      i = j;
    }
    return out;
  });

  t = t
    // Money: "2.5 million dollars", "$2.5 million", "60,000 dollars".
    .replace(/(\$\s?)?(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion)\b(?:\s*(dollars?|bucks)\b)?/gi, (_m, dollar: string | undefined, n: string, scale: string, word: string | undefined) => {
      const v = Number(n.replace(/,/g, '')) * SCALES[scale.toLowerCase()]!;
      return `${dollar || word ? '$' : ''}${grouped(v)}`;
    })
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks)\b/gi, (_m, n: string) => `$${grouped(Number(n.replace(/,/g, '')))}`)
    // Basis points.
    .replace(/(\d+)\s*(?:bips|bps|basis points?)\b/gi, (_m, n: string) => `${(Number(n) / 100).toFixed(2)}% (${n} bp)`)
    .replace(/(\d+(?:\.\d+)?)\s*percent\b/gi, '$1%')
    // Quarters.
    .replace(/\b(?:q|quarter)\s*(one|two|three|four|1|2|3|4)\b/gi, (_m, q: string) => `Q${ONES[q.toLowerCase()] ?? q}`)
    .replace(/\b(first|second|third|fourth)\s+quarter\b/gi, (_m, o: string) => `Q${ORDINAL_QUARTER[o.toLowerCase()]}`)
    // Delinquency buckets and report names.
    .replace(/\b(\d{2,3})\s*plus\b/gi, '$1+');

  const normalised = t.replace(/\s+/g, ' ').trim();
  return { text, normalised: normalised ? normalised[0]!.toUpperCase() + normalised.slice(1) : '', identifiers, redactions };
}

/** Spoken confirmation of a visible approval card (spec 7.6). Hedged answers do not count. */
export function classifyConfirmation(text: string): 'confirm' | 'deny' | 'ambiguous' | null {
  const t = text.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\b(but|maybe|guess|not sure|wait|hmm|unless|if)\b/.test(t)) return 'ambiguous';
  if (/^(confirm|confirmed|yes confirm|yes do it|yes go ahead|approve|approve it|send it|yes send it)$/.test(t)) return 'confirm';
  if (/^(cancel|deny|no|no don't|don't send it|stop)$/.test(t)) return 'deny';
  if (/^(sure|ok|okay|yeah|yep|yes|fine|alright|i think so|sounds good)$/.test(t)) return 'ambiguous';
  return null;
}
