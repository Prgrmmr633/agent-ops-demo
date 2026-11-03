import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicModel, type ModelClient, ScriptedModel } from '../agent/model.ts';
import { runScenario } from './harness.ts';
import { buildReport, type EvalReport, formatTable } from './report.ts';
import { type EvalMode, loadScenarios, type Scenario } from './scenario.ts';
import { type ScenarioScore, scoreScenario, skippedScore } from './scoring.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SCENARIO_DIR = resolve(PROJECT_ROOT, 'evals/scenarios');

const REPORT_FILE: Record<EvalMode, string> = {
  scripted: 'docs/eval-report.json',
  live: 'docs/eval-report.live.json',
};

export async function scoreAll(
  scenarios: Scenario[],
  mode: EvalMode,
  modelFor: (scenario: Scenario) => ModelClient,
): Promise<ScenarioScore[]> {
  const scores: ScenarioScore[] = [];
  for (const scenario of scenarios) {
    if (!scenario.modes.includes(mode)) {
      scores.push(skippedScore(scenario));
      continue;
    }
    const model = modelFor(scenario);
    const trace = await runScenario(scenario, model);
    if (model instanceof ScriptedModel && model.remainingSteps > 0) {
      trace.error ??= `${model.remainingSteps} scripted step(s) were never used.`;
    }
    scores.push(scoreScenario(scenario, trace));
  }
  return scores;
}

function chooseLiveModel(env: Record<string, string | undefined>) {
  const { ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: name } = env;
  if (!key || !name) return null;
  return { name, client: new AnthropicModel(new Anthropic({ apiKey: key }), name) };
}

/** Returns a process exit code. A live run with no key fails rather than faking a pass. */
export async function runEvals(
  args: string[],
  env: Record<string, string | undefined>,
  print: (line: string) => void,
): Promise<number> {
  const mode: EvalMode = args.includes('--live') ? 'live' : 'scripted';
  const scenarios = loadScenarios(SCENARIO_DIR);

  let report: EvalReport;
  if (mode === 'live') {
    const live = chooseLiveModel(env);
    if (!live) {
      print('Live mode needs ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Nothing was run.');
      return 1;
    }
    const scores = await scoreAll(scenarios, mode, () => live.client);
    report = buildReport(mode, live.name, scores, new Date());
  } else {
    const scores = await scoreAll(scenarios, mode, ({ script }) => new ScriptedModel(script));
    report = buildReport(mode, 'scripted fake model', scores, new Date());
  }

  const path = resolve(PROJECT_ROOT, REPORT_FILE[mode]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

  print(formatTable(report));
  print(`Report: ${REPORT_FILE[mode]}`);
  return report.summary.failed === 0 ? 0 : 1;
}
