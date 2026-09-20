/**
 * A worked example: one month of contractor payroll, then two edits to the past.
 *
 * Run:  bun experiments/retcon/demo/payroll.ts
 */
import { Chronicle } from '../src/index.js';
import type { Effect, EffectLaws, Intent, Transition, World } from '../src/types.js';

interface Books {
  readonly who: string | null;
  readonly rate: number;
  readonly hours: number;
  readonly closed: readonly string[];
}

const GENESIS: Books = { who: null, rate: 0, hours: 0, closed: [] };

function reduce(s: Books, i: Intent): Transition<Books> {
  switch (i.kind) {
    case 'hire': {
      const p = i.payload as { who: string };
      return { state: { ...s, who: p.who } };
    }
    case 'rate': {
      const p = i.payload as { value: number };
      return { state: { ...s, rate: p.value } };
    }
    case 'hours': {
      const p = i.payload as { n: number };
      return { state: { ...s, hours: s.hours + p.n } };
    }
    case 'close': {
      const p = i.payload as { month: string };
      const amount = s.rate * s.hours;
      const effects: Effect[] = [
        { kind: 'ledger.write', key: `ledger:${p.month}`, payload: { amount } },
        { kind: 'payment.send', key: `pay:${p.month}`, payload: { to: s.who, amount } },
        { kind: 'receipt.email', key: `receipt:${p.month}`, payload: { to: s.who, amount } },
        // Identical across both timelines — exists to demonstrate `retain`.
        { kind: 'calendar.mark', key: `closed:${p.month}`, payload: { month: p.month } },
      ];
      return { state: { ...s, closed: [...s.closed, p.month] }, effects };
    }
    default:
      return { state: s };
  }
}

const laws: EffectLaws = {
  'ledger.write': {
    mode: 'invertible',
    invert: (e) => ({ kind: 'ledger.reverse', key: e.key, payload: e.payload }),
  },
  'payment.send': {
    mode: 'corrective',
    correct: (e) => ({ kind: 'payment.clawback', key: e.key, payload: e.payload }),
  },
  'receipt.email': { mode: 'indelible' },
  'calendar.mark': {
    mode: 'invertible',
    invert: (e) => ({ kind: 'calendar.unmark', key: e.key, payload: e.payload }),
  },
};

const touched: string[] = [];
const world: World = {
  perform(e, reason) {
    const line = `      ${reason.toUpperCase().padEnd(7)} ${e.kind}(${e.key}) ${JSON.stringify(e.payload)}`;
    touched.push(line);
    console.log(line);
  },
};

const c = new Chronicle<Books>({ genesis: GENESIS, reduce, laws, world, author: 'ops' });

const hdr = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);
const show = (r: ReturnType<Chronicle<Books>['append']>) => {
  console.log(
    `      fold: recomputed=${r.recomputed} reused=${r.reused} ` +
      `cutoff=${r.convergedAt === null ? 'none' : `@${r.convergedAt}`} ` +
      `| plan: ${r.plan.map((p) => p.op).join(',') || '(empty)'}`,
  );
};

hdr('BUILD HISTORY');
const hire = c.append('hire', { who: 'ada@example.com' });
void hire;
c.append('rate', { value: 100 });
c.append('hours', { n: 10 });
c.append('hours', { n: 20 });
c.append('close', { month: '2026-03' });
console.log('      head:', JSON.stringify(c.head()));

const ids = c.history().map((i) => i.id);
const RATE_100 = ids[1]!;
const HOURS_20 = ids[3]!;

hdr('RETCON 1  —  insert `rate 999` before `rate 100` (4 steps back)');
const r1 = c.insertBefore(RATE_100, 'rate', { value: 999 });
show(r1);
console.log('      head:', JSON.stringify(c.head()));
console.log(`      world untouched: ${r1.plan.length === 0}`);
console.log(
  '      → the edit is overwritten downstream, so the state hash reconverges',
);
console.log(
  `      → 5 surviving intents, only ${r1.recomputed} re-reduced, 0 effects replayed`,
);

hdr('RETCON 2  —  insert `rate 120` after the last `hours` (before close)');
const before = touched.length;
const r2 = c.insertAfter(HOURS_20, 'rate', { value: 120 });
show(r2);
console.log('      head:', JSON.stringify(c.head()));
console.log(`      world touched by ${touched.length - before} acts (see above)`);

hdr('RECONCILIATION PLAN');
for (const p of r2.plan) {
  const e = p.effect;
  console.log(`      ${p.op.padEnd(7)} ${e.kind}(${e.key}) ${JSON.stringify(e.payload)}`);
}

hdr('SCAR LEDGER  (append-only; survives every future retcon)');
for (const s of c.scars()) {
  console.log(`      [rev ${s.revision}] ${s.kind}`);
  console.log(`         ${s.note}`);
}

hdr('RETCON 3  —  undo retcon 2 by amending the rate back to 100');
const rateBackId = c.history().find((i) => i.kind === 'rate' && (i.payload as { value: number }).value === 120)!.id;
const r3 = c.amend(rateBackId, { value: 100 });
show(r3);
console.log('      head:', JSON.stringify(c.head()));
console.log(`      head hash back to the original: ${r3.headAfter === r1.headAfter}`);
console.log(`      scars after undoing the retcon: ${c.scars().length}  ← they do not heal`);
console.log('');
