import { EMPTY_HASH, mix, structuralHash, type Hash } from './hash.js';
import { between, type OrderKey } from './order.js';
import { reconcile } from './effects.js';
import type {
  Effect,
  EffectLaws,
  Intent,
  Reconcile,
  Reducer,
  RetconReport,
  Scar,
  World,
} from './types.js';

/**
 * A VERTEBRA memoizes one step of the fold: the state entering the intent,
 * the state leaving it, and the effects it demanded. The spine is the list of
 * vertebrae. Because state snapshots are persistent and hashes are memoized by
 * reference, keeping every intermediate state is cheap.
 */
interface Vertebra<S> {
  readonly intent: Intent;
  readonly pre: Hash;
  readonly post: Hash;
  readonly state: S;
  readonly effects: readonly Effect[];
}

export interface ChronicleOptions<S> {
  readonly genesis: S;
  readonly reduce: Reducer<S>;
  readonly laws?: EffectLaws;
  readonly world?: World;
  readonly author?: string;
  readonly clock?: () => number;
}

/**
 * NOTE ON STATE DESIGN. The cutoff (I2 below) can only fire if two timelines of
 * different length are *capable* of reaching an identical state. A monotone
 * accumulator inside folded state - a step counter, a `lastUpdated` stamp, an
 * append-only log of every event - makes that impossible, and the engine
 * degrades to a full refold. It stays correct; it stops being cheap. Keep
 * derived-and-discardable data out of folded state.
 */

/**
 * CHRONICLE — a runtime whose past is a mutable, densely-ordered sequence of
 * intents and whose present is a pure fold over it.
 *
 * Three invariants hold together and are what make the thing work:
 *
 *  I1. PRESENT = FOLD(PAST). There is no independently-stored "current state".
 *      Editing the past is therefore a legal operation, not a corruption.
 *
 *  I2. CONVERGENCE CUTOFF. After an edit, re-folding stops the moment the
 *      recomputed state entering some intent hashes equal to the state that
 *      entered that same intent before, provided the remaining intent sequence
 *      is identical. From there on the fold is provably a repeat, so the old
 *      spine suffix is spliced in verbatim. Cost becomes O(divergence window),
 *      not O(|history|). An edit whose consequences are later overwritten is
 *      close to free no matter how deep in the past it lands.
 *
 *  I3. EFFECTS ARE RECONCILED, NOT REPLAYED. Reality is moved from "as if H"
 *      to "as if H'" by a multiset difference over effects. Surviving effects
 *      are never re-performed. Withdrawn effects that reality cannot take back
 *      become scars, and the scar ledger only ever grows.
 */
export class Chronicle<S> {
  private readonly genesis: S;
  private readonly genesisHash: Hash;
  private readonly reducer: Reducer<S>;
  private readonly laws: EffectLaws;
  private readonly world: World | null;
  private readonly defaultAuthor: string;
  private readonly clock: () => number;

  private spine: Vertebra<S>[] = [];
  /** suffixIds[k] = digest of the intent-id sequence from k to the end. */
  private suffixIds: Hash[] = [EMPTY_HASH];
  private readonly scarLedger = new Map<Hash, Scar>();
  private revision = 0;

  constructor(opts: ChronicleOptions<S>) {
    this.genesis = opts.genesis;
    this.genesisHash = structuralHash(opts.genesis);
    this.reducer = opts.reduce;
    this.laws = opts.laws ?? {};
    this.world = opts.world ?? null;
    this.defaultAuthor = opts.author ?? 'anon';
    this.clock = opts.clock ?? Date.now;
  }

  // ---------------------------------------------------------------- reading

  /** The present. Always exactly fold(genesis, history). */
  head(): S {
    return this.spine.length === 0 ? this.genesis : this.spine[this.spine.length - 1]!.state;
  }

  headHash(): Hash {
    return this.spine.length === 0 ? this.genesisHash : this.spine[this.spine.length - 1]!.post;
  }

