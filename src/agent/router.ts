import type { JobQueue } from '../jobs/queue.ts';
import type { McpTools, ToolSpec } from '../mcp/client.ts';
import {
  type ApprovalEvent,
  type ApprovalGate,
  formatDraftPreview,
  parseApprovalCommand,
} from '../outbound/approval.ts';
import type { Draft, DraftStore } from '../outbound/drafts.ts';
import type { ConversationStore } from './conversations.ts';
import { runAgentTurn, type ToolCallRecord } from './loop.ts';
import type { ModelClient } from './model.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { Toolbox } from './toolbox.ts';
import { draftTools, jobTools } from './tools.ts';

export interface Inbound {
  chatId: string;
  userId: string;
  text: string;
  /** Only `typed` messages can approve. Forwards and transcripts are someone else's words. */
  source: 'typed' | 'forwarded' | 'voice';
}

export type RouterResult =
  | { kind: 'refused'; reply: string }
  | { kind: 'approval'; reply: string; event: ApprovalEvent }
  | {
      kind: 'agent';
      reply: string;
      /** The model's own words, without the draft previews that code adds. */
      modelReply: string;
      toolCalls: ToolCallRecord[];
      drafts: Draft[];
    };

export interface RouterOptions {
  staffIds: ReadonlySet<string>;
  gate: ApprovalGate;
  drafts: DraftStore;
  jobs: JobQueue;
  conversations: ConversationStore;
  model: ModelClient;
  mcp: McpTools;
  mcpSpecs: ToolSpec[];
}

/**
 * The only way in. Approval commands are matched here and handled by plain code
 * before the model is involved, and model output is never parsed for commands.
 */
export class StaffRouter {
  private readonly options: RouterOptions;

  constructor(options: RouterOptions) {
    this.options = options;
  }

  async handle(inbound: Inbound): Promise<RouterResult> {
    const { staffIds, gate } = this.options;
    if (!staffIds.has(inbound.userId)) {
      return { kind: 'refused', reply: 'This assistant is for staff only.' };
    }

    const command = parseApprovalCommand(inbound.text);
    if (command && inbound.source !== 'typed') {
      return { kind: 'refused', reply: 'Approvals must be typed by staff in this chat.' };
    }
    if (command) {
      const { reply, event } = await gate.handle(command, inbound);
      return { kind: 'approval', reply, event };
    }
    return this.runAgent(inbound);
  }

  private async runAgent(inbound: Inbound): Promise<RouterResult> {
    const { drafts, jobs, conversations, model, mcp, mcpSpecs } = this.options;
    const created: Draft[] = [];
    const toolbox = new Toolbox(mcp, mcpSpecs, [
      ...draftTools(drafts, inbound.chatId, (draft) => created.push(draft)),
      ...jobTools(jobs),
    ]);

    const turn = await runAgentTurn({
      model,
      toolbox,
      system: SYSTEM_PROMPT,
      history: conversations.recent(inbound.chatId),
      text: inbound.text,
    });

    const reply = [turn.reply, ...created.map(formatDraftPreview)].join('\n\n');
    conversations.append(inbound.chatId, 'user', inbound.text);
    conversations.append(inbound.chatId, 'assistant', reply);
    return {
      kind: 'agent',
      reply,
      modelReply: turn.reply,
      toolCalls: turn.toolCalls,
      drafts: created,
    };
  }
}
