import { describe, expect, test } from 'bun:test';
import { Chronicle } from '../src/index.js';
import { actIdentity } from '../src/effects.js';
import { between, compareKeys } from '../src/order.js';
import { structuralHash } from '../src/hash.js';
import type { Effect, EffectLaws, Intent, Transition } from '../src/types.js';

// ------------------------------------------------------------------ fixture

interface Store {
  readonly kv: Readonly<Record<string, number>>;
  readonly n: number;
}
const GENESIS: Store = { kv: {}, n: 0 };

function reduce(s: Store, i: Intent): Transition<Store> {
  switch (i.kind) {
    case 'set': {
      const p = i.payload as { k: string; v: number };
      return { state: { kv: { ...s.kv, [p.k]: p.v }, n: s.n + 1 } };
    }
    case 'bump': {
      const p = i.payload as { k: string };
      return { state: { kv: { ...s.kv, [p.k]: (s.kv[p.k] ?? 0) + 1 }, n: s.n + 1 } };
    }
    case 'del': {
      const p = i.payload as { k: string };
      const kv = { ...s.kv };
      delete kv[p.k];
      return { state: { kv, n: s.n + 1 } };
    }
    case 'emit': {
      const p = i.payload as { tag: string };
      const eff: Effect = { kind: 'row', key: p.tag, payload: { ...s.kv } };
      return { state: { ...s, n: s.n + 1 }, effects: [eff] };
    }
    default:
      return { state: s };
  }
}

/** Same fixture without the monotone step counter, so state can reconverge. */
function reduceNoCounter(s: Store, i: Intent): Transition<Store> {
  const t = reduce(s, i);
  return { state: { ...t.state, n: 0 }, effects: t.effects };
}

const laws: EffectLaws = {
  row: { mode: 'invertible', invert: (e) => ({ kind: 'row.delete', key: e.key, payload: e.payload }) },
  mail: { mode: 'indelible' },
};

