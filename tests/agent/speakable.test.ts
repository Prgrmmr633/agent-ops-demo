import { describe, expect, it } from 'vitest';
import { speakable } from '../../src/agent/speakable.ts';

describe('speakable', () => {
  it('leaves plain replies as they are', () => {
    const reply = 'Juniper Vale’s folding commuter is ready. The chain was replaced.';
    expect(speakable(reply)).toEqual({ text: reply, shortened: false });
  });

  it('drops sentences with a draft id or an approval command', () => {
    const reply =
      'I’ve drafted a text to Tobias Fernsworth. Nothing has been sent yet.\n\nTo send it, type APPROVE d_3dad943a60a2. To drop it, type REJECT d_3dad943a60a2.';

    expect(speakable(reply)).toEqual({
      text: 'I’ve drafted a text to Tobias Fernsworth. Nothing has been sent yet. The details are in the message below.',
      shortened: true,
    });
  });

  it('takes phone numbers and email addresses out of the sentence', () => {
    expect(speakable('I’ve drafted a text to Tobias Fernsworth at +1-555-0104.').text).toBe(
      'I’ve drafted a text to Tobias Fernsworth. The details are in the message below.',
    );
    expect(speakable('I’ve drafted the email to otto.bramblewick@example.com.').text).toBe(
      'I’ve drafted the email. The details are in the message below.',
    );
  });

  it('names contact details it cannot take out cleanly', () => {
    expect(speakable('Their number is (555) 010-0104, or email wren@example.com.').text).toBe(
      'Their number is their phone number, or email their email address. The details are in the message below.',
    );
  });

  it('drops sentences with job, change or customer ids', () => {
    const reply = 'The summary is being made. Its job id is job_0123456789ab. I checked cust-2004.';
    expect(speakable(reply).text).toBe(
      'The summary is being made. The details are in the message below.',
    );
  });

  it('returns nothing to say when every sentence is an id or a command', () => {
    expect(speakable('Name the draft, for example APPROVE d_1. Waiting: d_1.')).toEqual({
      text: '',
      shortened: true,
    });
  });

  it('does not mistake dates or prices for phone numbers', () => {
    const reply = 'The part arrives on 2026-11-10 and costs 45.00.';
    expect(speakable(reply)).toEqual({ text: reply, shortened: false });
  });

  it('keeps lowercase words that only look like commands', () => {
    const reply = 'Staff need to approve each message before it is sent.';
    expect(speakable(reply)).toEqual({ text: reply, shortened: false });
  });
});
