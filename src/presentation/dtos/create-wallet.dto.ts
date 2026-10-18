import {
  assertPlainObject,
  isIso4217Currency,
  requiredString,
} from './strict-dto.pipe.js';

export class CreateWalletDto {
  private constructor(
    readonly playerId: string,
    readonly currency: string,
    readonly initialBalance: string,
  ) {}

  static parse(value: unknown): CreateWalletDto {
    const data = assertPlainObject(value, [
      'playerId',
      'currency',
      'initialBalance',
    ]);
    const playerId = requiredString(data.playerId, 'playerId');
    const currency = requiredString(data.currency, 'currency');
    if (!isIso4217Currency(currency)) {
      throw new Error('currency must be a valid uppercase ISO 4217 code');
    }
    const initialBalance =
      data.initialBalance === undefined
        ? '0.00'
        : requiredString(
            data.initialBalance,
            'initialBalance',
            /^\d+(?:\.\d{1,2})?$/,
          );
    return new CreateWalletDto(playerId, currency, initialBalance);
  }
}
