import { type Ambient, systemAmbient } from '../ambient.ts';
import type { Db } from '../db.ts';
import type { Channel } from './drafts.ts';

export interface OutboundMessage {
  draftId: string;
  channel: Channel;
  to: string;
  subject: string | null;
  body: string;
  approvedBy: string;
}

/**
 * ADAPTER BOUNDARY: implement this interface to deliver through a real provider.
 *
 * Only `ApprovalGate` calls `send`, and only after a human approval has claimed
 * the draft. An implementation should use `draftId` as the provider's idempotency
 * key and throw on failure. The gate records the failure and does not retry.
 */
export interface OutboundAdapter {
  send(message: OutboundMessage): Promise<{ providerRef: string }>;
}

export interface OutboxEntry extends OutboundMessage {
  id: string;
  sentAt: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    to_address TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
`;

/** Stub delivery: records the message locally and contacts nobody. */
export class LocalOutbox implements OutboundAdapter {
  private readonly db: Db;
  private readonly ambient: Ambient;

  constructor(db: Db, ambient: Ambient = systemAmbient) {
    this.db = db;
    this.ambient = ambient;
    db.exec(SCHEMA);
  }

  async send(message: OutboundMessage): Promise<{ providerRef: string }> {
    const id = this.ambient.newId('outbox');
    this.db
      .prepare(
        `INSERT INTO outbox (id, draft_id, channel, to_address, subject, body, approved_by, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        message.draftId,
        message.channel,
        message.to,
        message.subject,
        message.body,
        message.approvedBy,
        new Date(this.ambient.now()).toISOString(),
      );
    return { providerRef: id };
  }

  entries(): OutboxEntry[] {
    return this.db.prepare('SELECT * FROM outbox ORDER BY rowid').all().map(toEntry);
  }
}

function toEntry(row: unknown): OutboxEntry {
  const r = row as {
    id: string;
    draft_id: string;
    channel: Channel;
    to_address: string;
    subject: string | null;
    body: string;
    approved_by: string;
    sent_at: string;
  };
  return {
    id: r.id,
    draftId: r.draft_id,
    channel: r.channel,
    to: r.to_address,
    subject: r.subject,
    body: r.body,
    approvedBy: r.approved_by,
    sentAt: r.sent_at,
  };
}