  history(): readonly Intent[] {
    return this.spine.map((v) => v.intent);
  }

  /** The state as it stood immediately after `intentId`. Free; already memoized. */
  stateAfter(intentId: string): S | undefined {
    return this.spine.find((v) => v.intent.id === intentId)?.state;
  }

  /** Every effect the current timeline demands, in fold order. */
  effects(): readonly Effect[] {
    const out: Effect[] = [];
    for (const v of this.spine) out.push(...v.effects);
    return out;
  }

  /** Append-only. Grows across retcons, never shrinks. */
  scars(): readonly Scar[] {
    return [...this.scarLedger.values()].sort((a, b) =>
      a.revision - b.revision || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0),
    );
  }

  // ---------------------------------------------------------------- writing

  /** Place an intent after everything that currently exists. */
  append<P>(kind: string, payload: P, author?: string): RetconReport {
    const last = this.spine.at(-1)?.intent.at ?? null;
    return this.place(this.mint(kind, payload, between(last, null), author));
  }

  /** Place an intent into the past, immediately before `targetId`. */
  insertBefore<P>(targetId: string, kind: string, payload: P, author?: string): RetconReport {
    const i = this.indexOf(targetId);
    const lo = i > 0 ? this.spine[i - 1]!.intent.at : null;
    const hi = this.spine[i]!.intent.at;
    return this.place(this.mint(kind, payload, between(lo, hi), author));
  }

  /** Place an intent into the past, immediately after `targetId`. */
  insertAfter<P>(targetId: string, kind: string, payload: P, author?: string): RetconReport {
    const i = this.indexOf(targetId);
    const lo = this.spine[i]!.intent.at;
    const hi = i + 1 < this.spine.length ? this.spine[i + 1]!.intent.at : null;
    return this.place(this.mint(kind, payload, between(lo, hi), author));
  }

  /** Remove an intent from the past, as though it had never been meant. */
  excise(targetId: string): RetconReport {
    const i = this.indexOf(targetId);
    const next = this.history().filter((_, k) => k !== i);
    return this.rewrite(next);
  }

  /** Replace an intent's payload in place, keeping its position. */
  amend<P>(targetId: string, payload: P): RetconReport {
    const i = this.indexOf(targetId);
    const old = this.spine[i]!.intent;
    const next = this.history().slice();
    next[i] = this.mint(old.kind, payload, old.at, old.author);
    return this.rewrite(next);
  }

  // --------------------------------------------------------------- internal

  private indexOf(intentId: string): number {
    const i = this.spine.findIndex((v) => v.intent.id === intentId);
    if (i < 0) throw new Error(`retcon: no such intent ${intentId}`);
    return i;
  }

  private mint<P>(kind: string, payload: P, at: OrderKey, author?: string): Intent {
    const who = author ?? this.defaultAuthor;
    // Content address. `at` is unique by construction, so ids are unique too.
    const id = mix('intent', kind, structuralHash(payload), at, who);
    return { id, kind, payload, at, author: who, wall: this.clock() };
  }

  private place(intent: Intent): RetconReport {
    const next = this.history().slice();
    let i = next.length;
    while (i > 0 && next[i - 1]!.at > intent.at) i--;
    next.splice(i, 0, intent);
    return this.rewrite(next);
  }

  /**
   * RETROFOLD — the primary transformation.
   *
   *   1. Share the longest common prefix with the existing spine (by intent id).
   *   2. Re-reduce forward from the divergence point.
   *   3. At every step, test the convergence cutoff:
   *
   *        pre(new, j) == pre(old, sameIntent)  AND  suffixIds equal
   *
   *      Purity of the reducer makes the rest of the fold a bit-identical
   *      repeat, so splice the old suffix in without touching it.
   *   4. Diff the effects of the *changed window only* and reconcile.
   *
   * Complexity: O(d) reductions where d is the divergence window, plus O(e)
   * for an effect delta of size e. Independent of |history| beyond the O(n)
   * id-level bookkeeping, which involves no user code.
   */
  private rewrite(next: readonly Intent[]): RetconReport {
    const headBefore = this.headHash();
    const oldSpine = this.spine;
    const oldSuffix = this.suffixIds;
    const newSuffix = suffixIds(next);

    // Position of each old intent, for the cutoff's identity lookup.
    const oldPos = new Map<string, number>();
    for (let k = 0; k < oldSpine.length; k++) oldPos.set(oldSpine[k]!.intent.id, k);

    // (1) shared prefix
    let i = 0;
    while (i < oldSpine.length && i < next.length && oldSpine[i]!.intent.id === next[i]!.id) i++;

    let state: S = i === 0 ? this.genesis : oldSpine[i - 1]!.state;
    let stateHash: Hash = i === 0 ? this.genesisHash : oldSpine[i - 1]!.post;

    // (2)+(3) re-fold with cutoff
    const rebuilt: Vertebra<S>[] = [];
    let convergedAt: number | null = null;
    let reusedTail: Vertebra<S>[] = [];

    let j = i;
    for (; j < next.length; j++) {
      const intent = next[j]!;
      const p = oldPos.get(intent.id);
      if (p !== undefined && oldSpine[p]!.pre === stateHash && oldSuffix[p] === newSuffix[j]) {
        convergedAt = j;
        reusedTail = oldSpine.slice(p);
        break;
      }
      const t = this.reducer(state, intent);
      const post = structuralHash(t.state);
      rebuilt.push({ intent, pre: stateHash, post, state: t.state, effects: t.effects ?? [] });
      state = t.state;
      stateHash = post;
    }

    const newSpine = [...oldSpine.slice(0, i), ...rebuilt, ...reusedTail];

    // (4) effect delta over the changed window only
    const reusedIds = new Set(reusedTail.map((v) => v.intent.id));
    const beforeEffects: Effect[] = [];
    for (let k = i; k < oldSpine.length; k++) {
      const v = oldSpine[k]!;
      if (!reusedIds.has(v.intent.id)) beforeEffects.push(...v.effects);
    }
    const afterEffects: Effect[] = [];
    for (const v of rebuilt) afterEffects.push(...v.effects);

    this.revision++;
    const anchor = next[i]?.at ?? oldSpine[i]?.intent.at ?? 'V';
    const { plan, scars } = reconcile(beforeEffects, afterEffects, this.laws, {
      at: anchor,
      revision: this.revision,
    });

    // Commit: spine first, then reality, then the scar ledger.
    this.spine = newSpine;
    this.suffixIds = newSuffix;
    this.perform(plan);
    for (const s of scars) if (!this.scarLedger.has(s.id)) this.scarLedger.set(s.id, s);

    return {
      divergenceStart: i,
      convergedAt,
      historyLength: newSpine.length,
      recomputed: rebuilt.length,
      reused: newSpine.length - rebuilt.length,
      plan,
      newScars: scars,
      headBefore,
      headAfter: this.headHash(),
    };
  }

  private perform(plan: readonly Reconcile[]): void {
    if (!this.world) return;
    for (const step of plan) {
      switch (step.op) {
        case 'revoke':
          this.world.perform(step.inverse, 'revoke');
          break;
        case 'correct':
          this.world.perform(step.correction, 'correct');
          break;
        case 'apply':
          this.world.perform(step.effect, 'apply');
          break;
        // 'retain' and 'scar' deliberately touch nothing.
      }
    }
  }
}

function suffixIds(intents: readonly Intent[]): Hash[] {
  const out = new Array<Hash>(intents.length + 1);
  out[intents.length] = EMPTY_HASH;
  for (let k = intents.length - 1; k >= 0; k--) out[k] = mix(intents[k]!.id, out[k + 1]!);
  return out;
}
