import { describe, expect, it } from 'bun:test';
import { HttpException, HttpStatus } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { DomainError } from '../../src/domain/domain-error.js';
import { FailureCode } from '../../src/domain/failure-code.js';
import { GlobalExceptionFilter } from '../../src/presentation/filters/global-exception.filter.js';

interface CapturedResponse {
  statusCode?: number;
  body?: Record<string, unknown>;
}

function invokeFilter(
  exception: unknown,
  request: {
    method?: string;
    originalUrl?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    correlationId?: string;
  } = {},
): CapturedResponse {
  const captured: CapturedResponse = {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: request.method ?? 'POST',
        originalUrl: request.originalUrl ?? '/wagers/transactions?source=test',
        url: request.url ?? '/wagers/transactions?source=test',
        headers: request.headers ?? {},
        correlationId: request.correlationId,
      }),
      getResponse: () => ({
        status(statusCode: number) {
          captured.statusCode = statusCode;
          return this;
        },
        json(body: Record<string, unknown>) {
          captured.body = body;
          return body;
        },
      }),
    }),
  };
  new GlobalExceptionFilter().catch(exception, host as never);
  return captured;
}

describe('GlobalExceptionFilter', () => {
  it.each([
    [FailureCode.INSUFFICIENT_FUNDS, HttpStatus.UNPROCESSABLE_ENTITY],
    [FailureCode.NEGATIVE_BALANCE_PREVENTED, HttpStatus.UNPROCESSABLE_ENTITY],
    [FailureCode.IDEMPOTENCY_CONFLICT, HttpStatus.CONFLICT],
    [FailureCode.WALLET_ALREADY_EXISTS, HttpStatus.CONFLICT],
    [FailureCode.TRANSACTION_NOT_FOUND, HttpStatus.NOT_FOUND],
    [FailureCode.REFERENCE_NOT_FOUND, HttpStatus.NOT_FOUND],
    [FailureCode.WALLET_NOT_FOUND, HttpStatus.NOT_FOUND],
    [FailureCode.INVALID_PAYLOAD, HttpStatus.BAD_REQUEST],
  ] as const)(
    'maps %s to HTTP %s with the standard response envelope',
    (failureCode, expectedStatus) => {
      const result = invokeFilter(
        new DomainError(failureCode, 'internal domain detail'),
      );

      expect(result.statusCode).toBe(expectedStatus);
      expect(result.body).toMatchObject({
        statusCode: expectedStatus,
        errorCode: failureCode,
        path: '/wagers/transactions?source=test',
      });
      const timestamp = result.body?.timestamp;
      expect(typeof timestamp).toBe('string');
      expect(timestamp as string).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(result.body).not.toHaveProperty('stack');
    },
  );

  it('preserves safe client HTTP exceptions in the response envelope', () => {
    const result = invokeFilter(
      new HttpException(
        { message: ['invalid currency', 'amount required'] },
        HttpStatus.BAD_REQUEST,
      ),
    );

    expect(result).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      body: {
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: 'HTTP_400',
        message: 'invalid currency; amount required',
      },
    });
  });

  it('maps idempotency unique constraints to conflict without exposing SQL details', () => {
    const databaseError = new UniqueConstraintViolationException(
      new Error(
        'duplicate key violates unique constraint wager_transactions_idempotency_key_uq',
      ),
    );
    const result = invokeFilter(databaseError);

    expect(result.statusCode).toBe(HttpStatus.CONFLICT);
    expect(result.body).toMatchObject({
      errorCode: FailureCode.IDEMPOTENCY_CONFLICT,
      message: 'Idempotency-Key conflicts with an existing transaction',
    });
    expect(result.body?.message).not.toContain('duplicate key');
  });

  it('hides unexpected exception details while preserving the path and timestamp', () => {
    const result = invokeFilter(
      new Error('password=private database connection failed'),
      {
        method: 'GET',
        originalUrl: '/wallets/wallet-1',
        headers: { 'x-correlation-id': 'correlation-123' },
      },
    );

    expect(result.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.body).toEqual({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      timestamp: expect.any(String),
      path: '/wallets/wallet-1',
    });
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
});
