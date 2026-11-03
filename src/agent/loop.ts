import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelReply } from './model.ts';
import type { Toolbox } from './toolbox.ts';

export interface ToolCallRecord {
  name: string;
  input: unknown;
  isError: boolean;
  output: string;
}

export interface AgentTurn {
  reply: string;
  toolCalls: ToolCallRecord[];
}

export interface TurnInput {
  model: ModelClient;
  toolbox: Toolbox;
  system: string;
  history: Anthropic.Beta.BetaMessageParam[];
  text: string;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 10;

function replyText(reply: ModelReply): string {
  return reply.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function closingMessage(reply: ModelReply): string {
  // A cut-off or declined turn can hold a half-formed tool call, so it never runs.
  if (reply.stop_reason === 'refusal') return 'I can’t help with that request.';
  if (reply.stop_reason === 'max_tokens') {
    return 'My reply was cut off, so I stopped here. Please check the record before retrying.';
  }
  return replyText(reply) || 'I don’t have anything to add.';
}

async function runTool(
  toolbox: Toolbox,
  block: Anthropic.Beta.BetaToolUseBlock,
): Promise<ToolCallRecord> {
  try {
    const outcome = await toolbox.call(block.name, block.input);
    return {
      name: block.name,
      input: block.input,
      isError: outcome.isError,
      output: outcome.text,
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return { name: block.name, input: block.input, isError: true, output };
  }
}

/** Runs one staff message through the model until it stops asking for tools. */
export async function runAgentTurn(input: TurnInput): Promise<AgentTurn> {
  const { model, toolbox, system, history, text } = input;
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: text }];
  const tools = toolbox.specs();
  const toolCalls: ToolCallRecord[] = [];

  for (let step = 0; step < (input.maxSteps ?? DEFAULT_MAX_STEPS); step++) {
    const reply = await model.complete({ system, tools, messages });
    if (reply.stop_reason !== 'tool_use') {
      return { reply: closingMessage(reply), toolCalls };
    }

    // The assistant turn goes back unchanged, including any thinking blocks.
    messages.push({ role: 'assistant', content: reply.content });

    // Sequential on purpose: order matters when one call depends on an earlier write.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of reply.content) {
      if (block.type !== 'tool_use') continue;
      const record = await runTool(toolbox, block);
      toolCalls.push(record);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: record.output,
        is_error: record.isError,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    reply: 'I stopped after too many steps. Please check the record before retrying.',
    toolCalls,
  };
}
