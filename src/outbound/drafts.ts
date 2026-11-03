import { type Ambient, systemAmbient } from '../ambient.ts';
import type { Db } from '../db.ts';

export const CHANNELS = ['email', 'sms', 'voice'] as const;
export type Channel = (typeof CHANNELS)[number];

/** `sending` is never retried on its own, so a crash cannot cause a second send. */
export type DraftStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'rejected';

export interface Draft {
  id: string;
  chatId: string;
  channel: Channel;
  to: string;
  subject: string | null;
  body: string;
  customerId: string | null;
  status: DraftStatus;
  decidedBy: string | null;
  providerRef: string | null;
  error: string | null;
  createdAt: string;
}

export interface NewDraft {
  chatId: string;
  channel: Channel;
  to: string;
  subject?: string | undefined;
  body: string;
  customerId?: string | undefined;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'voice')),
    to_address TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    customer_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected')),
    decided_by TEXT,
    provider_ref TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drafts_by_chat ON drafts (chat_id, status);
`;

export class DraftStore {
  private readonly db: Db;
  private readonly ambient: Ambient;

  constructor(db: Db, ambient: Ambient = systemAmbient) {
    this.db = db;
    this.ambient = ambient;
    db.exec(SCHEMA);
  }

  create(input: NewDraft): Draft {
    const row = this.db
      .prepare(
        `INSERT INTO drafts
           (id, chat_id, channel, to_address, subject, body, customer_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         RETURNING *`,
      )
      .get(
        this.ambient.newId('d'),
        input.chatId,
        input.channel,
        input.to,
        input.subject ?? null,
        input.body,
        input.customerId ?? null,
        new Date(this.ambient.now()).toISOString(),
      );
    return toDraft(row);
  }

  get(id: string): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    return row ? toDraft(row) : null;
  }

  pending(chatId: string): Draft[] {
    return this.db
      .prepare(
        `SELECT * FROM drafts WHERE chat_id = ? AND status = 'pending' ORDER BY created_at, rowid`,
      )
      .all(chatId)
      .map(toDraft);
  }

  recent(chatId: string, limit = 20): Draft[] {
    return this.db
      .prepare('SELECT * FROM drafts WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(chatId, limit)
      .map(toDraft);
  }

  /** Moves pending to sending in one statement, so only one approval can ever win. */
  claim(id: string, approvedBy: string): Draft | null {
    const row = this.db
      .prepare(
        `UPDATE drafts SET status = 'sending', decided_by = ?
         WHERE id = ? AND status = 'pending' RETURNING *`,
      )
      .get(approvedBy, id);
    return row ? toDraft(row) : null;
  }

  markSent(id: string, providerRef: string): void {
    this.db
      .prepare(`UPDATE drafts SET status = 'sent', provider_ref = ? WHERE id = ?`)
      .run(providerRef, id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare(`UPDATE drafts SET status = 'failed', error = ? WHERE id = ?`).run(error, id);
  }

  reject(id: string, rejectedBy: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE drafts SET status = 'rejected', decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(rejectedBy, id);
    return result.changes === 1;
  }
}

function toDraft(row: unknown): Draft {
  const r = row as {
    id: string;
    chat_id: string;
    channel: Channel;
    to_address: string;
    subject: string | null;
    body: string;
    customer_id: string | null;
    status: DraftStatus;
    decided_by: string | null;
    provider_ref: string | null;
    error: string | null;
    created_at: string;
  };
  return {
    id: r.id,
    chatId: r.chat_id,
    channel: r.channel,
    to: r.to_address,
    subject: r.subject,
    body: r.body,
    customerId: r.customer_id,
    status: r.status,
    decidedBy: r.decided_by,
    providerRef: r.provider_ref,
    error: r.error,
    createdAt: r.created_at,
  };
}
