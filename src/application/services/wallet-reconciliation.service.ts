import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { FinancialMetricsService } from '../../infrastructure/metrics/financial-metrics.service.js';

export interface WalletReconciliationDiscrepancy {
  walletId: string;
  walletBalance: string;
  ledgerBalance: string;
}

export interface WalletReconciliationResult {
  auditedWallets: number;
  discrepancies: WalletReconciliationDiscrepancy[];
  durationMs: number;
}

interface ReconciliationRow {
  wallet_id: string;
  wallet_balance: string;
  ledger_balance: string;
  is_consistent: boolean;
}

interface QueryResult<T> {
  rows?: T[];
}

const DEFAULT_BATCH_SIZE = 500;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

@Injectable()
export class WalletReconciliationService {
  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
    private readonly metrics: FinancialMetricsService,
  ) {}

  async reconcile(
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<WalletReconciliationResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(
        'Wallet reconciliation batch size must be a positive integer',
      );
    }

    const startedAt = performance.now();
    const discrepancies: WalletReconciliationDiscrepancy[] = [];
    const connection = this.em.getConnection();
    const schema = this.em.schema ?? this.em.config.get('schema');
    const walletsTable = schema
      ? `${quoteIdentifier(schema)}.${quoteIdentifier('wallets')}`
      : quoteIdentifier('wallets');
    const ledgerTable = schema
      ? `${quoteIdentifier(schema)}.${quoteIdentifier('wallet_ledger_entries')}`
      : quoteIdentifier('wallet_ledger_entries');
    let cursor: string | null = null;
    let auditedWallets = 0;

    while (true) {
      const result = await connection.execute<ReconciliationRow>(
        `with wallet_page as (
           select id, balance
           from ${walletsTable}
           where (?::uuid is null or id > ?::uuid)
           order by id asc
           limit ?
         )
         select
           wallet_page.id as wallet_id,
           wallet_page.balance::text as wallet_balance,
           coalesce(
             sum(
               case
                 when ledger.direction = 'CREDIT' then ledger.money_amount
                 when ledger.direction = 'DEBIT' then -ledger.money_amount
                 else 0
               end
             ),
             0
           )::text as ledger_balance,
           wallet_page.balance = coalesce(
             sum(
               case
                 when ledger.direction = 'CREDIT' then ledger.money_amount
                 when ledger.direction = 'DEBIT' then -ledger.money_amount
                 else 0
               end
             ),
             0
           ) as is_consistent
         from wallet_page
         left join ${ledgerTable} ledger on ledger.wallet_id = wallet_page.id
         group by wallet_page.id, wallet_page.balance
         order by wallet_page.id asc`,
        [cursor, cursor, batchSize],
      );
      const rows = this.resultRows(result);
      if (rows.length === 0) {
        break;
      }

      auditedWallets += rows.length;
      for (const row of rows) {
        cursor = row.wallet_id;
        if (!row.is_consistent) {
          discrepancies.push({
            walletId: row.wallet_id,
            walletBalance: row.wallet_balance,
            ledgerBalance: row.ledger_balance,
          });
          this.metrics.recordReconciliationDiscrepancy();
        }
      }
    }

    return {
      auditedWallets,
      discrepancies,
      durationMs: performance.now() - startedAt,
    };
  }

  private resultRows(
    result: ReconciliationRow[] | QueryResult<ReconciliationRow>,
  ): ReconciliationRow[] {
    return Array.isArray(result) ? result : (result.rows ?? []);
  }
}
