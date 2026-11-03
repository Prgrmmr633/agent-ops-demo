import { runEvals } from './run.ts';

process.exitCode = await runEvals(process.argv.slice(2), process.env, console.log);
