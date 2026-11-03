import { randomUUID } from 'node:crypto';

/** Time and ids, injected so tests, evals and demos can be deterministic. */
export interface Ambient {
  now(): number;
  newId(prefix: string): string;
}

export const systemAmbient: Ambient = {
  now: () => Date.now(),
  newId: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
};

export interface FixedAmbient extends Ambient {
  advance(ms: number): void;
}

export function fixedAmbient(startMs = Date.UTC(2030, 0, 7, 9)): FixedAmbient {
  let time = startMs;
  const counters = new Map<string, number>();
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    newId: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
  };
}
