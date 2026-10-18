import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { InboxMessageEntity } from '../persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../persistence/entities/outbox-message.entity.js';

export type FinancialTransactionMetricStatus =
  'SUCCESS' | 'REJECTED' | 'FAILED';

const wagerKinds = new Set<string>([
  WagerTransactionKind.BET,
  WagerTransactionKind.WIN,
  WagerTransactionKind.LOSS,
  WagerTransactionKind.REFUND,
  WagerTransactionKind.ROLLBACK,
]);

@Injectable()
export class FinancialMetricsService {
  private readonly registry = new Registry();
  private readonly transactions: Counter<'kind' | 'status'>;
  private readonly processingDuration: Histogram<'kind'>;
  private readonly businessFailures: Counter<'failure_code'>;
  private readonly reconciliationDiscrepancies: Counter;
  private readonly outboxPending: Gauge;
  private readonly inboxPending: Gauge;

  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
  ) {
    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Financial wager transactions by kind and processing outcome.',
      labelNames: ['kind', 'status'],
      registers: [this.registry],
    });
    this.processingDuration = new Histogram({
      name: 'wager_processing_duration_seconds',
      help: 'Time spent processing a financial wager transaction.',
      labelNames: ['kind'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.businessFailures = new Counter({
      name: 'financial_business_failures_total',
      help: 'Financial domain failures by stable failure code.',
      labelNames: ['failure_code'],
      registers: [this.registry],
    });
    this.reconciliationDiscrepancies = new Counter({
      name: 'financial_reconciliation_discrepancies_total',
      help: 'Wallet balance and ledger reconciliation discrepancies detected.',
      registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending_messages',
      help: 'Number of outbox messages not yet published.',
      registers: [this.registry],
    });
    this.inboxPending = new Gauge({
      name: 'inbox_pending_messages',
      help: 'Number of inbox messages not yet processed.',
      registers: [this.registry],
    });
  }

  recordTransaction(
    kind: WagerTransactionKind | string,
    status: FinancialTransactionMetricStatus,
  ): void {
    this.transactions.inc({ kind: this.normalizeKind(kind), status });
  }

  recordBusinessFailure(failureCode: string): void {
    this.businessFailures.inc({ failure_code: failureCode });
  }

  recordReconciliationDiscrepancy(): void {
    this.reconciliationDiscrepancies.inc();
  }

  observeProcessingDuration(
    kind: WagerTransactionKind | string,
    seconds: number,
  ): void {
    this.processingDuration.observe(
      { kind: this.normalizeKind(kind) },
      seconds,
    );
  }

  async scrape(): Promise<{ contentType: string; body: string }> {
    const em = this.em.fork({ clear: true });
    const [outboxCount, inboxCount] = await Promise.all([
      em.count(OutboxMessageEntity, { publishedAt: null }),
      em.count(InboxMessageEntity, { processedAt: null }),
    ]);
    this.outboxPending.set(outboxCount);
    this.inboxPending.set(inboxCount);
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }

  private normalizeKind(kind: string): string {
    return wagerKinds.has(kind) ? kind : 'UNKNOWN';
  }
}
