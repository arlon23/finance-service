import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import type { ProcessWagerTransactionInput } from '../../application/use-cases/process-wager-transaction.use-case.js';
import {
  assertPlainObject,
  isIso4217Currency,
  requiredString,
} from './strict-dto.pipe.js';

const amountPattern = /^\d+(?:\.\d{1,2})?$/;
const optionalStringFields = [
  'referenceExternalTransactionId',
  'correlationId',
  'causationId',
] as const;

function isWagerKind(value: string): value is WagerTransactionKind {
  return Object.values(WagerTransactionKind).some(
    (kind) => kind === value && kind !== WagerTransactionKind.OPENING,
  );
}

export class ProcessWagerTransactionDto {
  private constructor(readonly input: ProcessWagerTransactionInput) {}

  static parse(value: unknown): ProcessWagerTransactionDto {
    const data = assertPlainObject(value, [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'amount',
      'currency',
      ...optionalStringFields,
    ]);
    const providerId = requiredString(data.providerId, 'providerId');
    const externalTransactionId = requiredString(
      data.externalTransactionId,
      'externalTransactionId',
    );
    if (providerId.includes(':') || externalTransactionId.includes(':')) {
      throw new Error(
        'providerId and externalTransactionId cannot contain ":"',
      );
    }

    const kind = requiredString(data.kind, 'kind');
    if (!isWagerKind(kind)) {
      throw new Error('kind must be BET, WIN, LOSS, REFUND or ROLLBACK');
    }

    const amount = requiredString(data.amount, 'amount', amountPattern);
    if (/^0+(?:\.0{1,2})?$/.test(amount)) {
      throw new Error('amount must be greater than zero');
    }
    const currency = requiredString(data.currency, 'currency');
    if (!isIso4217Currency(currency)) {
      throw new Error('currency must be a valid uppercase ISO 4217 code');
    }

    const optionalFields = Object.fromEntries(
      optionalStringFields.flatMap((field) =>
        data[field] === undefined
          ? []
          : [[field, requiredString(data[field], field)]],
      ),
    );
    if (
      (kind === WagerTransactionKind.REFUND ||
        kind === WagerTransactionKind.ROLLBACK) &&
      !optionalFields.referenceExternalTransactionId
    ) {
      throw new Error(`${kind} requires referenceExternalTransactionId`);
    }
    if (
      optionalFields.referenceExternalTransactionId === externalTransactionId
    ) {
      throw new Error(
        'referenceExternalTransactionId must differ from externalTransactionId',
      );
    }

    return new ProcessWagerTransactionDto({
      providerId,
      externalTransactionId,
      playerId: requiredString(data.playerId, 'playerId'),
      walletId: requiredString(data.walletId, 'walletId'),
      roundId: requiredString(data.roundId, 'roundId'),
      gameId: requiredString(data.gameId, 'gameId'),
      kind,
      amount,
      currency,
      ...optionalFields,
    });
  }
}
