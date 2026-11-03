import { dataPath } from '../src/config.ts';
import { CustomerStore } from '../src/data/customers.ts';
import { openDb } from '../src/db.ts';
import { SEED_CUSTOMERS } from '../src/seed-data.ts';

const store = new CustomerStore(openDb(dataPath(process.env, 'customers.db')));

// Existing customers are left alone, so running this twice never resets real changes.
const missing = SEED_CUSTOMERS.filter(({ id }) => store.get(id) === null);
for (const record of missing) store.insert(record);

console.log(`Seeded ${missing.length} of ${SEED_CUSTOMERS.length} fake customers.`);
