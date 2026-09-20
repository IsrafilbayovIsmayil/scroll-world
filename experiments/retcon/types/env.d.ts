// Minimal ambient surface so the demo typechecks without pulling @types/node
// or @types/bun into a zero-dependency module.
declare const console: { log(...args: unknown[]): void };
