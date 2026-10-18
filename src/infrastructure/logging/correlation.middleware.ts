import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { correlationContext } from './correlation-context.js';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CorrelationMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers['x-correlation-id'];
    const requestedId = Array.isArray(header) ? header[0] : header;
    const correlationId =
      requestedId && CORRELATION_ID_PATTERN.test(requestedId)
        ? requestedId
        : randomUUID();

    Object.assign(request, { correlationId });
    response.setHeader('X-Correlation-ID', correlationId);
    correlationContext.runWithCorrelationId(correlationId, next);
  }
}
