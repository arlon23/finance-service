import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';
import { Money } from '../value-objects/money.js';
import { Wallet } from '../aggregates/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  idempotencyKey: string;
  payloadHash: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Omit<
  CreateWagerTransactionProps,
  'createdAt'
> {
  createdAt: Date;
  status: WagerTransactionStatus;
  updatedAt: Date;
  processedAt?: Date;
  failureCode?: FailureCode;
  resultingBalance?: Money;
}

export interface ProcessWagerTransactionOptions {
  ledgerEntryId: string;
  reference?: WagerTransaction | null;
  existingReversals?: readonly WagerTransaction[];
}

const terminalStatuses = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);

export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private readonly _createdAt: Date;
  private _updatedAt: Date;
  private _processedAt?: Date;
  private _failureCode?: FailureCode;
  private _referenceTransactionId: string | undefined;
  private _resultingBalance?: Money;

  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly playerId: string,
    readonly walletId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    referenceTransactionId: string | undefined,
    status: WagerTransactionStatus,
    createdAt: Date,
    updatedAt: Date,
    processedAt?: Date,
    failureCode?: FailureCode,
    resultingBalance?: Money,
  ) {
    this._status = status;
    this._createdAt = new Date(createdAt);
    this._updatedAt = new Date(updatedAt);
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
    this._failureCode = failureCode;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      !props.id.trim() ||
      !props.providerId.trim() ||
      !props.externalTransactionId.trim() ||
      !props.playerId.trim() ||
      !props.walletId.trim() ||
      !props.roundId.trim() ||
      !props.gameId.trim() ||
      !props.idempotencyKey.trim() ||
      !props.payloadHash.trim() ||
      !props.money.isPositive() ||
      (props.referenceExternalTransactionId !== undefined &&
        (!props.referenceExternalTransactionId.trim() ||
          props.referenceExternalTransactionId === props.externalTransactionId))
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Wager transaction identifiers and hashes are required',
      );
    }
    if (WagerTransaction.requiresReferenceFor(props.kind)) {
      if (!props.referenceExternalTransactionId) {
        throw new DomainError(
          FailureCode.INVALID_PAYLOAD,
          `${props.kind} transactions require a distinct reference transaction id`,
        );
      }
    }

    const now = props.createdAt ?? new Date();
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.playerId,
      props.walletId,
      props.roundId,
      props.gameId,
      props.idempotencyKey,
      props.payloadHash,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.referenceTransactionId,
      WagerTransactionStatus.PENDING,
      now,
      now,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.playerId,
      state.walletId,
      state.roundId,
      state.gameId,
      state.idempotencyKey,
      state.payloadHash,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.referenceTransactionId,
      state.status,
      state.createdAt,
      state.updatedAt,
      state.processedAt,
      state.failureCode,
      state.resultingBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  recordResultingBalance(balance: Money): void {
    this.money.assertSameCurrency(balance);
    this._resultingBalance = balance;
  }

  markProcessed(): void {
    this.transition(WagerTransactionStatus.PROCESSED);
    this._processedAt = new Date(this._updatedAt);
  }

  markPendingReference(): void {
    this.transition(WagerTransactionStatus.PENDING_REFERENCE);
  }

  reject(failureCode: FailureCode = FailureCode.INVALID_PAYLOAD): void {
    this.transition(WagerTransactionStatus.REJECTED, failureCode);
  }

  fail(failureCode: FailureCode = FailureCode.INVALID_TRANSACTION_STATE): void {
    this.transition(WagerTransactionStatus.FAILED, failureCode);
  }

  isTerminal(): boolean {
    return terminalStatuses.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.LOSS;
  }

  requiresReference(): boolean {
    return WagerTransaction.requiresReferenceFor(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  process(
    wallet: Wallet,
    options: ProcessWagerTransactionOptions,
  ): WalletLedgerEntry | null {
    this.assertProcessable();

    if (wallet.id !== this.walletId || wallet.playerId !== this.playerId) {
      return this.rejectAndReturn(FailureCode.REFERENCE_MISMATCH);
    }
    if (wallet.currency !== this.money.currency) {
      return this.rejectAndReturn(FailureCode.INVALID_CURRENCY);
    }

    const referenceRequired = this.requiresReference();
    const shouldValidateReference =
      referenceRequired ||
      (this.kind === WagerTransactionKind.WIN &&
        this.referenceExternalTransactionId !== undefined);
    let reference: WagerTransaction | undefined;

    if (shouldValidateReference) {
      reference = options.reference ?? undefined;
      if (!reference) {
        if (this.status === WagerTransactionStatus.PENDING) {
          this.markPendingReference();
        }
        return null;
      }
      if (
        reference.externalTransactionId !==
          this.referenceExternalTransactionId ||
        reference.providerId !== this.providerId ||
        reference.playerId !== this.playerId ||
        reference.walletId !== this.walletId ||
        reference.money.currency !== this.money.currency ||
        reference.roundId !== this.roundId
      ) {
        return this.rejectAndReturn(FailureCode.REFERENCE_MISMATCH);
      }
      this._referenceTransactionId = reference.id;

      if (
        reference.status === WagerTransactionStatus.PENDING ||
        reference.status === WagerTransactionStatus.PENDING_REFERENCE
      ) {
        if (this.status === WagerTransactionStatus.PENDING) {
          this.markPendingReference();
        }
        return null;
      }
      if (reference.status !== WagerTransactionStatus.PROCESSED) {
        return this.rejectAndReturn(FailureCode.REFERENCE_NOT_REVERSIBLE);
      }

      if (
        this.kind === WagerTransactionKind.WIN &&
        reference.kind !== WagerTransactionKind.BET
      ) {
        return this.rejectAndReturn(FailureCode.REFERENCE_NOT_REVERSIBLE);
      }
      if (
        this.kind === WagerTransactionKind.REFUND &&
        reference.kind !== WagerTransactionKind.BET
      ) {
        return this.rejectAndReturn(FailureCode.REFERENCE_NOT_REVERSIBLE);
      }
      if (
        this.kind === WagerTransactionKind.ROLLBACK &&
        ![
          WagerTransactionKind.BET,
          WagerTransactionKind.WIN,
          WagerTransactionKind.REFUND,
        ].includes(reference.kind)
      ) {
        return this.rejectAndReturn(FailureCode.REFERENCE_NOT_REVERSIBLE);
      }
      if (
        this.kind !== WagerTransactionKind.WIN &&
        !reference.money.equals(this.money)
      ) {
        return this.rejectAndReturn(FailureCode.REFERENCE_MISMATCH);
      }
      const referencedExternalTransactionId = reference.externalTransactionId;
      const duplicateReversal = options.existingReversals?.some(
        (reversal) =>
          reversal.id !== this.id &&
          reversal.kind === this.kind &&
          reversal.referenceExternalTransactionId ===
            referencedExternalTransactionId &&
          (reversal.status === WagerTransactionStatus.PENDING_REFERENCE ||
            reversal.status === WagerTransactionStatus.PROCESSED),
      );
      if (duplicateReversal) {
        return this.rejectAndReturn(FailureCode.DUPLICATE_REFERENCE);
      }
    }

    if (this.kind === WagerTransactionKind.LOSS) {
      this.markProcessed();
      return null;
    }

    const direction = this.resolveDirection(reference);
    const balanceBefore = wallet.balance;
    let balanceAfter: Money;
    try {
      balanceAfter =
        direction === LedgerDirection.DEBIT
          ? wallet.balanceAfterDebit(
              this.money,
              this.kind === WagerTransactionKind.BET
                ? FailureCode.INSUFFICIENT_FUNDS
                : FailureCode.NEGATIVE_BALANCE_PREVENTED,
            )
          : balanceBefore.add(this.money);
    } catch (error) {
      if (error instanceof DomainError) {
        return this.rejectAndReturn(error.failureCode);
      }
      throw error;
    }

    let entry: WalletLedgerEntry;
    try {
      entry = WalletLedgerEntry.create({
        id: options.ledgerEntryId,
        walletId: wallet.id,
        transactionId: this.id,
        direction,
        money: this.money,
        balanceBefore,
        balanceAfter,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        return this.rejectAndReturn(error.failureCode);
      }
      throw error;
    }

    if (direction === LedgerDirection.DEBIT) {
      wallet.debitWithFailureCode(
        this.money,
        this.kind === WagerTransactionKind.BET
          ? FailureCode.INSUFFICIENT_FUNDS
          : FailureCode.NEGATIVE_BALANCE_PREVENTED,
      );
    } else {
      wallet.credit(this.money);
    }
    this.markProcessed();
    return entry;
  }

  private static requiresReferenceFor(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.REFUND ||
      kind === WagerTransactionKind.ROLLBACK
    );
  }

  private resolveDirection(
    reference: WagerTransaction | undefined,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.BET:
        return LedgerDirection.DEBIT;
      case WagerTransactionKind.WIN:
      case WagerTransactionKind.REFUND:
      case WagerTransactionKind.OPENING:
        return LedgerDirection.CREDIT;
      case WagerTransactionKind.ROLLBACK:
        return reference?.kind === WagerTransactionKind.BET
          ? LedgerDirection.CREDIT
          : LedgerDirection.DEBIT;
      case WagerTransactionKind.LOSS:
        throw new DomainError(
          FailureCode.INVALID_TRANSACTION_STATE,
          'LOSS transactions do not have a ledger direction',
        );
    }
  }

  private assertProcessable(): void {
    if (this._status === WagerTransactionStatus.PROCESSED) {
      throw new DomainError(
        FailureCode.ALREADY_PROCESSED,
        'Transaction has already been processed',
      );
    }
    if (this.isTerminal()) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        `Cannot process transaction in terminal state ${this._status}`,
      );
    }
  }

  private rejectAndReturn(failureCode: FailureCode): null {
    this.reject(failureCode);
    return null;
  }

  private transition(
    status: WagerTransactionStatus,
    failureCode?: FailureCode,
  ): void {
    if (this.isTerminal()) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        `Cannot transition terminal transaction from ${this._status}`,
      );
    }
    if (
      status === WagerTransactionStatus.PENDING_REFERENCE &&
      this._status !== WagerTransactionStatus.PENDING
    ) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        `Cannot transition transaction from ${this._status} to ${status}`,
      );
    }
    this._status = status;
    this._failureCode = failureCode;
    this._updatedAt = new Date();
  }
}
