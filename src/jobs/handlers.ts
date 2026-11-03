import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { z } from 'zod';
import type { Customer } from '../data/customers.ts';
import type { McpTools } from '../mcp/client.ts';
import type { Job } from './queue.ts';
import { type JobHandler, PermanentJobError } from './worker.ts';

export const JOB_TYPES = ['weekly_summary', 'simulated_transcode'] as const;
export type JobType = (typeof JOB_TYPES)[number];

const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const MARGIN = 50;

const weeklySummaryPayload = z.object({ weekLabel: z.string().min(1) });
const transcodePayload = z.object({
  sourceName: z.string().min(1),
  failUntilRequeued: z.boolean().optional(),
});

function parsePayload<T extends z.ZodType>(schema: T, job: Job): z.output<T> {
  const parsed = schema.safeParse(job.payload);
  if (!parsed.success) throw new PermanentJobError(`Invalid payload for job ${job.id}.`);
  return parsed.data;
}

// The built-in PDF font covers Latin-1 only, and record text can hold anything.
function pdfSafe(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

async function renderSummary(title: string, lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage();
  let y = page.getHeight() - MARGIN;

  for (const line of [title, '', ...lines]) {
    if (y < MARGIN) {
      page = pdf.addPage();
      y = page.getHeight() - MARGIN;
    }
    page.drawText(pdfSafe(line), { x: MARGIN, y, size: FONT_SIZE, font });
    y -= LINE_HEIGHT;
  }
  return pdf.save();
}

/** Written to a temporary name first, so a crash can never leave a partial file in place. */
async function writeArtifact(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
}

function weeklySummary(tools: McpTools, artifactDir: string): JobHandler {
  return async (job) => {
    const { weekLabel } = parsePayload(weeklySummaryPayload, job);

    const search = await tools.call('find_customers', { limit: 50 });
    if (search.isError) throw new Error(`Could not read customers: ${search.text}`);
    const { customers } = JSON.parse(search.text) as { customers: Customer[] };

    const lines = customers.map(
      ({ fields }) => `${fields.name}: ${fields.repairStatus ?? 'no repair booked'}`,
    );
    const bytes = await renderSummary(`Weekly summary: ${weekLabel}`, [
      `Customers: ${customers.length}`,
      ...lines,
    ]);

    // Named by job id, so a retry replaces the same file instead of adding another.
    const artifact = `${job.id}.pdf`;
    await writeArtifact(join(artifactDir, artifact), bytes);
    return { artifact, customers: customers.length, bytes: bytes.length };
  };
}

/** Stands in for a long transcode. It does no media work and can fail on demand for demos. */
const simulatedTranscode: JobHandler = async (job) => {
  const { sourceName, failUntilRequeued } = parsePayload(transcodePayload, job);
  if (failUntilRequeued && job.requeueCount === 0) {
    throw new Error(`Simulated transcode failure on attempt ${job.attempts}.`);
  }
  return { output: `${sourceName}.mp4`, simulated: true };
};

export function createHandlers(tools: McpTools, artifactDir: string): Record<JobType, JobHandler> {
  return {
    weekly_summary: weeklySummary(tools, artifactDir),
    simulated_transcode: simulatedTranscode,
  };
}
