import { Migration } from '@mikro-orm/migrations';

export class Migration20261018130000_AddInboxCorrelationId extends Migration {
  override name = 'Migration20261018130000_AddInboxCorrelationId';

  override async up(): Promise<void> {
    this.addSql(
      'alter table "inbox_messages" add column "correlation_id" varchar(128) null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql('alter table "inbox_messages" drop column "correlation_id";');
  }
}
