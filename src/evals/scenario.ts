import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { customerFieldsSchema } from '../data/customers.ts';

export const EVAL_MODES = ['scripted', 'live'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

/** Known faults a scenario can switch on, kept in code so scenario files hold no SQL. */
export const FAULTS = ['drop_repair_status_on_write'] as const;

const scriptedStep = z.strictObject({
  say: z.string().optional(),
  calls: z
    .array(z.strictObject({ tool: z.string(), input: z.record(z.string(), z.unknown()) }))
    .optional(),
});

const turn = z.strictObject({
  text: z.string().min(1),
  userId: z.string().default('staff-1'),
  source: z.enum(['typed', 'forwarded', 'voice']).default('typed'),
  /** Checked on this turn's reply, so a mid-run mistake cannot be hidden by a later turn. */
  expectReply: z.string().optional(),
  /** Another staff member's change, applied just before this turn. */
  otherStaffEdit: z
    .strictObject({ id: z.string(), changes: z.record(z.string(), z.string().nullable()) })
    .optional(),
});

const expectedCall = z.strictObject({
  name: z.union([z.string(), z.array(z.string()).min(1)]),
  input: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** With `field` and no `equals`, the field must be absent. */
const expectedCustomer = z.strictObject({
  id: z.string(),
  revision: z.number().int().optional(),
  field: customerFieldsSchema.keyof().optional(),
  equals: z.string().optional(),
  changes: z.array(z.enum(['committed', 'verified', 'mismatch'])).optional(),
});

const expectations = z.strictObject({
  toolCalls: z.array(expectedCall).default([]),
  customers: z.array(expectedCustomer).default([]),
  drafts: z.array(z.record(z.string(), z.unknown())).default([]),
  outbox: z.array(z.record(z.string(), z.unknown())).default([]),
  jobs: z.array(z.record(z.string(), z.unknown())).default([]),
  replyContains: z.array(z.string()).default([]),
  /**
   * Checked against the model's own final words, case-insensitively, so a live model
   * can phrase things its own way. Each group needs one match; no excluded phrase may appear.
   */
  modelSaid: z
    .strictObject({
      anyOf: z.array(z.array(z.string().min(1)).min(1)).default([]),
      never: z.array(z.string().min(1)).default([]),
    })
    .optional(),
});

const forbidden = z.union([
  z.enum(['any_send', 'model_call']),
  z.string().regex(/^tool:[a-z_]+$/),
  z.string().regex(/^change:[a-z0-9-]+$/),
]);

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** Scenarios that depend on scripted misbehaviour cannot run against a real model. */
  modes: z.array(z.enum(EVAL_MODES)).min(1).default(['scripted', 'live']),
  faults: z.array(z.enum(FAULTS)).default([]),
  turns: z.array(turn).min(1),
  script: z.array(scriptedStep).default([]),
  expect: expectations,
  forbidden: z.array(forbidden).default([]),
});

export type Scenario = z.output<typeof scenarioSchema>;
export type ExpectedCall = z.output<typeof expectedCall>;

export function loadScenarios(directory: string): Scenario[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const parsed = scenarioSchema.safeParse(
        JSON.parse(readFileSync(join(directory, name), 'utf8')),
      );
      if (!parsed.success) {
        throw new Error(`${name} is not a valid scenario:\n${z.prettifyError(parsed.error)}`);
      }
      return parsed.data;
    });
}
