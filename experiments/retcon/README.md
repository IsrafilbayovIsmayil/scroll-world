# Retcon

**A runtime whose past is editable and whose side effects are reconciled instead of replayed.**

Zero dependencies. `bun test` · `bun demo/payroll.ts` · `bunx tsc --noEmit`

---

## The primitive

Every system that keeps history treats the log as **append-only**. Event sourcing,
Git, WALs, audit trails, CRDT op-logs: you may add to the end, you may branch, you
may compensate forward. You may not reach into the middle of what happened and
change it.

That restriction is not a law of computation. It is an artifact of two unsolved
costs:

1. **Recompute cost.** If the present is a fold over the past, editing position *k*
   invalidates the fold from *k* to now — O(n) per keystroke into history.
2. **Effect cost.** The old timeline already touched reality. Naively you must roll
   everything back and replay it, which re-sends every email and re-fires every
   webhook that was going to happen anyway.

Retcon removes both.

**Novel mechanism.** History is a densely-ordered sequence of *intents*; the present
is nothing but `fold(genesis, history)`. Inserting, excising, or amending an intent
mid-history is a first-class operation. The re-fold terminates early the instant the
recomputed state hashes equal to what it was — so an edit whose consequences are
overwritten downstream is nearly free, no matter how deep in the past it lands. And
reality is not rolled back: the engine takes the **multiset difference between the
effects of the old timeline and the effects of the new one**, so surviving effects
are never re-performed. Effects that reality cannot take back become **scars** — an
append-only ledger that is the fixed point of the part of the past you do not
actually get to change.

## Why now

Every ingredient is individually old. None of them was worth combining until the
last few years.

| Ingredient | Why it wasn't enough alone |
| --- | --- |
| Event sourcing | Log is append-only *by definition*; a mid-log edit invalidates every projection at O(n). |
| Time-travel debuggers (`rr`, Redux DevTools) | Rewind and **replay**. They can show you the past; they cannot rewrite it and keep the world consistent, because replay re-performs effects. |
| Sagas / compensating transactions | Solve rollback, but hand-written per workflow. Never lifted into a general fold. |
| Retroactive data structures (Demaine et al., 2004) | Beautiful theory, bad general bounds, and no story at all for side effects. |
| Fractional indexing (CRDT lineage) | Gives a dense mutable order — but only landed in mainstream practice in the 2020s. |

What closes the gap is the pairing of **memoized structural hashing over persistent
state** (state identity in O(1), re-hash after a small edit in O(path)) with
**effect-set differencing**. The first makes the convergence cutoff possible; the
second makes the cutoff *worth having*, because a short divergence window means a
small effect delta means almost no world traffic. Neither half works without the other.

## The three invariants

- **I1 — present = fold(past).** There is no separately stored "current state", so
  editing the past is a legal operation rather than a corruption.
- **I2 — convergence cutoff.** Re-folding stops the moment the recomputed state
  entering some intent hashes equal to the state that entered that same intent
  before, *provided the remaining intent sequence is identical* (checked in O(1) via
  a rolling suffix digest of intent ids). Purity of the reducer makes the rest of the
  fold a bit-identical repeat, so the old spine suffix is spliced in untouched.
- **I3 — effects are reconciled, not replayed.** Reality moves from "as if H" to "as
  if H′" by a multiset difference over *act identity* (`kind + key + hash(payload)`).
  Cost is proportional to the effect delta, not to history length and not to the
  number of surviving effects.

## Effect law

An effect declares how it behaves when history is rewritten so that it should never
have happened:

| Mode | Meaning | Withdrawal |
| --- | --- | --- |
| `invertible` | An exact inverse act exists | emit the inverse |
| `corrective` | Cannot be undone, but a public correction can be issued | emit the correction **and cut a scar** |
| `indelible` | Nothing can be done | cut a scar |

Unknown effect kinds default to `indelible`. Irreversibility is the safe assumption;
claiming reversibility is a privilege the author must assert.

A `corrective` withdrawal still scars. The clawback may succeed, but the world
*saw* the wrong number, and pretending otherwise is the failure mode this primitive
exists to prevent.

## Scars

The chronicle is mutable. The scar ledger is not. Retconning a retcon does not remove
a scar — it adds another. This is the honest accounting of a mutable past:

```
scars after undoing the retcon: 4   ← they do not heal
```

## Designing state so the cutoff fires

The cutoff is only as good as your state's capacity to reconverge. A monotone
accumulator in state — a step counter, a `lastUpdated` timestamp, an append-only
array of every event — makes two timelines of different length *permanently*
distinguishable, and the engine degrades to a full refold. It stays correct; it just
stops being cheap. Keep derived-and-discardable data out of folded state, and the
cutoff fires constantly, because most edits to the past are overwritten by something
later.

Both behaviours are pinned in `tests/retrofold.test.ts`.

## Layout

```
src/hash.ts        memoized structural hashing (state identity in O(1))
src/order.ts       dense order keys — the past is infinitely subdividable
src/types.ts       Intent / Effect / EffectLaw / Scar / Reconcile schema
src/effects.ts     the reconciler: multiset difference over act identity
src/chronicle.ts   the engine: retrofold + convergence cutoff
demo/payroll.ts    a month of payroll, then two edits to the past
tests/             randomized equivalence against a naive full refold
```

## Measured on the demo

```
RETCON 1 — insert `rate 999` four steps back, overwritten downstream
   fold: recomputed=2 reused=4 cutoff=@3 | plan: (empty)
   → 5 surviving intents, 2 re-reduced, 0 effects replayed

RETCON 2 — insert `rate 120` just before month close
   revoke  ledger.write(3000)        ← exact inverse
   correct payment.send(3000)        ← clawback + scar
   scar    receipt.email(3000)       ← indelible; the world saw it
   retain  calendar.mark(2026-03)    ← identical in both timelines: NOT re-performed
   apply   ledger.write / payment.send / receipt.email (3600)
```

`retain` is the whole thesis in one line.

## Status

Research prototype. Single-writer, synchronous, in-memory. The reducer must be pure
and folded state must be treated as immutable (`freezeDeep` is provided for dev
builds). Concurrent multi-writer retcon and durable spine persistence are open work.
