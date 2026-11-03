// Record ids (drafts, jobs, outbox entries, change records, customers) and approval commands.
const ID = /\b(?:(?:d|job|outbox|chg)_[A-Za-z0-9]+|cust-\d+)\b/;
const COMMAND = /\b(?:APPROVE|REJECT)\b/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /\+\d[\d\s().-]{6,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

const NOTE = 'The details are in the message below.';

export interface Speakable {
  /** What to say aloud. Empty when nothing worth saying is left. */
  text: string;
  /** True when something was left out, so the full text must follow in writing. */
  shortened: boolean;
}

const pattern = (inner: RegExp, flags = 'g') => new RegExp(inner.source, flags);

/**
 * Turns a reply into something pleasant to hear. Ids, commands, addresses and phone
 * numbers are hard to follow when read aloud, and staff need them exact, so they stay
 * in the written reply. Sentences built around an id or a command are dropped, and
 * contact details are taken out of the sentences that remain.
 */
export function speakable(reply: string): Speakable {
  const sentences = reply
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const sentence of sentences) {
    if (ID.test(sentence) || COMMAND.test(sentence)) continue;
    kept.push(
      sentence
        .replace(pattern(new RegExp(`\\s+(?:to|at|on)\\s+(?:${EMAIL.source}|${PHONE.source})`)), '')
        .replace(pattern(EMAIL), 'their email address')
        .replace(pattern(PHONE), 'their phone number'),
    );
  }

  const text = kept.join(' ');
  const shortened = text !== sentences.join(' ');
  if (!shortened || kept.length === 0) return { text, shortened };
  return { text: `${text} ${NOTE}`, shortened };
}
