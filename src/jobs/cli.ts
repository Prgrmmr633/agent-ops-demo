import { dataPath } from '../config.ts';
import { openDb } from '../db.ts';
import { JobQueue } from './queue.ts';
import { runRecoveryCommand } from './recovery.ts';

const queue = new JobQueue(openDb(dataPath(process.env, 'jobs.db')));
process.exitCode = runRecoveryCommand(process.argv.slice(2), queue, console.log);
