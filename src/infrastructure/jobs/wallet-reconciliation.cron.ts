import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WalletReconciliationService } from '../../application/services/wallet-reconciliation.service.js';

@Injectable()
export class WalletReconciliationCron {
  private readonly logger = new Logger(WalletReconciliationCron.name);
  private running = false;

  constructor(private readonly reconciliation: WalletReconciliationService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runScheduledReconciliation(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet_reconciliation_skipped',
          reason: 'previous_run_still_active',
        }),
      );
      return;
    }

    this.running = true;
    try {
      const result = await this.reconciliation.reconcile();
      this.logger.log(
        JSON.stringify({
          event: 'wallet_reconciliation_completed',
          auditedWallets: result.auditedWallets,
          discrepancyCount: result.discrepancies.length,
          durationMs: result.durationMs,
        }),
      );
      for (const discrepancy of result.discrepancies) {
        this.logger.error(
          JSON.stringify({
            severity: 'CRITICAL',
            event: 'wallet_ledger_balance_discrepancy',
            walletId: discrepancy.walletId,
            walletBalance: discrepancy.walletBalance,
            ledgerBalance: discrepancy.ledgerBalance,
          }),
        );
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          severity: 'CRITICAL',
          event: 'wallet_reconciliation_failed',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
      throw error;
    } finally {
      this.running = false;
    }
  }
}
