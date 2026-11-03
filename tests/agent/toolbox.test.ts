import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, Toolbox } from '../../src/agent/toolbox.ts';
import type { McpTools } from '../../src/mcp/client.ts';

const getSpec = { name: 'get_customer', description: 'Get', inputSchema: { type: 'object' } };

function setup() {
  const call = vi.fn().mockResolvedValue({ isError: false, text: '{}' });
  const mcp = { call } as unknown as McpTools;
  const local = defineTool({
    name: 'echo',
    description: 'Echo',
    schema: z.object({ value: z.string() }),
    run: ({ value }) => ({ value }),
  });
  return { call, toolbox: new Toolbox(mcp, [getSpec], [local]) };
}

describe('Toolbox', () => {
  it('is an allowlist: a tool the server has but the agent was not given never runs', async () => {
    const { call, toolbox } = setup();

    const outcome = await toolbox.call('update_customer', { id: 'cust-1' });

    expect(outcome.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('forwards listed MCP tools', async () => {
    const { call, toolbox } = setup();

    await toolbox.call('get_customer', { id: 'cust-1' });

    expect(call).toHaveBeenCalledWith('get_customer', { id: 'cust-1' });
  });

  it('describes local tools to the model as JSON Schema objects', () => {
    const echo = setup()
      .toolbox.specs()
      .find((tool) => tool.name === 'echo');

    expect(echo?.input_schema).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' } },
    });
    expect(echo?.input_schema).not.toHaveProperty('$schema');
  });
});
