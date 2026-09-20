import { mix, structuralHash, type Hash } from './hash.js';
import type { Effect, EffectLaws, Reconcile, Scar } from './types.js';
import type { OrderKey } from './order.js';

/**
 * An effect's *act identity*. Two effects with the same identity are the same
 * act performed on the world; the reconciler will never perform it twice and
 * never withdraw it if it survives the rewrite.
 */
export function actIdentity(e: Effect): string {
  return `${e.kind}\u0000${e.key}\u0000${structuralHash(e.payload)}`;
}

interface Tally {
  readonly effect: Effect;
  count: number;
}

function tally(effects: readonly Effect[]): Map<string, Tally> {
  const m = new Map<string, Tally>();
  for (const e of effects) {
    const id = actIdentity(e);
    const cur = m.get(id);
    if (cur) cur.count++;
    else m.set(id, { effect: e, count: 1 });
  }
  return m;
}

/**
 * RECONCILE — the heart of the primitive.
 *
 * Rollback-and-replay asks "what happened, and how do I redo it?". That
 * re-performs every surviving effect: the invoice is emailed twice, the
 * webhook fires twice, the row is written twice.
 *
 * Reconciliation instead asks "what is the *difference* between the world as
 * if H happened and the world as if H' happened?" — a multiset difference over
 * act identities. Effects present in both timelines are `retain`ed, which
 * means: touch nothing. Only the symmetric difference reaches reality.
 *
 * Cost is proportional to the size of the effect delta, not to the length of
 * history and not to the number of surviving effects.
 */
export function reconcile(
  before: readonly Effect[],
  after: readonly Effect[],
  laws: EffectLaws,
  ctx: { readonly at: OrderKey; readonly revision: number },
): { plan: Reconcile[]; scars: Scar[] } {
  const oldT = tally(before);
  const newT = tally(after);
  const plan: Reconcile[] = [];
  const scars: Scar[] = [];

  // Withdrawals first: unmake the false world before asserting the true one.
  for (const [id, o] of oldT) {
    const n = newT.get(id);
    const surviving = n ? Math.min(o.count, n.count) : 0;
    for (let k = surviving; k < o.count; k++) {
      plan.push(withdraw(o.effect, laws, ctx, scars));
    }
  }

  for (const [id, o] of oldT) {
    const n = newT.get(id);
    if (!n) continue;
    for (let k = 0; k < Math.min(o.count, n.count); k++) {
      plan.push({ op: 'retain', effect: o.effect });
    }
  }

  for (const [id, n] of newT) {
    const o = oldT.get(id);
    const already = o ? Math.min(o.count, n.count) : 0;
    for (let k = already; k < n.count; k++) {
      plan.push({ op: 'apply', effect: n.effect });
    }
  }

  return { plan, scars };
}

function withdraw(
  effect: Effect,
  laws: EffectLaws,
  ctx: { readonly at: OrderKey; readonly revision: number },
  scars: Scar[],
): Reconcile {
  const law = laws[effect.kind] ?? { mode: 'indelible' as const };

  if (law.mode === 'invertible') {
    return { op: 'revoke', effect, inverse: law.invert(effect) };
  }

  const kind: Scar['kind'] =
    law.mode === 'corrective' ? 'withdrawn-corrected' : 'withdrawn-indelible';

  const scar: Scar = {
    id: scarId(effect, ctx.revision, kind),
    kind,
    effect,
    at: ctx.at,
    revision: ctx.revision,
    note:
      law.mode === 'corrective'
        ? `${effect.kind}(${effect.key}) could not be undone; a correction was issued.`
        : `${effect.kind}(${effect.key}) happened in a timeline that no longer exists and cannot be undone.`,
  };
  scars.push(scar);

  return law.mode === 'corrective'
    ? { op: 'correct', effect, correction: law.correct(effect), scar }
    : { op: 'scar', effect, scar };
}

function scarId(effect: Effect, revision: number, kind: string): Hash {
  return mix('scar', kind, actIdentity(effect), String(revision));
}
