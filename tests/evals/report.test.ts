import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, formatTable } from '../../src/evals/report.ts';
import { runEvals } from '../../src/evals/run.ts';
import type { ScenarioScore } from '../../src/evals/scoring.ts';

const passing: ScenarioScore = {
  id: 'first-scenario',
  title: 'First',
  status: 'pass',
  checksPassed: 3,
  checksTotal: 3,
  checks: [{ name: 'a', pass: true, detail: 'ok' }],
  transcript: [],
};

const failing: ScenarioScore = {
  id: 'second-scenario',
  title: 'Second',
  status: 'fail',
  checksPassed: 1,
  checksTotal: 2,
  checks: [
    { name: 'a', pass: true, detail: 'ok' },
    { name: 'forbidden any_send', pass: false, detail: '1 message(s) were sent' },
  ],
  transcript: [],
};

const skipped: ScenarioScore = {
  id: 'third-scenario',
  title: 'Third',
  status: 'skipped',
  checksPassed: 0,
  checksTotal: 0,
  checks: [],
  transcript: [],
};

const report = buildReport(
  'scripted',
  'scripted fake model',
  [passing, failing, skipped],
  new Date(Date.UTC(2030, 0, 7)),
);

describe('buildReport', () => {
  it('summarises results', () => {
    expect(report.summary).toEqual({
      scenarios: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      checksPassed: 4,
      checksTotal: 5,
    });
  });
});

describe('formatTable', () => {
  const table = formatTable(report);

  it('shows a row for each scenario', () => {
    expect(table).toMatch(/PASS\s+3\/3\s+first-scenario/);
    expect(table).toMatch(/FAIL\s+1\/2\s+second-scenario/);
    expect(table).toMatch(/SKIPPED\s+-\s+third-scenario/);
  });

  it('explains each failed check', () => {
    expect(table).toContain('second-scenario: forbidden any_send: 1 message(s) were sent');
  });

  it('ends with the totals', () => {
    expect(table.split('\n').at(-1)).toBe('1 passed, 1 failed, 1 skipped. Checks: 4/5.');
  });
});

describe('runEvals in live mode', () => {
  const reportPath = resolve(import.meta.dirname, '../../docs/eval-report.live.json');

  function liveReportTimestamp(): number | null {
    try {
      return statSync(reportPath).mtimeMs;
    } catch {
      return null;
    }
  }

  it.each([
    ['no key', { ANTHROPIC_MODEL: 'model-from-env' }],
    ['no model', { ANTHROPIC_API_KEY: 'test-key-not-real' }],
    ['neither', {}],
  ])('fails with %s instead of falling back to the fake model', async (_label, env) => {
    const before = liveReportTimestamp();
    const lines: string[] = [];

    const code = await runEvals(['--live'], env, (line) => lines.push(line));

    expect(code).toBe(1);
    expect(lines).toEqual([
      'Live mode needs ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Nothing was run.',
    ]);
    expect(liveReportTimestamp()).toBe(before);
  });
});

describe('recorded report', () => {
  it('is safe to publish: it holds no machine paths', () => {
    const recorded = readFileSync(
      resolve(import.meta.dirname, '../../docs/eval-report.json'),
      'utf8',
    );
    expect(recorded).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/);
  });

  it('records a complete scripted run', () => {
    const recorded = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../docs/eval-report.json'), 'utf8'),
    );
    expect(recorded.mode).toBe('scripted');
    expect(recorded.summary.failed).toBe(0);
    expect(recorded.summary.scenarios).toBeGreaterThanOrEqual(17);
  });
});
