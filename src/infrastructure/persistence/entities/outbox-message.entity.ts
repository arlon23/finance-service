import { defineEntity, p } from '@mikro-orm/postgresql';

const OutboxMessageEntitySchema = defineEntity({
  name: 'OutboxMessageEntity',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid().fieldName('aggregate_id'),
    eventType: p.string().fieldName('event_type'),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime().fieldName('occurred_at').defaultRaw('now()'),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').nullable(),
    publishedAt: p.datetime().fieldName('published_at').nullable(),
  },
  checks: [
    {
      name: 'outbox_messages_attempts_nonnegative_ck',
      expression: 'attempts >= 0',
    },
  ],
  indexes: [
    {
      name: 'outbox_messages_pending_schedule_idx',
      properties: ['publishedAt', 'nextAttemptAt', 'occurredAt', 'id'],
    },
  ],
});

export class OutboxMessageEntity extends OutboxMessageEntitySchema.class {}

OutboxMessageEntitySchema.setClass(OutboxMessageEntity);

export { OutboxMessageEntitySchema };
