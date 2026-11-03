import type { Ambient } from '../ambient.ts';
import type { Db } from '../db.ts';
import type { JobQueue } from '../jobs/queue.ts';
import type { McpTools } from '../mcp/client.ts';
import { LocalOutbox } from '../outbound/adapter.ts';
import { ApprovalGate } from '../outbound/approval.ts';
import { DraftStore } from '../outbound/drafts.ts';
import type { VoiceAdapter } from '../voice/adapter.ts';
import { VoiceRenderingOutbound } from '../voice/outbound.ts';
import { ConversationStore } from './conversations.ts';
import type { ModelClient } from './model.ts';
import { StaffRouter } from './router.ts';

export interface RuntimeOptions {
  db: Db;
  jobs: JobQueue;
  mcp: McpTools;
  model: ModelClient;
  staffIds: Iterable<string>;
  ambient: Ambient;
  voice?: { adapter: VoiceAdapter; audioDir: string } | undefined;
}

/** One wiring, shared by the bot, the eval harness and the demo. */
export async function createStaffRuntime(options: RuntimeOptions) {
  const { db, jobs, mcp, model, staffIds, ambient, voice } = options;
  const drafts = new DraftStore(db, ambient);
  const outbox = new LocalOutbox(db, ambient);
  const outbound = voice
    ? new VoiceRenderingOutbound(outbox, voice.adapter, voice.audioDir)
    : outbox;
  const router = new StaffRouter({
    staffIds: new Set(staffIds),
    gate: new ApprovalGate(drafts, outbound),
    drafts,
    jobs,
    conversations: new ConversationStore(db),
    model,
    mcp,
    mcpSpecs: await mcp.list(),
  });
  return { router, drafts, outbox };
}
