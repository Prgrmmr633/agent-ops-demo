import { dataPath, loadDataServiceConfig } from '../config.ts';
import { CustomerStore } from '../data/customers.ts';
import { openDb } from '../db.ts';
import { startDataHttpServer } from './http.ts';

const config = loadDataServiceConfig();
const store = new CustomerStore(openDb(dataPath(process.env, 'customers.db')));

const server = await startDataHttpServer({
  store,
  actor: config.DATA_ACTOR,
  token: config.MCP_AUTH_TOKEN,
  host: config.MCP_HOST,
  port: config.MCP_PORT,
});
console.log(`Data service listening on ${server.url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close());
}
