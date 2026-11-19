// Comparing words that may be misspelled: used to match people (phase 8) and to propose what an
// institution's own word means (phase 11).

/** Jaro-Winkler similarity of two strings, from 0 to 1: high for a typo, a dropped or swapped letter. */
export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let swaps = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) swaps++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - swaps / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Whether two words are one slip apart: a letter dropped, added, changed, or two neighbours swapped. */
export function oneSlipApart(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: string, y: string) => x === y;
  if (a.length === b.length) return rest(a.slice(i + 1), b.slice(i + 1)) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(a.slice(i + 2), b.slice(i + 2)));
  return a.length > b.length ? rest(a.slice(i + 1), b.slice(i)) : rest(a.slice(i), b.slice(i + 1));
}
