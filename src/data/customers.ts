import { z } from 'zod';
import { type Ambient, systemAmbient } from '../ambient.ts';
import { type Db, transaction } from '../db.ts';

export const REPAIR_STATUSES = [
  'booked',
  'in_repair',
  'waiting_parts',
  'ready',
  'collected',
] as const;

const name = z.string().min(1).describe('Full name.');
const email = z.email().describe('Email address.');
const phone = z.string().min(1).describe('Phone number.');
const bike = z.string().min(1).describe('The bike in for repair.');
const repairStatus = z.enum(REPAIR_STATUSES).describe('Where the repair is up to.');
const repairNotes = z.string().describe('Notes about the repair. A new value replaces the old.');

export const customerFieldsSchema = z.strictObject({
  name,
  email: email.optional(),
  phone: phone.optional(),
  bike: bike.optional(),
  repairStatus: repairStatus.optional(),
  repairNotes: repairNotes.optional(),
});

export type CustomerFields = z.output<typeof customerFieldsSchema>;
export type FieldName = keyof CustomerFields;

/**
 * A change names the fields it touches. A value replaces the field, null clears
 * it, and any field left out stays as it is. A name can change but never be cleared.
 */
export const customerPatchSchema = z
  .strictObject({
    name: name.optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    bike: bike.nullable().optional(),
    repairStatus: repairStatus.nullable().optional(),
    repairNotes: repairNotes.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Name at least one field to change.',
  });

export type CustomerPatch = z.input<typeof customerPatchSchema>;
type PatchEntry = [FieldName, string | null];

export interface Customer {
  id: string;
  revision: number;
  fields: CustomerFields;
  updatedAt: string;
}

/** `committed` means the re-read never finished, so nothing is known about it yet. */
export type ChangeStatus = 'committed' | 'verified' | 'mismatch';

export interface Change {
  id: string;
  customerId: string;
  fromRevision: number;
  toRevision: number;
  patch: Partial<Record<FieldName, string | null>>;
  actor: string;
  reason: string;
  status: ChangeStatus;
  mismatches: string[];
  changedAt: string;
}

export interface UpdateInput {
  id: string;
  revision: number;
  changes: CustomerPatch;
  actor: string;
  reason: string;
}

export type UpdateRejection =
  | { ok: false; error: 'not_found'; message: string }
  | { ok: false; error: 'invalid_change'; message: string }
  | {
      ok: false;
      error: 'revision_conflict';
      message: string;
      expectedRevision: number;
      currentRevision: number;
    };

