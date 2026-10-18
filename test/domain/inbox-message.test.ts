import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../src/domain/entities/inbox-message.js';

describe('InboxMessage', () => {
  it('tracks a received message until its processing is committed', () => {
    const receivedAt = new Date('2026-10-17T12:00:00.000Z');
    const message = InboxMessage.receive({
      consumerName: 'wager-processor',
      messageId: 'sqs-message-1',
      payloadHash: 'a'.repeat(64),
      receivedAt,
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(receivedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(receivedAt);
    expect(() => message.markProcessed(receivedAt)).toThrow(
      'Inbox message has already been processed',
    );
  });

  it('rejects invalid inbox identity, hash, and timestamps', () => {
    expect(() =>
      InboxMessage.receive({
        consumerName: '',
        messageId: 'sqs-message-1',
        payloadHash: 'a'.repeat(64),
      }),
    ).toThrow(
      'Inbox message identifiers, payload hash or timestamps are invalid',
    );
    expect(() =>
      InboxMessage.receive({
        consumerName: 'wager-processor',
        messageId: 'sqs-message-1',
        payloadHash: 'not-a-hash',
      }),
    ).toThrow(
      'Inbox message identifiers, payload hash or timestamps are invalid',
    );
  });
});
