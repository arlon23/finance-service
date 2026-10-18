import type { IntegrationEventMetadata } from './integration-event.base.js';
import { IntegrationEvent } from './integration-event.base.js';
import type { WagerTransactionKind } from '../entities/wager-transaction.js';
import type { MoneyProps } from '../value-objects/money.js';

export type WagerTransactionPendingReferenceData = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
};

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  static readonly EVENT_TYPE = 'WagerTransactionPendingReference';
  static readonly VERSION = 1;

  constructor(
    metadata: IntegrationEventMetadata,
    data: WagerTransactionPendingReferenceData,
  ) {
    super(
      WagerTransactionPendingReference.EVENT_TYPE,
      WagerTransactionPendingReference.VERSION,
      metadata,
      data,
    );
  }
}
