import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentTurn } from '../../src/agent/loop.ts';
import type { ModelClient, ModelReply, ModelRequest } from '../../src/agent/model.ts';
import { ScriptedModel } from '../../src/agent/model.ts';
import { defineTool, Toolbox } from '../../src/agent/toolbox.ts';
import type { McpTools } from '../../src/mcp/client.ts';

const noMcp = {} as McpTools;

function toolbox(run: (input: { value: string }) => unknown = () => ({ ok: true })) {
  return new Toolbox(
    noMcp,
    [],
    [
      defineTool({
        name: 'echo',
        description: 'Echo a value',
        schema: z.object({ value: z.string() }),
        run,
      }),
    ],
  );
}

function turn(model: ModelClient, box = toolbox(), maxSteps?: number) {
  return runAgentTurn({
    model,
    toolbox: box,
    system: 'test',
    history: [],
    text: 'hello',
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
}

class FixedReply implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly reply: ModelReply;

  constructor(reply: ModelReply) {
    this.reply = reply;
  }

  async complete(request: ModelRequest) {
    this.requests.push(request);
    return this.reply;
  }
}

const echoCall = { tool: 'echo', input: { value: 'x' } };

describe('runAgentTurn', () => {
  it('returns the model text when no tools are requested', async () => {
    const result = await turn(new ScriptedModel([{ say: 'Hi there' }]));
    expect(result).toEqual({ reply: 'Hi there', toolCalls: [] });
  });

  it('runs a requested tool and gives the model its result', async () => {
    const model = new ScriptedModel([{ calls: [echoCall] }, { say: 'Done' }]);

    const result = await turn(model);

    expect(result.reply).toBe('Done');
    expect(result.toolCalls).toMatchObject([{ name: 'echo', isError: false }]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }],
    });
  });

  it('returns every result from one turn in a single message, in order', async () => {
    const order: string[] = [];
    const model = new ScriptedModel([
      {
        calls: [
          { tool: 'echo', input: { value: 'first' } },
          { tool: 'echo', input: { value: 'second' } },
        ],
      },
      { say: 'Done' },
    ]);

    await turn(
      model,
      toolbox(({ value }) => order.push(value)),
    );

    expect(order).toEqual(['first', 'second']);
    const last = model.requests[1]?.messages.at(-1);
    expect(last?.content).toHaveLength(2);
  });

  it('passes the assistant turn back unchanged, thinking blocks included', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as const;
    const toolUse = {
      type: 'tool_use',
      id: 'toolu_a',
      name: 'echo',
      input: { value: 'x' },
    } as const;
    const replies: ModelReply[] = [
      { content: [thinking, toolUse], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Done', citations: null }], stop_reason: 'end_turn' },
    ];
    const seen: ModelRequest[] = [];
    const model: ModelClient = {
      complete: async (request) => {
        seen.push(structuredClone(request));
        return replies.shift() as ModelReply;
      },
    };

    await turn(model);

    expect(seen[1]?.messages[1]).toEqual({ role: 'assistant', content: [thinking, toolUse] });
  });

  it('tells the model about an unknown tool instead of crashing', async () => {
    const model = new ScriptedModel([
      { calls: [{ tool: 'send_message', input: { to: 'someone' } }] },
      { say: 'I cannot do that' },
    ]);

    const result = await turn(model);

    expect(result.toolCalls).toMatchObject([{ name: 'send_message', isError: true }]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      content: [{ is_error: true }],
    });
  });

  it('reports invalid tool input to the model', async () => {
    const model = new ScriptedModel([
      { calls: [{ tool: 'echo', input: { value: 42 } }] },
      { say: 'Sorry' },
    ]);

    const result = await turn(model);

    expect(result.toolCalls[0]).toMatchObject({ isError: true });
    expect(result.toolCalls[0]?.output).toContain('Invalid input');
  });

  it('contains a tool that throws', async () => {
    const model = new ScriptedModel([{ calls: [echoCall] }, { say: 'It failed' }]);

    const result = await turn(
      model,
      toolbox(() => {
        throw new Error('tool exploded');
      }),
    );

    expect(result.toolCalls).toMatchObject([{ isError: true, output: 'tool exploded' }]);
    expect(result.reply).toBe('It failed');
  });

  it('stops at the step limit', async () => {
    const steps = Array.from({ length: 5 }, () => ({ calls: [echoCall] }));

    const result = await turn(new ScriptedModel(steps), toolbox(), 3);

    expect(result.toolCalls).toHaveLength(3);
    expect(result.reply).toContain('too many steps');
  });

  it.each([
    ['refusal', 'can’t help'],
    ['max_tokens', 'cut off'],
  ] as const)('never runs tools from a %s turn', async (stop_reason, expected) => {
    const calls: string[] = [];
    const box = toolbox(({ value }) => calls.push(value));
    const model = new FixedReply({
      content: [{ type: 'tool_use', id: 'toolu_a', name: 'echo', input: { value: 'x' } }],
      stop_reason,
    });

    const result = await turn(model, box);

    expect(result.reply).toContain(expected);
    expect(result.toolCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('gives a plain reply when the model returns no text', async () => {
    const model = new FixedReply({ content: [], stop_reason: 'end_turn' });
    expect((await turn(model)).reply).not.toBe('');
  });
});
