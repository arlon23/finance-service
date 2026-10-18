import { Module } from '@nestjs/common';
import { getEntityManagerToken, MikroOrmModule } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from './use-cases/process-wager-transaction.use-case.js';
import {
  INBOX_REPOSITORY,
  OUTBOX_REPOSITORY,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_LEDGER_REPOSITORY,
  WALLET_REPOSITORY,
} from './tokens.js';
import { InboxMessageEntity } from '../infrastructure/persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../infrastructure/persistence/entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { InboxRepository } from '../infrastructure/persistence/repositories/inbox.repository.js';
import { OutboxRepository } from '../infrastructure/persistence/repositories/outbox.repository.js';
import { WalletLedgerRepository } from '../infrastructure/persistence/repositories/wallet-ledger.repository.js';
import { WagerTransactionRepository } from '../infrastructure/persistence/repositories/wager-transaction.repository.js';
import { WalletRepository } from '../infrastructure/persistence/repositories/wallet.repository.js';
import { FinancialObservabilityModule } from '../infrastructure/metrics/financial-observability.module.js';
import { WalletReconciliationModule } from '../infrastructure/jobs/wallet-reconciliation.module.js';

@Module({
  imports: [
    FinancialObservabilityModule,
    WalletReconciliationModule,
    MikroOrmModule.forFeature(
      [
        WalletEntity,
        WagerTransactionEntity,
        WalletLedgerEntryEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
      ],
      'default',
    ),
  ],
  providers: [
    {
      provide: WalletRepository,
      useFactory: (em: EntityManager) => new WalletRepository(em),
      inject: [getEntityManagerToken('default')],
    },
    {
      provide: WagerTransactionRepository,
      useFactory: (em: EntityManager) => new WagerTransactionRepository(em),
      inject: [getEntityManagerToken('default')],
    },
    {
      provide: WalletLedgerRepository,
      useFactory: (em: EntityManager) => new WalletLedgerRepository(em),
      inject: [getEntityManagerToken('default')],
    },
    {
      provide: OutboxRepository,
      useFactory: (em: EntityManager) => new OutboxRepository(em),
      inject: [getEntityManagerToken('default')],
    },
    {
      provide: InboxRepository,
      useFactory: (em: EntityManager) => new InboxRepository(em),
      inject: [getEntityManagerToken('default')],
    },
    {
      provide: WALLET_REPOSITORY,
      useExisting: WalletRepository,
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useExisting: WagerTransactionRepository,
    },
    {
      provide: WALLET_LEDGER_REPOSITORY,
      useExisting: WalletLedgerRepository,
    },
    {
      provide: OUTBOX_REPOSITORY,
      useExisting: OutboxRepository,
    },
    {
      provide: INBOX_REPOSITORY,
      useExisting: InboxRepository,
    },
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
  ],
  exports: [
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    WALLET_REPOSITORY,
    WALLET_LEDGER_REPOSITORY,
    FinancialObservabilityModule,
    WalletReconciliationModule,
  ],
})
export class FinancialUseCasesModule {}
