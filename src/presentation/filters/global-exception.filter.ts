import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  CheckConstraintViolationException,
  ForeignKeyConstraintViolationException,
  NotNullConstraintViolationException,
  UniqueConstraintViolationException,
  ValidationError,
} from '@mikro-orm/core';
import type { Request, Response } from 'express';
import { DomainError } from '../../domain/domain-error.js';
import { FailureCode } from '../../domain/failure-code.js';

export interface HttpErrorEnvelope {
  statusCode: number;
  errorCode: string;
  message: string;
  timestamp: string;
  path: string;
}

interface FailureMapping {
  statusCode: number;
  errorCode: string;
  message: string;
}

function mapDomainFailure(failureCode: FailureCode): FailureMapping {
  if (
    [
      FailureCode.IDEMPOTENCY_CONFLICT,
      FailureCode.WALLET_ALREADY_EXISTS,
      FailureCode.DUPLICATE_REFERENCE,
      FailureCode.DUPLICATE_REFERENCE_REVERSAL,
      FailureCode.ALREADY_PROCESSED,
    ].includes(failureCode)
  ) {
    return {
      statusCode: HttpStatus.CONFLICT,
      errorCode: failureCode,
      message: 'The request conflicts with the current financial state',
    };
  }
  if (
    [
      FailureCode.TRANSACTION_NOT_FOUND,
      FailureCode.REFERENCE_NOT_FOUND,
      FailureCode.WALLET_NOT_FOUND,
    ].includes(failureCode)
  ) {
    return {
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: failureCode,
      message: 'The requested financial resource was not found',
    };
  }
  if (
    [
      FailureCode.INVALID_PAYLOAD,
      FailureCode.INVALID_CURRENCY,
      FailureCode.INVALID_IDEMPOTENCY_KEY,
      FailureCode.INVALID_MONEY,
    ].includes(failureCode)
  ) {
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: failureCode,
      message: 'The request payload is invalid',
    };
  }
  return {
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    errorCode: failureCode,
    message: 'The financial request cannot be processed',
  };
}

function errorChain(error: unknown): Error[] {
  const errors: Error[] = [];
  const visited = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current)) {
    errors.push(current);
    visited.add(current);
    current = current.cause;
  }
  return errors;
}

function databaseFailure(error: unknown): FailureMapping | undefined {
  const errors = errorChain(error);
  const uniqueViolation = errors.find(
    (item) => item instanceof UniqueConstraintViolationException,
  );
  if (uniqueViolation) {
    if (/idempotency_key/i.test(uniqueViolation.message)) {
      return {
        statusCode: HttpStatus.CONFLICT,
        errorCode: FailureCode.IDEMPOTENCY_CONFLICT,
        message: 'Idempotency-Key conflicts with an existing transaction',
      };
    }
    if (
      /wallets_player_currency_uq|wallets_player_id_currency_key/i.test(
        uniqueViolation.message,
      )
    ) {
      return {
        statusCode: HttpStatus.CONFLICT,
        errorCode: FailureCode.WALLET_ALREADY_EXISTS,
        message: 'A wallet already exists for this player and currency',
      };
    }
    return {
      statusCode: HttpStatus.CONFLICT,
      errorCode: 'RESOURCE_CONFLICT',
      message: 'The request conflicts with an existing resource',
    };
  }

  if (
    errors.some(
      (item) =>
        item instanceof CheckConstraintViolationException ||
        item instanceof NotNullConstraintViolationException ||
        item instanceof ForeignKeyConstraintViolationException,
    )
  ) {
    return {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      errorCode: 'DATA_INTEGRITY_VIOLATION',
      message: 'The request violates a financial data integrity rule',
    };
  }

  if (errors.some((item) => item instanceof ValidationError)) {
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'INVALID_REQUEST',
      message: 'The request contains invalid data',
    };
  }
  return undefined;
}

function httpFailure(exception: HttpException): FailureMapping {
  const statusCode = exception.getStatus();
  if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return {
      statusCode,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }

  const response = exception.getResponse();
  if (typeof response === 'string') {
    return {
      statusCode,
      errorCode: `HTTP_${statusCode}`,
      message: response,
    };
  }

  if (typeof response === 'object' && response !== null) {
    const body = response as Record<string, unknown>;
    const message = Array.isArray(body.message)
      ? body.message
          .filter((item): item is string => typeof item === 'string')
          .join('; ')
      : typeof body.message === 'string'
        ? body.message
        : exception.message;
    const suppliedCode =
      typeof body.errorCode === 'string'
        ? body.errorCode
        : typeof body.failureCode === 'string'
          ? body.failureCode
          : undefined;
    return {
      statusCode,
      errorCode: suppliedCode ?? `HTTP_${statusCode}`,
      message,
    };
  }

  return {
    statusCode,
    errorCode: `HTTP_${statusCode}`,
    message: exception.message,
  };
}

function correlationId(
  request: Request & { correlationId?: string },
): string | undefined {
  const header = request.headers['x-correlation-id'];
  const candidate =
    typeof request.correlationId === 'string'
      ? request.correlationId
      : Array.isArray(header)
        ? header[0]
        : header;
  return candidate && candidate.length <= 256 ? candidate : undefined;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { correlationId?: string }>();
    const response = http.getResponse<Response>();
    const result = this.mapException(exception);
    const correlation = correlationId(request);

    const auditLog = {
      event: 'http_request_failed',
      statusCode: result.statusCode,
      errorCode: result.errorCode,
      method: request.method,
      path: request.originalUrl ?? request.url,
      ...(correlation ? { correlationId: correlation } : {}),
      exception: errorChain(exception).map((error) => ({
        name: error.name,
        message: error.message,
        stack: error.stack,
      })),
      ...(errorChain(exception).length === 0
        ? { exceptionValue: String(exception) }
        : {}),
    };

    if (result.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(JSON.stringify(auditLog));
    } else {
      this.logger.warn(JSON.stringify(auditLog));
    }

    const envelope: HttpErrorEnvelope = {
      statusCode: result.statusCode,
      errorCode: result.errorCode,
      message: result.message,
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url,
    };
    response.status(result.statusCode).json(envelope);
  }

  private mapException(exception: unknown): FailureMapping {
    if (exception instanceof DomainError) {
      const mapped = mapDomainFailure(exception.failureCode);
      return {
        ...mapped,
        message:
          mapped.statusCode === HttpStatus.BAD_REQUEST
            ? exception.message
            : mapped.message,
      };
    }
    if (exception instanceof HttpException) {
      return httpFailure(exception);
    }
    const mappedDatabaseError = databaseFailure(exception);
    if (mappedDatabaseError) {
      return mappedDatabaseError;
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }
}
