import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedAmbient } from '../../src/ambient.ts';
import { type CustomerPatch, CustomerStore } from '../../src/data/customers.ts';
import { openDb } from '../../src/db.ts';

const juniper = {
  id: 'cust-1',
  fields: {
    name: 'Juniper Vale',
    email: 'juniper.vale@example.com',
    repairStatus: 'in_repair' as const,
    repairNotes: 'Intake',
  },
};

function setup() {
  const db = openDb(':memory:');
  const store = new CustomerStore(db, fixedAmbient());
  store.insert(juniper);
  return { db, store };
}

const base = { id: 'cust-1', actor: 'test', reason: 'test' };
const update = (store: CustomerStore, revision: number, changes: CustomerPatch) =>
  store.update({ ...base, revision, changes });

const DROP_STATUS = `
  CREATE TRIGGER drop_status AFTER UPDATE OF fields ON customers
  BEGIN UPDATE customers SET fields = json_remove(fields, '$.repairStatus') WHERE id = NEW.id; END;
`;

describe('update', () => {
  it('commits, bumps the revision and returns a verified re-read and change', () => {
    const { store } = setup();

    const result = update(store, 1, { repairStatus: 'ready', bike: 'Folding commuter' });

    expect(result).toMatchObject({
      ok: true,
      customer: { revision: 2, fields: { repairStatus: 'ready', bike: 'Folding commuter' } },
      change: {
        fromRevision: 1,
        toRevision: 2,
        patch: { repairStatus: 'ready', bike: 'Folding commuter' },
        status: 'verified',
        mismatches: [],
      },
    });
  });

  it('leaves fields that are not named untouched', () => {
    const { store } = setup();

    update(store, 1, { repairStatus: 'ready' });

    expect(store.get('cust-1')?.fields).toEqual({ ...juniper.fields, repairStatus: 'ready' });
  });

  it('clears a field when it is set to null', () => {
    const { store } = setup();

    const result = update(store, 1, { repairNotes: null });

    expect(result.ok).toBe(true);
    expect(store.get('cust-1')?.fields).not.toHaveProperty('repairNotes');
  });

  describe('named fields only', () => {
    it.each([
      ['an unknown field', { status: 'ready' }],
      ['a JSON path', { '/repairStatus': 'ready' }],
      ['a nested path', { 'repairStatus.value': 'ready' }],
      ['clearing the name', { name: null }],
      ['an empty name', { name: '' }],
      ['an unknown repair status', { repairStatus: 'done' }],
      ['an invalid email', { email: 'not-an-email' }],
      ['a non-string value', { repairNotes: 42 }],
      ['no fields at all', {}],
    ])('rejects %s and changes nothing', (_label, changes) => {
      const { store } = setup();

      const result = update(store, 1, changes as CustomerPatch);

      expect(result).toMatchObject({ ok: false, error: 'invalid_change' });
      expect(store.get('cust-1')).toMatchObject({ revision: 1, fields: juniper.fields });
      expect(store.changes('cust-1')).toHaveLength(0);
    });

    it('rejects the whole patch when a valid field comes with an unknown one', () => {
      const { store } = setup();

      const result = update(store, 1, {
        repairStatus: 'ready',
        status: 'ready',
      } as CustomerPatch);

      expect(result).toMatchObject({ ok: false, error: 'invalid_change' });
      expect(store.get('cust-1')).toMatchObject({ revision: 1, fields: juniper.fields });
    });
  });

  describe('revision conflicts', () => {
    it('rejects a stale revision and changes nothing', () => {
      const { store } = setup();
      update(store, 1, { repairStatus: 'waiting_parts' });

      const stale = update(store, 1, { repairStatus: 'ready' });

      expect(stale).toMatchObject({
        ok: false,
        error: 'revision_conflict',
        expectedRevision: 1,
        currentRevision: 2,
      });
      expect(store.get('cust-1')).toMatchObject({
        revision: 2,
        fields: { repairStatus: 'waiting_parts' },
      });
      expect(store.changes('cust-1')).toHaveLength(1);
    });

    describe('across connections', () => {
      let dir: string;

      afterEach(() => rmSync(dir, { recursive: true, force: true }));

      it('lets exactly one of two writers at the same revision win', () => {
        dir = mkdtempSync(join(tmpdir(), 'customers-'));
        const path = join(dir, 'customers.db');
        const first = new CustomerStore(openDb(path), fixedAmbient());
        const second = new CustomerStore(openDb(path), fixedAmbient(Date.UTC(2031, 0, 1)));
        first.insert(juniper);

        const results = (['ready', 'collected'] as const).map((repairStatus, index) =>
          update(index === 0 ? first : second, 1, { repairStatus }),
        );

        expect(results.map((result) => result.ok)).toEqual([true, false]);
        expect(second.get('cust-1')).toMatchObject({
          revision: 2,
          fields: { repairStatus: 'ready' },
        });
      });
    });
  });

  it('rolls back the customer when the change log cannot be written', () => {
    const { db, store } = setup();
    db.exec(`
      CREATE TRIGGER fail_log BEFORE INSERT ON change_log
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);

    expect(() => update(store, 1, { repairStatus: 'ready' })).toThrow('disk full');

    expect(store.get('cust-1')).toMatchObject({ revision: 1, fields: juniper.fields });
  });

  describe('re-read after commit', () => {
    it('reports failure when the stored row silently loses a field', () => {
      const { db, store } = setup();
      db.exec(DROP_STATUS);

      const result = update(store, 1, { repairStatus: 'ready', bike: 'Folding commuter' });

      expect(result).toMatchObject({
        ok: false,
        error: 'verification_failed',
        mismatches: ['repairStatus does not match'],
      });
    });

    it('keeps an honest change record when verification fails', () => {
      const { db, store } = setup();
      db.exec(DROP_STATUS);

      update(store, 1, { repairStatus: 'ready' });

      expect(store.changes('cust-1')[0]).toMatchObject({
        status: 'mismatch',
        mismatches: ['repairStatus does not match'],
      });
    });

    it('catches a cleared field that reappears', () => {
      const { db, store } = setup();
      db.exec(`
        CREATE TRIGGER restore_notes AFTER UPDATE OF fields ON customers
        BEGIN UPDATE customers SET fields = json_set(fields, '$.repairNotes', 'Intake')
        WHERE id = NEW.id; END;
      `);

      const result = update(store, 1, { repairNotes: null });

      expect(result).toMatchObject({ ok: false, error: 'verification_failed' });
    });

    it('fails when the revision changed underneath the re-read', () => {
      const { db, store } = setup();
      db.exec(`
        CREATE TRIGGER bump AFTER UPDATE OF fields ON customers
        BEGIN UPDATE customers SET revision = NEW.revision + 1 WHERE id = NEW.id; END;
      `);

      const result = update(store, 1, { repairStatus: 'ready' });

      expect(result).toMatchObject({
        ok: false,
        error: 'verification_failed',
        mismatches: ['revision is 3, expected 2'],
      });
    });
  });

  it('rejects an unknown customer', () => {
    const { store } = setup();

    const result = store.update({
      ...base,
      id: 'cust-404',
      revision: 1,
      changes: { repairStatus: 'ready' },
    });

    expect(result).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('insert', () => {
  it('refuses seed data that breaks the field rules', () => {
    const store = new CustomerStore(openDb(':memory:'), fixedAmbient());
    expect(() =>
      store.insert({ id: 'cust-2', fields: { name: 'Otto', email: 'not-an-email' } }),
    ).toThrow();
  });
});

describe('changes', () => {
  it('returns changes newest first with the patch and actor', () => {
    const { store } = setup();
    store.update({ ...base, actor: 'bench-agent', revision: 1, changes: { bike: 'Gravel' } });
    store.update({
      ...base,
      actor: 'bench-agent',
      revision: 2,
      changes: { repairStatus: 'ready' },
    });

    const changes = store.changes('cust-1');

    expect(changes.map((change) => change.toRevision)).toEqual([3, 2]);
    expect(changes[0]).toMatchObject({ actor: 'bench-agent', patch: { repairStatus: 'ready' } });
  });

  it('honours the limit', () => {
    const { store } = setup();
    for (const revision of [1, 2, 3]) update(store, revision, { repairNotes: `Note ${revision}` });

    expect(store.changes('cust-1', 2)).toHaveLength(2);
  });
});

describe('find', () => {
  function seeded() {
    const { store } = setup();
    store.insert({ id: 'cust-2', fields: { name: 'Otto Bramblewick', repairStatus: 'ready' } });
    store.insert({ id: 'cust-3', fields: { name: 'Wren Ashdown', repairNotes: '100% done' } });
    return store;
  }

  it('filters by repair status', () => {
    expect(seeded().find({ repairStatus: 'ready' })).toMatchObject([{ id: 'cust-2' }]);
  });

  it('matches text case-insensitively across fields', () => {
    expect(seeded().find({ query: 'bramblewick' })).toMatchObject([{ id: 'cust-2' }]);
    expect(seeded().find({ query: 'EXAMPLE.COM' })).toMatchObject([{ id: 'cust-1' }]);
  });

  it('treats LIKE wildcards as literal text', () => {
    expect(seeded().find({ query: '100%' })).toMatchObject([{ id: 'cust-3' }]);
    expect(seeded().find({ query: '%' })).toMatchObject([{ id: 'cust-3' }]);
  });

  it('applies the limit', () => {
    expect(seeded().find({ limit: 1 })).toHaveLength(1);
  });
});
