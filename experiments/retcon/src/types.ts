import type { Hash } from './hash.js';
import type { OrderKey } from './order.js';

export type IntentId = Hash;

/**
 * An INTENT is a thing someone meant, placed at a position in history.
 * It is not a fact about the world; it is an instruction that, when folded,
 * produces facts. Intents are the only mutable layer of the system.
 */
export interface Intent<K extends string = string, P = unknown> {
  readonly id: IntentId;
  readonly kind: K;
  readonly payload: P;
  /** Dense rank. Total order over history. Unique per chronicle. */
  readonly at: OrderKey;
  readonly author: string;
  /** Advisory wall-clock. Never used for ordering. */
  readonly wall: number;
}

/**
 * An EFFECT is a demand on the outside world produced by folding an intent.
 * `key` is the effect's *world identity*: two effects with the same kind and
 * key denote the same slot in reality (the same row, the same payment, the
 * same message thread). Differing payloads under one key mean the world was
 * told two different things about the same slot.
 */
export interface Effect<K extends string = string, P = unknown> {
  readonly kind: K;
  readonly key: string;
  readonly payload: P;
}

export interface Transition<S> {
  readonly state: S;
  readonly effects?: readonly Effect[];
}

/** Must be pure and deterministic. This is the whole contract. */
export type Reducer<S> = (state: S, intent: Intent) => Transition<S>;

/**
 * How an effect behaves when history is rewritten such that it should never
 * have happened.
 *
 *  invertible  — an exact inverse act exists (credit a debit, delete a row).
 *  corrective  — the act cannot be undone, but a public correction can be
 *                issued (a retraction, an amended statement). The world saw
 *                the wrong thing, so this still leaves a scar.
 *  indelible   — nothing can be done. Pure scar.
 *
 * Unknown effect kinds default to `indelible`. Irreversibility is the safe
 * assumption; claiming reversibility is a privilege the author must assert.
 */
export type EffectLaw =
  | { readonly mode: 'invertible'; readonly invert: (e: Effect) => Effect }
  | { readonly mode: 'corrective'; readonly correct: (e: Effect) => Effect }
  | { readonly mode: 'indelible' };

export type EffectLaws = Readonly<Record<string, EffectLaw>>;

/**
 * A SCAR records that the past was changed in a way reality could not absorb.
 * The chronicle is mutable; the scar ledger is append-only. Retconning a
 * retcon does not remove a scar — it adds another. The ledger is the fixed
 * point of "the part of the past you do not actually get to change".
 */
export interface Scar {
  readonly id: Hash;
  readonly kind: 'withdrawn-indelible' | 'withdrawn-corrected';
  readonly effect: Effect;
  readonly at: OrderKey;
  /** Chronicle revision at which this scar was cut. Monotonic. */
  readonly revision: number;
  readonly note: string;
}

/** One step of the reconciliation plan: how to move reality from H to H'. */
export type Reconcile =
  | { readonly op: 'apply'; readonly effect: Effect }
  /** Present in both timelines. Deliberately a no-op: do NOT re-send it. */
  | { readonly op: 'retain'; readonly effect: Effect }
  | { readonly op: 'revoke'; readonly effect: Effect; readonly inverse: Effect }
  | { readonly op: 'correct'; readonly effect: Effect; readonly correction: Effect; readonly scar: Scar }
  | { readonly op: 'scar'; readonly effect: Effect; readonly scar: Scar };

/** Adapter that actually touches reality. */
export interface World {
  perform(effect: Effect, reason: 'apply' | 'revoke' | 'correct'): void;
}

export interface RetconReport {
  /** Index where re-folding began. */
  readonly divergenceStart: number;
  /** Index where the convergence cutoff fired, or null if the fold ran out. */
  readonly convergedAt: number | null;
  readonly historyLength: number;
  /** Intents actually re-reduced. */
  readonly recomputed: number;
  /** Intents proven identical and reused without reduction. */
  readonly reused: number;
  readonly plan: readonly Reconcile[];
  readonly newScars: readonly Scar[];
  readonly headBefore: Hash;
  readonly headAfter: Hash;
}
