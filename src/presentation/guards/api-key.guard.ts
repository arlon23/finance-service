import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

function configuredApiKeys(): string[] {
  const value = process.env.API_KEYS_JSON;
  if (!value) {
    throw new InternalServerErrorException(
      'API key authentication is not configured',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InternalServerErrorException(
      'API_KEYS_JSON must contain a JSON array of non-empty strings',
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((key) => typeof key !== 'string' || key.length === 0)
  ) {
    throw new InternalServerErrorException(
      'API_KEYS_JSON must contain a JSON array of non-empty strings',
    );
  }
  return parsed;
}

function secureEquals(candidate: string, configured: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const configuredDigest = createHash('sha256').update(configured).digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const headerKey = request.headers['x-api-key'];
    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === 'string'
        ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
        : undefined;
    const suppliedKey = typeof headerKey === 'string' ? headerKey : bearer;
    if (!suppliedKey) {
      throw new UnauthorizedException('API key is required');
    }

    const matches = configuredApiKeys().reduce(
      (found, key) => secureEquals(suppliedKey, key) || found,
      false,
    );
    if (!matches) {
      throw new UnauthorizedException('API key is invalid');
    }
    return true;
  }
}
