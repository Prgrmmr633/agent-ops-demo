import type { OutboundAdapter } from './adapter.ts';
import type { Draft, DraftStore } from './drafts.ts';

export type ApprovalCommand = { kind: 'approve' | 'reject'; draftId?: string };

export type ApprovalEvent =
  | { type: 'sent'; draftId: string; approvedBy: string }
  | { type: 'rejected'; draftId: string }
  | { type: 'failed'; draftId: string }
  | { type: 'refused' };

export interface ApprovalResult {
  reply: string;
  event: ApprovalEvent;
}

export interface Approver {
  chatId: string;
  userId: string;
}

const COMMAND = /^(APPROVE|REJECT)(?: ([A-Za-z0-9_-]+))?$/;

/**
 * Deliberately strict: the whole message must be the command, in capitals.
 * "yes, send it" and "approve d_1" are ordinary messages and never approve anything.
 * A bare APPROVE or REJECT is recognised only so that it can ask which draft.
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  const kind = match[1] === 'APPROVE' ? 'approve' : 'reject';
  return match[2] ? { kind, draftId: match[2] } : { kind };
}

/** Built by code, not the model, so staff always see exactly what would be sent. */
export function formatDraftPreview(draft: Draft): string {
  return [
    `Draft ${draft.id} (${draft.channel}) to ${draft.to}`,
    ...(draft.subject ? [`Subject: ${draft.subject}`] : []),
    '---',
    draft.body,
    '---',
    `Nothing has been sent. Reply APPROVE ${draft.id} to send it, or REJECT ${draft.id} to drop it.`,
  ].join('\n');
}

function refused(reply: string): ApprovalResult {
  return { reply, event: { type: 'refused' } };
}

export class ApprovalGate {
  private readonly drafts: DraftStore;
  private readonly adapter: OutboundAdapter;

  constructor(drafts: DraftStore, adapter: OutboundAdapter) {
    this.drafts = drafts;
    this.adapter = adapter;
  }

  async handle(command: ApprovalCommand, approver: Approver): Promise<ApprovalResult> {
    if (!command.draftId) return this.askWhichDraft(command, approver.chatId);

    const draft = this.drafts.get(command.draftId);
    // Another chat's draft is reported as missing so that its existence is not revealed.
    if (!draft || draft.chatId !== approver.chatId) {
      return refused(`No draft ${command.draftId} in this chat.`);
    }
    return command.kind === 'approve'
      ? this.approve(draft, approver)
      : this.reject(draft, approver);
  }

  /** Never guesses, even when only one draft is waiting: the id is the approval. */
  private askWhichDraft(command: ApprovalCommand, chatId: string): ApprovalResult {
    const waiting = this.drafts.pending(chatId);
    const [first] = waiting;
    if (!first) return refused('No drafts are waiting in this chat.');
    const verb = command.kind === 'approve' ? 'APPROVE' : 'REJECT';
    const ids = waiting.map((draft) => draft.id).join(', ');
    return refused(`Name the draft, for example ${verb} ${first.id}. Waiting: ${ids}.`);
  }

  private async approve(draft: Draft, approver: Approver): Promise<ApprovalResult> {
    const claimed = this.drafts.claim(draft.id, approver.userId);
    if (!claimed) return refused(`Draft ${draft.id} has already been handled.`);

    try {
      const { providerRef } = await this.adapter.send({
        draftId: claimed.id,
        channel: claimed.channel,
        to: claimed.to,
        subject: claimed.subject,
        body: claimed.body,
        approvedBy: approver.userId,
      });
      this.drafts.markSent(claimed.id, providerRef);
      return {
        reply: `Sent ${claimed.channel} ${claimed.id} to ${claimed.to}. Reference: ${providerRef}.`,
        event: { type: 'sent', draftId: claimed.id, approvedBy: approver.userId },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.drafts.markFailed(claimed.id, message);
      return {
        reply: `Sending ${claimed.id} failed: ${message}. It will not be retried automatically.`,
        event: { type: 'failed', draftId: claimed.id },
      };
    }
  }

  private reject(draft: Draft, approver: Approver): ApprovalResult {
    if (!this.drafts.reject(draft.id, approver.userId)) {
      return refused(`Draft ${draft.id} has already been handled.`);
    }
    return {
      reply: `Rejected ${draft.id}. It will not be sent.`,
      event: { type: 'rejected', draftId: draft.id },
    };
  }
}