/** Reference implementation: fold the whole history, no memoization, no cutoff. */
function naive(history: readonly Intent[]): { state: Store; effects: Effect[] } {
  let state = GENESIS;
  const effects: Effect[] = [];
  for (const i of history) {
    const t = reduce(state, i);
    state = t.state;
    effects.push(...(t.effects ?? []));
  }
  return { state, effects };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------------- order

describe('dense order', () => {
  test('between always lands strictly inside, for 2000 random inserts', () => {
    const rnd = mulberry(7);
    const keys: string[] = [between(null, null)];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(rnd() * (keys.length + 1));
      const lo = at > 0 ? keys[at - 1]! : null;
      const hi = at < keys.length ? keys[at]! : null;
      const k = between(lo, hi);
      if (lo !== null) expect(compareKeys(lo, k)).toBe(-1);
      if (hi !== null) expect(compareKeys(k, hi)).toBe(-1);
      keys.splice(at, 0, k);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------- retrofold

describe('retrofold', () => {
  test('convergence cutoff never changes the answer (randomized)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry(seed);
      const c = new Chronicle<Store>({ genesis: GENESIS, reduce, laws });
      const keyspace = ['a', 'b', 'c', 'd'];

      const mint = () => {
        const roll = rnd();
        if (roll < 0.4) return ['set', { k: keyspace[(rnd() * 4) | 0]!, v: (rnd() * 50) | 0 }] as const;
        if (roll < 0.6) return ['bump', { k: keyspace[(rnd() * 4) | 0]! }] as const;
        if (roll < 0.75) return ['del', { k: keyspace[(rnd() * 4) | 0]! }] as const;
        return ['emit', { tag: `t${(rnd() * 3) | 0}` }] as const;
      };

      for (let i = 0; i < 25; i++) {
        const [kind, payload] = mint();
        c.append(kind, payload);
      }

      for (let step = 0; step < 40; step++) {
        const h = c.history();
        const target = h[(rnd() * h.length) | 0]!;
        const roll = rnd();
        const [kind, payload] = mint();
        if (roll < 0.35) c.insertBefore(target.id, kind, payload);
        else if (roll < 0.6) c.insertAfter(target.id, kind, payload);
        else if (roll < 0.8 && h.length > 2) c.excise(target.id);
        else c.amend(target.id, payload);

        const ref = naive(c.history());
        expect(structuralHash(c.head())).toBe(structuralHash(ref.state));
        expect(c.effects().map(actIdentity)).toEqual(ref.effects.map(actIdentity));
      }
    }
  });

  test('an edit overwritten downstream costs O(1) reductions in a long history', () => {
    const c = new Chronicle<Store>({ genesis: GENESIS, reduce: reduceNoCounter, laws });
    for (let i = 0; i < 500; i++) c.append('set', { k: 'x', v: i });

    const first = c.history()[0]!.id;
    const r = c.insertBefore(first, 'set', { k: 'x', v: 999 });

    expect(r.historyLength).toBe(501);
    expect(r.recomputed).toBeLessThanOrEqual(3);
    expect(r.convergedAt).not.toBeNull();
    expect(r.plan).toHaveLength(0);
    expect(c.head().kv.x).toBe(499);
  });

  test('a monotone accumulator in state defeats the cutoff, by design', () => {
    // `reduce` bumps `n` on every intent, so no two timelines of different
    // length can ever share a state hash. The engine degrades to a full refold
    // and stays correct; reconvergence is a property of the STATE DESIGN, not
    // something the engine can manufacture.
    const c = new Chronicle<Store>({ genesis: GENESIS, reduce, laws });
    for (let i = 0; i < 100; i++) c.append('set', { k: 'x', v: i });
    const r = c.insertBefore(c.history()[0]!.id, 'set', { k: 'x', v: 999 });
    expect(r.convergedAt).toBeNull();
    expect(r.recomputed).toBe(101);
    expect(r.plan).toHaveLength(0); // still no world traffic: effects are unchanged
  });

  test('a consequential edit propagates and the cutoff does not fire', () => {
    const c = new Chronicle<Store>({ genesis: GENESIS, reduce, laws });
    c.append('set', { k: 'x', v: 1 });
    for (let i = 0; i < 20; i++) c.append('bump', { k: 'x' });
    c.append('emit', { tag: 'final' });

    const first = c.history()[0]!.id;
    const r = c.amend(first, { k: 'x', v: 100 });

    expect(r.convergedAt).toBeNull();
    expect(r.recomputed).toBe(22);
    expect(c.head().kv.x).toBe(120);
    expect(r.plan.map((p) => p.op).sort()).toEqual(['apply', 'revoke']);
  });
});

// ------------------------------------------------------------- reconcile

describe('reconciliation', () => {
  test('surviving effects are retained, never re-performed', () => {
    const performed: string[] = [];
    const c = new Chronicle<Store>({
      genesis: GENESIS,
      reduce,
      laws,
      world: { perform: (e, why) => void performed.push(`${why}:${e.kind}:${e.key}`) },
    });
    c.append('set', { k: 'a', v: 1 });
    c.append('emit', { tag: 'stable' });
    c.append('set', { k: 'b', v: 2 });
    c.append('emit', { tag: 'volatile' });

    performed.length = 0;
    // Changing `b` only affects the second emit; the first must be untouched.
    const bId = c.history()[2]!.id;
    const r = c.amend(bId, { k: 'b', v: 99 });

    const stable = r.plan.filter((p) => p.effect.key === 'stable');
    expect(stable).toHaveLength(0); // outside the divergence window entirely
    expect(performed.some((p) => p.endsWith(':stable'))).toBe(false);
    expect(performed).toEqual(['revoke:row.delete:volatile', 'apply:row:volatile']);
  });

  test('withdrawing an indelible effect cuts a scar that never heals', () => {
    const c = new Chronicle<Store>({
      genesis: GENESIS,
      reduce: (s, i) =>
        i.kind === 'notify'
          ? { state: { ...s, n: s.n + 1 }, effects: [{ kind: 'mail', key: 'm1', payload: i.payload }] }
          : reduce(s, i),
      laws,
    });
    c.append('notify', { body: 'wrong' });
    expect(c.scars()).toHaveLength(0);

    const id = c.history()[0]!.id;
    c.amend(id, { body: 'right' });
    expect(c.scars()).toHaveLength(1);
    expect(c.scars()[0]!.kind).toBe('withdrawn-indelible');

    // Put it back exactly as it was: state returns, the scar does not leave.
    const id2 = c.history()[0]!.id;
    c.amend(id2, { body: 'wrong' });
    expect(c.scars().length).toBeGreaterThanOrEqual(2);
  });

  test('unknown effect kinds are treated as indelible', () => {
    const c = new Chronicle<Store>({
      genesis: GENESIS,
      reduce: (s, i) => ({
        state: { ...s, n: s.n + 1 },
        effects: [{ kind: 'launch.missile', key: 'k', payload: i.payload }],
      }),
      laws: {},
    });
    c.append('go', { at: 1 });
    const r = c.amend(c.history()[0]!.id, { at: 2 });
    expect(r.plan.find((p) => p.op === 'scar')).toBeDefined();
  });
});
