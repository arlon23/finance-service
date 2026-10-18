import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../domain/transaction-service.js';
import { canonicalAmount } from '../domain/transaction.js';
import type { WagerTransactionKind } from '../domain/entities/wager-transaction.js';

export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
}

export function calculateWagerPayloadHash(
  payload: WagerPayloadFields,
): string {
  const canonicalPayload = {
    amount: canonicalAmount(payload.amount),
    currency: payload.currency,
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    playerId: payload.playerId,
    providerId: payload.providerId,
    referenceExternalTransactionId:
      payload.referenceExternalTransactionId ?? null,
    roundId: payload.roundId,
    walletId: payload.walletId,
  };
  return createHash('sha256')
    .update(canonicalizeJson(canonicalPayload))
    .digest('hex');
}
