import type { IntegrationEventMetadata } from './integration-event.base.js';
import { IntegrationEvent } from './integration-event.base.js';
import type { LedgerDirection } from '../entities/wallet-ledger-entry.js';
import type { MoneyProps } from '../value-objects/money.js';

export type WalletBalanceChangedData = {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
};

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  static readonly EVENT_TYPE = 'WalletBalanceChanged';
  static readonly VERSION = 1;

  constructor(
    metadata: IntegrationEventMetadata,
    data: WalletBalanceChangedData,
  ) {
    super(
      WalletBalanceChanged.EVENT_TYPE,
      WalletBalanceChanged.VERSION,
      metadata,
      data,
    );
  }
}
