import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { McpTools, ToolOutcome, ToolSpec } from '../mcp/client.ts';

/** A tool that runs inside the agent process rather than behind MCP. */
export interface LocalTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(input: never): unknown;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: S;
  run(input: z.output<S>): unknown;
}): LocalTool {
  return tool as LocalTool;
}

function toApiTool(spec: ToolSpec): Anthropic.Beta.BetaTool {
  const { $schema: _dialect, ...schema } = spec.inputSchema;
  return {
    name: spec.name,
    description: spec.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

function localSpec(tool: LocalTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema) as Record<string, unknown>,
  };
}

/**
 * Everything the model can reach in one turn. A name that is not listed here
 * cannot run, which is why leaving out a send tool is a real control.
 */
export class Toolbox {
  private readonly mcp: McpTools;
  private readonly mcpSpecs: ToolSpec[];
  private readonly local: Map<string, LocalTool>;

  constructor(mcp: McpTools, mcpSpecs: ToolSpec[], local: LocalTool[]) {
    this.mcp = mcp;
    this.mcpSpecs = mcpSpecs;
    this.local = new Map(local.map((tool) => [tool.name, tool]));
  }

  specs(): Anthropic.Beta.BetaTool[] {
    return [...this.mcpSpecs, ...[...this.local.values()].map(localSpec)].map(toApiTool);
  }

  async call(name: string, input: unknown): Promise<ToolOutcome> {
    const local = this.local.get(name);
    if (local) return runLocal(local, input);
    if (this.mcpSpecs.some((spec) => spec.name === name)) {
      return this.mcp.call(name, input as Record<string, unknown>);
    }
    return { isError: true, text: `Unknown tool "${name}". Use only the tools provided.` };
  }
}

async function runLocal(tool: LocalTool, input: unknown): Promise<ToolOutcome> {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { isError: true, text: `Invalid input: ${z.prettifyError(parsed.error)}` };
  }
  return { isError: false, text: JSON.stringify(await tool.run(parsed.data as never)) };
}
