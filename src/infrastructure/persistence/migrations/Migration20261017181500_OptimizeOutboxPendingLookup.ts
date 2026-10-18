import { Migration } from '@mikro-orm/migrations';

export class Migration20261017181500_OptimizeOutboxPendingLookup extends Migration {
  override name = 'Migration20261017181500_OptimizeOutboxPendingLookup';

  override async up(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_pending_idx";');
    this.addSql(`
      create index "outbox_messages_pending_schedule_idx"
      on "outbox_messages" ("published_at", "next_attempt_at", "occurred_at", "id");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_pending_schedule_idx";');
    this.addSql(`
      create index "outbox_messages_pending_idx"
      on "outbox_messages" ("next_attempt_at");
    `);
  }
}
