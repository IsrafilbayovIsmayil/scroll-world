/**
 * Dense order keys (fractional indexing).
 *
 * History is not an array with integer indices, because an integer index makes
 * "insert into the past" an O(n) renumbering that changes the identity of every
 * later intent. Instead every intent carries a rational position encoded as a
 * base-62 digit string compared lexicographically. Between any two keys there
 * is always another key, so the past is infinitely subdividable and inserting
 * never touches a neighbour.
 *
 * Invariant: a key never ends in the minimum digit '0', which guarantees
 * `between(k, null)`-style descent always terminates.
 */

export type OrderKey = string;

const D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = D.length; // 62; charCode order == digit order

function digit(c: string): number {
  const i = D.indexOf(c);
  if (i < 0) throw new Error(`retcon/order: illegal digit ${JSON.stringify(c)}`);
  return i;
}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`retcon/order: disordered ${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) {
    throw new Error('retcon/order: key ends in minimum digit');
  }

  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const lo = a.length > 0 ? digit(a[0]!) : 0;
  const hi = b !== null ? digit(b[0]!) : BASE;

  if (hi - lo > 1) return D[Math.round(0.5 * (lo + hi))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return D[lo]! + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b`. Either bound may be null (open). */
export function between(a: OrderKey | null, b: OrderKey | null): OrderKey {
  if (a === null && b === null) return 'V';
  if (a === null) return midpoint('', b!);
  return midpoint(a, b);
}

export function compareKeys(a: OrderKey, b: OrderKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