export type UpdateResult =
  | { ok: true; customer: Customer; change: Change }
  | UpdateRejection
  | {
      ok: false;
      error: 'verification_failed';
      message: string;
      mismatches: string[];
      customer: Customer | null;
      change: Change;
    };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    fields TEXT NOT NULL CHECK (json_valid(fields)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_log (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers (id),
    from_revision INTEGER NOT NULL,
    to_revision INTEGER NOT NULL,
    patch TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('committed', 'verified', 'mismatch')),
    mismatches TEXT NOT NULL DEFAULT '[]',
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS change_log_by_customer ON change_log (customer_id, to_revision);
`;

const MAX_RESULTS = 50;

// Thrown inside the transaction so a rejection rolls back through the normal path.
class Rejected extends Error {
  readonly result: UpdateRejection;

  constructor(result: UpdateRejection) {
    super(result.message);
    this.result = result;
  }
}

export class CustomerStore {
  private readonly db: Db;
  private readonly ambient: Ambient;

  constructor(db: Db, ambient: Ambient = systemAmbient) {
    this.db = db;
    this.ambient = ambient;
    db.exec(SCHEMA);
  }

  /** Loads a starting customer. Seeding happens outside the audited update path. */
  insert(input: { id: string; fields: CustomerFields }): void {
    const fields = customerFieldsSchema.parse(input.fields);
    this.db
      .prepare('INSERT INTO customers (id, revision, fields, updated_at) VALUES (?, 1, ?, ?)')
      .run(input.id, JSON.stringify(fields), this.timestamp());
  }

  get(id: string): Customer | null {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    return row ? toCustomer(row) : null;
  }

  find(input: { query?: string; repairStatus?: string; limit?: number }): Customer[] {
    const limit = Math.min(input.limit ?? 20, MAX_RESULTS);
    const pattern = input.query ? `%${input.query.replace(/[\\%_]/g, '\\$&')}%` : null;
    return this.db
      .prepare(
        `SELECT * FROM customers
         WHERE (?1 IS NULL OR json_extract(fields, '$.repairStatus') = ?1)
           AND (?2 IS NULL OR fields LIKE ?2 ESCAPE '\\')
         ORDER BY id LIMIT ?3`,
      )
      .all(input.repairStatus ?? null, pattern, limit)
      .map(toCustomer);
  }

  changes(id: string, limit = 20): Change[] {
    return this.db
      .prepare('SELECT * FROM change_log WHERE customer_id = ? ORDER BY to_revision DESC LIMIT ?')
      .all(id, limit)
      .map(toChange);
  }

  update(input: UpdateInput): UpdateResult {
    const parsed = customerPatchSchema.safeParse(input.changes);
    if (!parsed.success) {
      return { ok: false, error: 'invalid_change', message: z.prettifyError(parsed.error) };
    }
    const patch = Object.entries(parsed.data).filter(
      ([, value]) => value !== undefined,
    ) as PatchEntry[];

    let committed: { expected: CustomerFields; toRevision: number; changeId: string };
    try {
      committed = transaction(this.db, () => this.commit(input, patch));
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      throw error;
    }

    // This read runs after COMMIT, so it sees what was stored, not what was intended.
    const readBack = this.get(input.id);
    const mismatches = findMismatches(patch, committed, readBack);
    const change = this.settle(committed.changeId, mismatches);

    if (mismatches.length > 0 || readBack === null) {
      return {
        ok: false,
        error: 'verification_failed',
        message: 'The update committed but a re-read does not show every requested change.',
        mismatches,
        customer: readBack,
        change,
      };
    }
    return { ok: true, customer: readBack, change };
  }

  private commit(input: UpdateInput, patch: PatchEntry[]) {
    const current = this.get(input.id);
    if (!current) {
      throw new Rejected({
        ok: false,
        error: 'not_found',
        message: `No customer with id ${input.id}.`,
      });
    }
    if (current.revision !== input.revision) {
      throw new Rejected({
        ok: false,
        error: 'revision_conflict',
        message: `Customer ${input.id} is at revision ${current.revision}, not ${input.revision}. Get the customer again before retrying.`,
        expectedRevision: input.revision,
        currentRevision: current.revision,
      });
    }

    const expected = applyPatch(current.fields, patch);
    const toRevision = current.revision + 1;
    const timestamp = this.timestamp();
    this.db
      .prepare('UPDATE customers SET fields = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(expected), toRevision, timestamp, input.id);

    const changeId = this.ambient.newId('chg');
    this.db
      .prepare(
        `INSERT INTO change_log
           (id, customer_id, from_revision, to_revision, patch, actor, reason, status, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      )
      .run(
        changeId,
        input.id,
        current.revision,
        toRevision,
        JSON.stringify(Object.fromEntries(patch)),
        input.actor,
        input.reason,
        timestamp,
      );
    return { expected, toRevision, changeId };
  }

  private settle(changeId: string, mismatches: string[]): Change {
    const status: ChangeStatus = mismatches.length > 0 ? 'mismatch' : 'verified';
    const row = this.db
      .prepare('UPDATE change_log SET status = ?, mismatches = ? WHERE id = ? RETURNING *')
      .get(status, JSON.stringify(mismatches), changeId);
    return toChange(row);
  }

  private timestamp(): string {
    return new Date(this.ambient.now()).toISOString();
  }
}

function applyPatch(fields: CustomerFields, patch: PatchEntry[]): CustomerFields {
  const next: Record<string, string> = { ...fields };
  for (const [field, value] of patch) {
    if (value === null) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next as CustomerFields;
}

/** Compares each named field in the stored row with the value computed before the write. */
function findMismatches(
  patch: PatchEntry[],
  committed: { expected: CustomerFields; toRevision: number },
  readBack: Customer | null,
): string[] {
  if (!readBack) return ['customer is missing after commit'];

  const mismatches: string[] = [];
  if (readBack.revision !== committed.toRevision) {
    mismatches.push(`revision is ${readBack.revision}, expected ${committed.toRevision}`);
  }
  for (const [field] of patch) {
    if (readBack.fields[field] !== committed.expected[field]) {
      mismatches.push(`${field} does not match`);
    }
  }
  return mismatches;
}

function toCustomer(row: unknown): Customer {
  const r = row as { id: string; revision: number; fields: string; updated_at: string };
  return { id: r.id, revision: r.revision, fields: JSON.parse(r.fields), updatedAt: r.updated_at };
}

function toChange(row: unknown): Change {
  const r = row as {
    id: string;
    customer_id: string;
    from_revision: number;
    to_revision: number;
    patch: string;
    actor: string;
    reason: string;
    status: ChangeStatus;
    mismatches: string;
    changed_at: string;
  };
  return {
    id: r.id,
    customerId: r.customer_id,
    fromRevision: r.from_revision,
    toRevision: r.to_revision,
    patch: JSON.parse(r.patch),
    actor: r.actor,
    reason: r.reason,
    status: r.status,
    mismatches: JSON.parse(r.mismatches),
    changedAt: r.changed_at,
  };
}
