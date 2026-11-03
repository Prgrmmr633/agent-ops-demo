import { type JobQueue, RequeueRefused } from './queue.ts';

const USAGE = `Usage:
  jobs failed                   List failed jobs.
  jobs requeue <id> [<id>...]   Requeue exactly these failed jobs.

There is no option to requeue everything. Name each job id.`;

const JOB_ID = /^job_[A-Za-z0-9]+$/;

/** Returns a process exit code. Output goes through `print` so tests can read it. */
export function runRecoveryCommand(
  args: string[],
  queue: JobQueue,
  print: (line: string) => void,
): number {
  const [command, ...rest] = args;

  if (command === 'failed' && rest.length === 0) {
    const failed = queue.listFailed();
    if (failed.length === 0) print('No failed jobs.');
    for (const job of failed) {
      print(`${job.id}  ${job.type}  attempts=${job.attempts}  ${job.lastError ?? ''}`.trimEnd());
    }
    return 0;
  }

  if (command === 'requeue' && rest.length > 0) {
    const invalid = rest.find((id) => !JOB_ID.test(id));
    if (invalid !== undefined) {
      print(`"${invalid}" is not a job id. Nothing was requeued.`);
      return 2;
    }
    try {
      for (const job of queue.requeueExact(rest)) print(`Requeued ${job.id} (${job.type}).`);
      return 0;
    } catch (error) {
      if (error instanceof RequeueRefused) {
        print(error.message);
        return 1;
      }
      throw error;
    }
  }

  print(USAGE);
  return 2;
}
