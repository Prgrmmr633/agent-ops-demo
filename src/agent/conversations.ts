import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_chat ON conversation_messages (chat_id, seq);
`;

const HISTORY_LIMIT = 20;

/**
 * Keeps only what was said, not tool traffic. Current state always comes from a
 * fresh tool call, and trimming plain text can never orphan a tool result.
 */
export class ConversationStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    db.exec(SCHEMA);
  }

  append(chatId: string, role: 'user' | 'assistant', text: string): void {
    this.db
      .prepare('INSERT INTO conversation_messages (chat_id, role, text) VALUES (?, ?, ?)')
      .run(chatId, role, text);
  }

  recent(chatId: string): Anthropic.Beta.BetaMessageParam[] {
    const rows = this.db
      .prepare(
        `SELECT role, text FROM conversation_messages
         WHERE chat_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(chatId, HISTORY_LIMIT) as unknown as Array<{ role: 'user' | 'assistant'; text: string }>;
    const messages = rows.reverse().map(({ role, text }) => ({ role, content: text }));
    // The API requires the first message to come from the user.
    const firstUser = messages.findIndex((message) => message.role === 'user');
    return firstUser === -1 ? [] : messages.slice(firstUser);
  }
}
