import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerStore } from '../src/data/customers.ts';
import { openDb } from '../src/db.ts';
import { SEED_CUSTOMERS } from '../src/seed-data.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

describe('seed script', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = () =>
    run(process.execPath, ['scripts/seed.ts'], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dir },
    });

  it('loads every customer once and keeps later changes when run again', async () => {
    const total = SEED_CUSTOMERS.length;
    const first = await seed();
    expect(first.stdout).toContain(`Seeded ${total} of ${total}`);

    const store = new CustomerStore(openDb(join(dir, 'customers.db')));
    store.update({
      id: 'cust-2004',
      revision: 1,
      changes: { repairStatus: 'ready' },
      actor: 'test',
      reason: 'test',
    });

    const second = await seed();

    expect(second.stdout).toContain(`Seeded 0 of ${total}`);
    expect(store.get('cust-2004')).toMatchObject({
      revision: 2,
      fields: { repairStatus: 'ready' },
    });
  });
});

describe('demo script', () => {
  it('runs the whole story end to end', async () => {
    const { stdout } = await run(process.execPath, ['scripts/demo.ts'], { cwd: root });

    expect(stdout).toContain('Nothing has been sent');
    expect(stdout).toContain('Sent email d_1 to juniper.vale@example.com');
    expect(stdout).toContain('Draft d_1 has already been handled.');
    expect(stdout).toContain('tool: update_customer (rejected)');
    expect(stdout).toContain('"patch":{"repairStatus":"ready"}');
    expect(stdout).toContain('"status":"verified"');
    expect(stdout).toContain('"status":"degraded"');
    expect(stdout).toContain('"--all" is not a job id. Nothing was requeued.');
    expect(stdout).toContain('Requeued job_2');
    expect(stdout).toContain('"status":"ok"');
    expect(stdout).toContain('Demo finished');
    expect(stdout).not.toMatch(/SEND (EMAIL|SMS|VOICE)/);
  });
});

describe('seed data', () => {
  it('uses only reserved addresses and fiction phone numbers', () => {
    for (const { fields } of SEED_CUSTOMERS) {
      if (fields.email) expect(fields.email).toMatch(/@example\.com$/);
      if (fields.phone) expect(fields.phone).toMatch(/^\+1-555-01\d\d$/);
    }
  });
});
