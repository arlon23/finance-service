import { BadRequestException, type PipeTransform } from '@nestjs/common';

export type DtoParser<T> = (value: unknown) => T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export class StrictDtoPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly parser: DtoParser<T>) {}

  transform(value: unknown): T {
    try {
      return this.parser(value);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid request payload',
      );
    }
  }
}

export function assertPlainObject(
  value: unknown,
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error('Request body must be a JSON object');
  }

  const data = value;
  const unexpectedFields = Object.keys(data).filter(
    (key) => !allowedFields.includes(key),
  );
  if (unexpectedFields.length > 0) {
    throw new Error(`Unexpected request field: ${unexpectedFields.join(', ')}`);
  }
  return data;
}

export function requiredString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

export function isIso4217Currency(value: string): boolean {
  return (
    /^[A-Z]{3}$/.test(value) &&
    Intl.supportedValuesOf('currency').includes(value)
  );
}
