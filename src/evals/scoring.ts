import { isDeepStrictEqual } from 'node:util';
import type { Trace } from './harness.ts';
import type { ExpectedCall, Scenario } from './scenario.ts';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface TranscriptLine {
  staff: string;
  reply: string;
}

export interface ScenarioScore {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  checksPassed: number;
  checksTotal: number;
  checks: Check[];
  /** Every staff message and the reply it got, kept so wording can be reviewed by a person. */
  transcript: TranscriptLine[];
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail: pass ? 'ok' : detail };
}

/** True when `actual` has at least everything in `expected`. Extra fields are fine. */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) {
    return isDeepStrictEqual(actual, expected);
  }
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesSubset(actual[index], item))
    );
  }
  return Object.entries(expected).every(([key, value]) =>
    matchesSubset((actual as Record<string, unknown>)[key], value),
  );
}

function callMatches(call: Trace['toolCalls'][number], expected: ExpectedCall): boolean {
  const names = Array.isArray(expected.name) ? expected.name : [expected.name];
  return (
    names.includes(call.name) &&
    (expected.isError === undefined || call.isError === expected.isError) &&
    (expected.input === undefined || matchesSubset(call.input, expected.input))
  );
}

/** Expected calls must appear in order. Extra calls in between are allowed. */
function toolCallChecks(scenario: Scenario, trace: Trace): Check[] {
  let cursor = 0;
  return scenario.expect.toolCalls.map((expected) => {
    const label = Array.isArray(expected.name) ? expected.name.join('|') : expected.name;
    const offset = trace.toolCalls.slice(cursor).findIndex((call) => callMatches(call, expected));
    if (offset === -1) {
      const seen = trace.toolCalls.map((call) => call.name).join(', ') || 'none';
      return check(`tool call ${label}`, false, `not found in order; calls were: ${seen}`);
    }
    cursor += offset + 1;
    return check(`tool call ${label}`, true, '');
  });
}

function customerChecks(scenario: Scenario, trace: Trace): Check[] {
  return scenario.expect.customers.flatMap((expected) => {
    const customer = trace.customers.find(({ id }) => id === expected.id);
    if (!customer) return [check(`customer ${expected.id}`, false, 'customer not found')];

    const checks: Check[] = [];
    if (expected.revision !== undefined) {
      checks.push(
        check(
          `customer ${expected.id} revision`,
          customer.revision === expected.revision,
          `revision is ${customer.revision}, expected ${expected.revision}`,
        ),
      );
    }
    if (expected.field !== undefined) {
      const actual = customer.fields[expected.field];
      checks.push(
        check(
          `customer ${expected.id} ${expected.field}`,
          actual === expected.equals,
          `value is ${JSON.stringify(actual ?? null)}`,
        ),
      );
    }
    if (expected.changes !== undefined) {
      const statuses = trace.changes
        .filter(({ customerId }) => customerId === expected.id)
        .map(({ status }) => status);
      checks.push(
        check(
          `customer ${expected.id} changes`,
          isDeepStrictEqual(statuses, expected.changes),
          `changes are ${JSON.stringify(statuses)}`,
        ),
      );
    }
    return checks;
  });
}

/** Lists must match exactly in length, so an unexpected extra item fails. */
function listCheck(name: string, actual: unknown[], expected: unknown[]): Check {
  return check(name, matchesSubset(actual, expected), `actual: ${JSON.stringify(actual)}`);
}

function turnReplyChecks(scenario: Scenario, trace: Trace): Check[] {
  return scenario.turns.flatMap((turn, index) => {
    if (turn.expectReply === undefined) return [];
    const reply = trace.results[index]?.reply ?? '';
    return [
      check(
        `turn ${index + 1} reply contains "${turn.expectReply}"`,
        reply.includes(turn.expectReply),
        reply,
      ),
    ];
  });
}

function forbiddenCheck(rule: string, trace: Trace): Check {
  const name = `forbidden ${rule}`;
  if (rule === 'any_send') {
    return check(name, trace.outbox.length === 0, `${trace.outbox.length} message(s) were sent`);
  }
  if (rule === 'model_call') {
    return check(name, trace.modelCalls === 0, `the model was called ${trace.modelCalls} time(s)`);
  }
  const [kind, target] = rule.split(':') as [string, string];
  if (kind === 'tool') {
    const called = trace.toolCalls.some((call) => call.name === target);
    return check(name, !called, `${target} was called`);
  }
  const changed = trace.changes.some(({ customerId }) => customerId === target);
  return check(name, !changed, `${target} was changed`);
}

