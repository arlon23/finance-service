import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FinancialObservabilityModule } from '../metrics/financial-observability.module.js';
import { WalletReconciliationService } from '../../application/services/wallet-reconciliation.service.js';
import { WalletReconciliationCron } from './wallet-reconciliation.cron.js';

@Module({
  imports: [ScheduleModule.forRoot(), FinancialObservabilityModule],
  providers: [WalletReconciliationService, WalletReconciliationCron],
  exports: [WalletReconciliationService],
})
export class WalletReconciliationModule {}
