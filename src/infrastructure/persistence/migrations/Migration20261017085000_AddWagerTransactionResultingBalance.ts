import { Migration } from '@mikro-orm/migrations';

export class Migration20261017085000_AddWagerTransactionResultingBalance extends Migration {
  override name = 'Migration20261017085000_AddWagerTransactionResultingBalance';

  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
      add column "resulting_balance_amount" numeric(18, 2) null;
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
      drop column "resulting_balance_amount";
    `);
  }
}
