import { assertPlainObject } from './strict-dto.pipe.js';

export class LedgerQueryDto {
  private constructor(
    readonly limit: number,
    readonly cursor?: string,
  ) {}

  static parse(value: unknown): LedgerQueryDto {
    const data = assertPlainObject(value, ['limit', 'cursor']);
    const limitValue = data.limit ?? '50';
    if (
      (typeof limitValue !== 'string' && typeof limitValue !== 'number') ||
      !/^\d+$/.test(String(limitValue))
    ) {
      throw new Error('limit must be a positive integer');
    }
    const limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be between 1 and 100');
    }
    let cursor: string | undefined;
    if (data.cursor !== undefined) {
      if (typeof data.cursor !== 'string' || data.cursor.trim().length === 0) {
        throw new Error('cursor must be a non-empty string');
      }
      cursor = data.cursor;
    }
    return new LedgerQueryDto(limit, cursor);
  }
}
