import type { EvalMode } from './scenario.ts';
import type { ScenarioScore } from './scoring.ts';

export interface EvalReport {
  mode: EvalMode;
  model: string;
  generatedAt: string;
  summary: {
    scenarios: number;
    passed: number;
    failed: number;
    skipped: number;
    checksPassed: number;
    checksTotal: number;
  };
  scenarios: ScenarioScore[];
}

export function buildReport(
  mode: EvalMode,
  model: string,
  scenarios: ScenarioScore[],
  generatedAt: Date,
): EvalReport {
  const count = (status: ScenarioScore['status']) =>
    scenarios.filter((scenario) => scenario.status === status).length;
  return {
    mode,
    model,
    generatedAt: generatedAt.toISOString(),
    summary: {
      scenarios: scenarios.length,
      passed: count('pass'),
      failed: count('fail'),
      skipped: count('skipped'),
      checksPassed: scenarios.reduce((sum, scenario) => sum + scenario.checksPassed, 0),
      checksTotal: scenarios.reduce((sum, scenario) => sum + scenario.checksTotal, 0),
    },
    scenarios,
  };
}

export function formatTable(report: EvalReport): string {
  const rows = report.scenarios.map((scenario) => ({
    result: scenario.status.toUpperCase(),
    checks:
      scenario.status === 'skipped' ? '-' : `${scenario.checksPassed}/${scenario.checksTotal}`,
    id: scenario.id,
  }));
  const idWidth = Math.max('Scenario'.length, ...rows.map(({ id }) => id.length));

  const lines = [
    `Mode: ${report.mode}   Model: ${report.model}`,
    '',
    `${'Result'.padEnd(8)}${'Checks'.padEnd(8)}${'Scenario'.padEnd(idWidth)}`,
    '-'.repeat(16 + idWidth),
    ...rows.map(({ result, checks, id }) => `${result.padEnd(8)}${checks.padEnd(8)}${id}`),
    '-'.repeat(16 + idWidth),
  ];

  for (const scenario of report.scenarios) {
    for (const failed of scenario.checks.filter(({ pass }) => !pass)) {
      lines.push(`${scenario.id}: ${failed.name}: ${failed.detail}`);
    }
  }

  const { passed, failed, skipped, checksPassed, checksTotal } = report.summary;
  lines.push(
    `${passed} passed, ${failed} failed, ${skipped} skipped. Checks: ${checksPassed}/${checksTotal}.`,
  );
  return lines.join('\n');
}
