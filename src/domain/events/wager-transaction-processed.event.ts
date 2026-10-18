import type { IntegrationEventMetadata } from './integration-event.base.js';
import { IntegrationEvent } from './integration-event.base.js';
import type { MoneyProps } from '../value-objects/money.js';
import type { WagerTransactionKind } from '../entities/wager-transaction.js';

export type WagerTransactionProcessedData = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  resultingBalance: MoneyProps;
  referenceExternalTransactionId?: string;
};

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  static readonly EVENT_TYPE = 'WagerTransactionProcessed';
  static readonly VERSION = 1;

  constructor(
    metadata: IntegrationEventMetadata,
    data: WagerTransactionProcessedData,
  ) {
    super(
      WagerTransactionProcessed.EVENT_TYPE,
      WagerTransactionProcessed.VERSION,
      metadata,
      data,
    );
  }
}
