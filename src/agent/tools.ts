import { z } from 'zod';
import { JOB_TYPES } from '../jobs/handlers.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { CHANNELS, type Draft, type DraftStore } from '../outbound/drafts.ts';
import { defineTool, type LocalTool } from './toolbox.ts';

const draftInput = z
  .object({
    channel: z.enum(CHANNELS),
    to: z.string().min(1).describe('Email address or phone number from the customer’s details.'),
    subject: z.string().min(1).optional().describe('Required for email.'),
    body: z.string().min(1).describe('The full message, or the call script for voice.'),
    customerId: z.string().optional().describe('The customer this message is for.'),
  })
  .refine((input) => input.channel !== 'email' || input.subject !== undefined, {
    message: 'An email draft needs a subject.',
    path: ['subject'],
  });

/** Draft tools are scoped to one chat. There is deliberately no tool that sends. */
export function draftTools(
  drafts: DraftStore,
  chatId: string,
  onDraft: (draft: Draft) => void,
): LocalTool[] {
  return [
    defineTool({
      name: 'draft_message',
      description:
        'Save an email, SMS or voice call as a draft for staff to review. This sends nothing.',
      schema: draftInput,
      run: (input) => {
        const draft = drafts.create({ chatId, ...input });
        onDraft(draft);
        return { ok: true, draftId: draft.id, status: draft.status };
      },
    }),
    defineTool({
      name: 'draft_list',
      description: 'List recent drafts in this chat with their current status.',
      schema: z.object({}),
      run: () => ({
        drafts: drafts.recent(chatId).map(({ id, channel, to, status }) => {
          return { id, channel, to, status };
        }),
      }),
    }),
  ];
}

const JOB_PAYLOAD_FIELD = { weekly_summary: 'weekLabel', simulated_transcode: 'sourceName' };

export function jobTools(jobs: JobQueue): LocalTool[] {
  return [
    defineTool({
      name: 'job_enqueue',
      description:
        'Start a long-running job. Asking twice for the same subject returns the same job.',
      schema: z.object({
        type: z.enum(JOB_TYPES),
        subject: z.string().min(1).describe('The week label for a summary, or the file name.'),
      }),
      run: ({ type, subject }) => {
        // Derived here so that a retried model call cannot invent a new key and repeat the work.
        const { job, created } = jobs.enqueue({
          type,
          payload: { [JOB_PAYLOAD_FIELD[type]]: subject },
          idempotencyKey: `${type}:${subject}`,
        });
        return { jobId: job.id, status: job.status, alreadyExisted: !created };
      },
    }),
    defineTool({
      name: 'job_status',
      description: 'Check a job by id.',
      schema: z.object({ id: z.string().min(1) }),
      run: ({ id }) => {
        const job = jobs.get(id);
        if (!job) return { ok: false, error: 'not_found' };
        const { status, attempts, lastError, result } = job;
        return { ok: true, id, status, attempts, lastError, result };
      },
    }),
  ];
}
