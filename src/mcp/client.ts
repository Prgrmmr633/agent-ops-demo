import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
}

/** The few things the agent and worker need from an MCP connection. */
export class McpTools {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async list(): Promise<ToolSpec[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = await this.client.callTool({ name, arguments: args });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    return {
      isError: result.isError === true,
      text: blocks.map((block) => block.text ?? '').join('\n'),
    };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function newClient(): Client {
  return new Client({ name: 'agent-ops-client', version: '0.1.0' });
}

export async function connectOverHttp(url: string, token: string): Promise<McpTools> {
  const client = newClient();
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return new McpTools(client);
}

export async function connectInProcess(server: McpServer): Promise<McpTools> {
  const client = newClient();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return new McpTools(client);
}
