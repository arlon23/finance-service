import type { EntityManager } from '@mikro-orm/core';
import type { Wallet } from '../../domain/aggregates/wallet.js';
import { type WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import {
  type WagerTransaction,
  type WagerTransactionKind,
} from '../../domain/entities/wager-transaction.js';

export interface WalletRepositoryPort {
  findById(
    id: string,
    options?: { lock?: boolean; em?: EntityManager },
  ): Promise<Wallet | null>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
    em?: EntityManager,
  ): Promise<Wallet | null>;
  save(wallet: Wallet, em?: EntityManager): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string, em?: EntityManager): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    key: string,
    em?: EntityManager,
  ): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalId: string,
    em?: EntityManager,
  ): Promise<WagerTransaction | null>;
  findReversals(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
    em?: EntityManager,
  ): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction, em?: EntityManager): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  save(entry: WalletLedgerEntry, em?: EntityManager): Promise<void>;
  findByWalletId(
    walletId: string,
    options?: { limit?: number; cursor?: string; em?: EntityManager },
  ): Promise<WalletLedgerEntry[]>;
}

export interface InboxMessage {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  correlationId?: string;
  receivedAt?: Date;
  processedAt?: Date | null;
}

export interface InboxRepositoryPort {
  claim(message: InboxMessage, em?: EntityManager): Promise<boolean>;
  find(
    consumerName: string,
    messageId: string,
    em?: EntityManager,
  ): Promise<InboxMessage | null>;
  markProcessed(
    consumerName: string,
    messageId: string,
    processedAt?: Date,
    em?: EntityManager,
  ): Promise<void>;
}

export interface OutboxMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export interface OutboxRepositoryPort {
  save(message: OutboxMessage, em?: EntityManager): Promise<void>;
  findPending(options?: {
    limit?: number;
    now?: Date;
    lock?: boolean;
    em?: EntityManager;
  }): Promise<OutboxMessage[]>;
  markPublished(
    id: string,
    publishedAt?: Date,
    em?: EntityManager,
  ): Promise<void>;
  scheduleRetry(
    id: string,
    retryPolicy?: {
      now?: Date;
      baseDelayMs?: number;
      maxDelayMs?: number;
    },
    em?: EntityManager,
  ): Promise<Date>;
}

export interface OutboxEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
  close?(): void | Promise<void>;
}
