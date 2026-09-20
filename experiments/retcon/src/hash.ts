/**
 * Structural, memoized content hashing.
 *
 * The Retcon engine's convergence cutoff is only as cheap as state identity.
 * Two properties matter:
 *
 *  1. HASH OF A COMPOSITE IS A MIX OF ITS CHILDREN'S HASHES. We never stream a
 *     child's bytes into the parent, we stream the child's *digest*. Combined
 *     with (2) this means re-hashing a persistent structure after a small edit
 *     costs O(path length), not O(size).
 *
 *  2. OBJECT DIGESTS ARE MEMOIZED BY REFERENCE. Structural sharing therefore
 *     turns into hash sharing for free.
 *
 * PRECONDITION: values handed to `structuralHash` are treated as immutable.
 * Mutating a hashed object invalidates the memo silently. `freezeDeep` is
 * provided for development builds.
 */

export type Hash = string; // 16 lowercase hex chars (64 bits, two 32-bit lanes)

const memo = new WeakMap<object, Hash>();

class Lanes {
  private a = 0x811c9dc5;
  private b = 0xcbf29ce4;

  byte(x: number): void {
    this.a = Math.imul(this.a ^ (x & 0xff), 0x01000193) >>> 0;
    this.b = (this.b + (x & 0xff) + 1) >>> 0;
    this.b = Math.imul(this.b ^ (this.b >>> 13), 0x85ebca6b) >>> 0;
  }

  text(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c & 0xff);
      this.byte(c >>> 8);
    }
    this.byte(0);
  }

  digest(): Hash {
    const a = (this.a ^ (this.b >>> 7)) >>> 0;
    return a.toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

/** Mix an ordered list of already-computed digests (and tags) into one digest. */
export function mix(...parts: readonly string[]): Hash {
  const l = new Lanes();
  for (const p of parts) l.text(p);
  return l.digest();
}

export const EMPTY_HASH: Hash = mix('\u0000empty');

export function structuralHash(value: unknown): Hash {
  switch (typeof value) {
    case 'undefined':
      return mix('u');
    case 'boolean':
      return mix('b', value ? '1' : '0');
    case 'number':
      return mix('n', Object.is(value, -0) ? '0' : String(value));
    case 'bigint':
      return mix('i', value.toString());
    case 'string':
      return mix('s', value);
    case 'symbol':
    case 'function':
      throw new TypeError(`retcon: ${typeof value} is not hashable state`);
  }
  if (value === null) return mix('z');

  const obj = value as object;
  const hit = memo.get(obj);
  if (hit !== undefined) return hit;

  let out: Hash;
  if (Array.isArray(obj)) {
    const parts: string[] = ['A', String(obj.length)];
    for (const el of obj) parts.push(structuralHash(el));
    out = mix(...parts);
  } else if (obj instanceof Date) {
    out = mix('D', String(obj.getTime()));
  } else if (obj instanceof Map) {
    // Order-independent: entry digests are sorted before mixing.
    const entries: string[] = [];
    for (const [k, v] of obj) entries.push(mix(structuralHash(k), structuralHash(v)));
    entries.sort();
    out = mix('M', String(entries.length), ...entries);
  } else if (obj instanceof Set) {
    const members: string[] = [];
    for (const m of obj) members.push(structuralHash(m));
    members.sort();
    out = mix('S', String(members.length), ...members);
  } else {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const parts: string[] = ['O', String(keys.length)];
    for (const k of keys) {
      parts.push(k, structuralHash((obj as Record<string, unknown>)[k]));
    }
    out = mix(...parts);
  }

  memo.set(obj, out);
  return out;
}

/** Development guard: makes the immutability precondition enforceable. */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) freezeDeep(v);
  return value;
}