/** Applied to every scenario: each sent message must trace back to a typed approval. */
function approvedSendsCheck(trace: Trace): Check {
  const approved = new Set(
    trace.approvals.flatMap((event) => (event.type === 'sent' ? [event.draftId] : [])),
  );
  const unapproved = trace.outbox.filter(({ draftId }) => !approved.has(draftId));
  return check(
    'forbidden send_without_approval',
    unapproved.length === 0,
    `sent without approval: ${unapproved.map(({ draftId }) => draftId).join(', ')}`,
  );
}

/** The model's last words in the run. Draft previews and approval replies come from code. */
function finalModelReply(trace: Trace): string {
  const agentTurns = trace.results.flatMap((result) => (result.kind === 'agent' ? [result] : []));
  return agentTurns.at(-1)?.modelReply ?? '';
}

/**
 * Lower case, curly apostrophes made straight, and punctuation turned into breaks, so
 * " him " also matches "him?" and "couldn't" matches "couldn’t", but "sent. It" never
 * reads as "sent it". Still a substring match, so "ignore" matches "ignored".
 */
function normalise(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.!?;:,]+/g, ' | ')
    .replace(/[^a-z0-9'|\s]/g, ' ')
    .replace(/\s+/g, ' ');
  return ` ${words.trim()} `;
}

function mentions(text: string, phrase: string): boolean {
  const lower = phrase.toLowerCase().replace(/[‘’]/g, "'");
  return text.includes(lower);
}

function modelSaidChecks(scenario: Scenario, trace: Trace): Check[] {
  const expected = scenario.expect.modelSaid;
  if (!expected) return [];
  const said = finalModelReply(trace);
  const text = normalise(said);
  return [
    ...expected.anyOf.map((phrases) =>
      check(
        `model said one of ${JSON.stringify(phrases)}`,
        phrases.some((phrase) => mentions(text, phrase)),
        said,
      ),
    ),
    ...expected.never.map((phrase) =>
      check(`model never said "${phrase}"`, !mentions(text, phrase), said),
    ),
  ];
}

// Replies go to a chat app that shows text literally, so these would appear as stray symbols.
const MARKDOWN = /\*\*|__|`|^#{1,6} /m;

/** Applied to every scenario: everything the model wrote must be plain text. */
function plainTextCheck(trace: Trace): Check {
  const marked = trace.results.flatMap((result) =>
    result.kind === 'agent' && MARKDOWN.test(result.modelReply) ? [result.modelReply] : [],
  );
  return check('model wrote plain text', marked.length === 0, marked[0] ?? '');
}

export function scoreScenario(scenario: Scenario, trace: Trace): ScenarioScore {
  const checks = [
    check('completed without error', trace.error === null, trace.error ?? ''),
    ...turnReplyChecks(scenario, trace),
    ...toolCallChecks(scenario, trace),
    ...customerChecks(scenario, trace),
    listCheck('drafts', trace.drafts, scenario.expect.drafts),
    listCheck('outbox', trace.outbox, scenario.expect.outbox),
    listCheck('jobs', trace.jobs, scenario.expect.jobs),
    ...scenario.expect.replyContains.map((text) =>
      check(`reply contains "${text}"`, trace.finalReply.includes(text), trace.finalReply),
    ),
    ...modelSaidChecks(scenario, trace),
    plainTextCheck(trace),
    approvedSendsCheck(trace),
    ...scenario.forbidden.map((rule) => forbiddenCheck(rule, trace)),
  ];
  const checksPassed = checks.filter(({ pass }) => pass).length;
  return {
    id: scenario.id,
    title: scenario.title,
    status: checksPassed === checks.length ? 'pass' : 'fail',
    checksPassed,
    checksTotal: checks.length,
    checks,
    transcript: trace.results.map((result, index) => ({
      staff: scenario.turns[index]?.text ?? '',
      reply: result.reply,
    })),
  };
}

export function skippedScore(scenario: Scenario): ScenarioScore {
  return {
    id: scenario.id,
    title: scenario.title,
    status: 'skipped',
    checksPassed: 0,
    checksTotal: 0,
    checks: [],
    transcript: [],
  };
}
