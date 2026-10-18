import { Migration } from '@mikro-orm/migrations';

export class Migration20261016190500_AddWagerTransactionUpdatedAt extends Migration {
  override name = 'Migration20261016190500_AddWagerTransactionUpdatedAt';

  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
      add column "updated_at" timestamptz not null default now();
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
      drop column "updated_at";
    `);
  }
}
