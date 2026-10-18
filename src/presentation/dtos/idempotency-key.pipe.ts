import {
  BadRequestException,
  createParamDecorator,
  type PipeTransform,
} from '@nestjs/common';
import type { Request } from 'express';

export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !/^[^:\s]+:[^:\s]+$/.test(value)) {
      throw new BadRequestException(
        'Idempotency-Key header is required in {providerId}:{externalTransactionId} format',
      );
    }
    return value;
  }
}

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context) =>
    context.switchToHttp().getRequest<Request>().headers['idempotency-key'],
);
