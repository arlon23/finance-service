import type { IntegrationEventMetadata } from './integration-event.base.js';
import { IntegrationEvent } from './integration-event.base.js';
import type { WagerTransactionKind } from '../entities/wager-transaction.js';
import type { FailureCode } from '../failure-code.js';
import type { MoneyProps } from '../value-objects/money.js';

export type WagerTransactionRejectedData = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
};

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  static readonly EVENT_TYPE = 'WagerTransactionRejected';
  static readonly VERSION = 1;

  constructor(
    metadata: IntegrationEventMetadata,
    data: WagerTransactionRejectedData,
  ) {
    super(
      WagerTransactionRejected.EVENT_TYPE,
      WagerTransactionRejected.VERSION,
      metadata,
      data,
    );
  }
}
