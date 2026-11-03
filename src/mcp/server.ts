import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type CustomerStore, customerPatchSchema, REPAIR_STATUSES } from '../data/customers.ts';

const customerId = z.string().min(1).describe('Customer id, for example cust-2001.');

function respond(body: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError };
}

/** `actor` is fixed per server so that a caller cannot choose its own audit identity. */
export function createDataServer(store: CustomerStore, actor: string): McpServer {
  const server = new McpServer({ name: 'agent-ops-data', version: '0.2.0' });

  server.registerTool(
    'find_customers',
    {
      description:
        'Find customers by free text (name, contact details, bike or notes) and/or repair ' +
        'status. Returns each customer with its current revision.',
      inputSchema: {
        query: z.string().optional().describe('Text to look for in any field.'),
        repairStatus: z.enum(REPAIR_STATUSES).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => respond({ customers: store.find(args) }),
  );

  server.registerTool(
    'get_customer',
    {
      description: 'Get one customer, including the revision needed for update_customer.',
      inputSchema: { id: customerId },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const customer = store.get(id);
      return customer
        ? respond({ ok: true, customer })
        : respond({ ok: false, error: 'not_found', message: `No customer with id ${id}.` }, true);
    },
  );

  server.registerTool(
    'update_customer',
    {
      description:
        'Change named fields on one customer. Pass the revision you last read. Send only the ' +
        'fields that should change: a value replaces the field and null clears it. Either every ' +
        'field changes or none does, and success is only reported after a re-read shows each ' +
        'change. On revision_conflict, get the customer again before deciding what to do.',
      inputSchema: {
        id: customerId,
        revision: z.number().int().min(1).describe('The revision you last read.'),
        changes: customerPatchSchema,
        reason: z.string().min(1).describe('Why this change is being made, for the audit trail.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, revision, changes, reason }) => {
      const result = store.update({ id, revision, changes, actor, reason });
      return respond(result, !result.ok);
    },
  );

  server.registerTool(
    'list_changes',
    {
      description: 'List the recorded changes to a customer, newest first.',
      inputSchema: {
        id: customerId,
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, limit }) => respond({ changes: store.changes(id, limit) }),
  );

  return server;
}
