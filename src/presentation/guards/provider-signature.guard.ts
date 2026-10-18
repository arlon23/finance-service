import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface ProviderRequest extends Request {
  rawBody?: Buffer;
}

function isProviderSecretMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([providerId, secret]) =>
        providerId.trim().length > 0 &&
        typeof secret === 'string' &&
        secret.length > 0,
    )
  );
}

function providerSecrets(): Map<string, string> {
  const value = process.env.PROVIDER_HMAC_SECRETS_JSON;
  if (!value) {
    throw new InternalServerErrorException(
      'Provider signature validation is not configured',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InternalServerErrorException(
      'PROVIDER_HMAC_SECRETS_JSON must contain a provider-to-secret JSON object',
    );
  }
  if (!isProviderSecretMap(parsed)) {
    throw new InternalServerErrorException(
      'PROVIDER_HMAC_SECRETS_JSON must contain a provider-to-secret JSON object',
    );
  }
  return new Map(Object.entries(parsed));
}

function parseSignature(value: string): Buffer | undefined {
  const normalized = value.replace(/^sha256=/i, '');
  if (!/^[a-f\d]{64}$/i.test(normalized)) {
    return undefined;
  }
  return Buffer.from(normalized, 'hex');
}

@Injectable()
export class ProviderSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ProviderRequest>();
    const providerId =
      request.body !== null &&
      typeof request.body === 'object' &&
      !Array.isArray(request.body) &&
      typeof request.body.providerId === 'string'
        ? request.body.providerId
        : undefined;
    const signatureHeader =
      request.headers['x-signature'] ?? request.headers['x-hub-signature'];
    const signatureValue = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;

    if (!providerId || typeof signatureValue !== 'string' || !request.rawBody) {
      throw new UnauthorizedException(
        'A provider id, raw request body, and signature are required',
      );
    }

    const secret = providerSecrets().get(providerId);
    if (!secret) {
      throw new UnauthorizedException('Provider is not authorized');
    }

    const supplied = parseSignature(signatureValue);
    if (!supplied) {
      throw new UnauthorizedException('Provider signature is invalid');
    }
    const expected = createHmac('sha256', secret)
      .update(request.rawBody)
      .digest();
    if (!timingSafeEqual(expected, supplied)) {
      throw new UnauthorizedException('Provider signature is invalid');
    }
    return true;
  }
}
