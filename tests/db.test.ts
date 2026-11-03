import { describe, expect, it } from 'vitest';
import { openDb, transaction } from '../src/db.ts';

describe('transaction', () => {
  it('commits when the work succeeds', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');

    transaction(db, () => db.prepare('INSERT INTO t VALUES (1)').run());

    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 1 });
  });

  it('rolls back everything when the work throws', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');

    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 0 });
  });
});
