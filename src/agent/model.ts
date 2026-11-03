import type Anthropic from '@anthropic-ai/sdk';

export interface ModelRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export type ModelReply = Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'>;

/** The seam that lets evals and tests swap the real model for a scripted one. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}

export class AnthropicModel implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client: Anthropic, model: string) {
    this.client = client;
    this.model = model;
  }

  complete(request: ModelRequest): Promise<ModelReply> {
    return this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
      output_config: { effort: 'medium' },
      // If the model declines, retry on the server's default fallback. Models
      // without a fallback ignore this and simply run alone.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  }
}

export interface ScriptedStep {
  say?: string | undefined;
  calls?: Array<{ tool: string; input: Record<string, unknown> }> | undefined;
}

/** Replays a fixed list of model turns and records what it was asked. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptedStep[];
  private nextToolUseId = 1;

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  get remainingSteps(): number {
    return this.steps.length;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error('Scripted model ran out of steps.');

    const content: ModelReply['content'] = [];
    if (step.say) content.push({ type: 'text', text: step.say, citations: null });
    for (const call of step.calls ?? []) {
      content.push({
        type: 'tool_use',
        id: `toolu_${this.nextToolUseId++}`,
        name: call.tool,
        input: call.input,
      });
    }
    return { content, stop_reason: step.calls?.length ? 'tool_use' : 'end_turn' };
  }
}
