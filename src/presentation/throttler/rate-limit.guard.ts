import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import {
  RATE_LIMIT_METADATA,
  type RateLimitOptions,
} from './rate-limit.decorator.js';
import { RateLimitStore } from './rate-limit.store.js';

function stringProperty(value: unknown, property: string): string | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    property in value
  ) {
    const candidate: unknown = Reflect.get(value, property);
    return typeof candidate === 'string' && candidate.trim()
      ? candidate.trim()
      : undefined;
  }
  return undefined;
}

function clientAddress(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

function apiCredential(request: Request): string {
  const headerKey = request.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey) {
    return headerKey;
  }
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === 'string'
      ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
      : undefined;
  return bearer ?? 'missing-api-key';
}

function rateLimitIdentity(
  request: Request,
  identity: RateLimitOptions['identity'],
): string {
  const ip = clientAddress(request);
  if (identity === 'wallet') {
    return createHash('sha256')
      .update(`wallet\u0000${apiCredential(request)}\u0000${ip}`)
      .digest('hex');
  }
  return createHash('sha256')
    .update(
      [
        'wager',
        stringProperty(request.body, 'providerId') ?? 'missing-provider',
        stringProperty(request.body, 'playerId') ?? 'missing-player',
        ip,
      ].join('\u0000'),
    )
    .digest('hex');
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!options) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const key = rateLimitIdentity(request, options.identity);
    const decision = this.store.consume(key, options.limit, options.windowMs);
    response.setHeader('X-RateLimit-Limit', String(decision.limit));
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((decision.resetAt - Date.now()) / 1_000),
      );
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          errorCode: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests; retry after the indicated delay',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
