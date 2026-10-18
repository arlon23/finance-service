import { defineEntity, p } from '@mikro-orm/postgresql';

const InboxMessageEntitySchema = defineEntity({
  name: 'InboxMessageEntity',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary().fieldName('consumer_name'),
    messageId: p.string().primary().fieldName('message_id'),
    payloadHash: p.string().length(64).fieldName('payload_hash'),
    correlationId: p.string().nullable().fieldName('correlation_id'),
    receivedAt: p.datetime().fieldName('received_at').defaultRaw('now()'),
    processedAt: p.datetime().fieldName('processed_at').nullable(),
  },
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class {}

InboxMessageEntitySchema.setClass(InboxMessageEntity);

export { InboxMessageEntitySchema };
