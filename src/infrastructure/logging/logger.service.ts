import type { LoggerService } from '@nestjs/common';
import { correlationContext } from './correlation-context.js';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

interface StructuredLogRecord {
  level: LogLevel;
  timestamp: string;
  correlationId: string | null;
  aggregateId: string | null;
  duration: number | null;
  context: string | null;
  message: string;
  details?: unknown;
  trace?: string;
}

function serializeMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export class StructuredLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const activeContext = correlationContext.get();
    const trailingContext = optionalParams.at(-1);
    const context =
      typeof trailingContext === 'string' ? trailingContext : undefined;
    const remainingParams =
      context === undefined ? optionalParams : optionalParams.slice(0, -1);
    const trace = remainingParams.find(
      (parameter): parameter is string =>
        typeof parameter === 'string' && parameter.includes('\n'),
    );
    const details = remainingParams.filter((parameter) => parameter !== trace);
    const record: StructuredLogRecord = {
      level,
      timestamp: new Date().toISOString(),
      correlationId: activeContext?.correlationId ?? null,
      aggregateId: activeContext?.aggregateId ?? null,
      duration: activeContext
        ? Math.max(0, Date.now() - activeContext.startedAt)
        : null,
      context: context ?? null,
      message: serializeMessage(message),
      ...(details.length > 0
        ? { details: details.length === 1 ? details[0] : details }
        : {}),
      ...(trace ? { trace } : {}),
    };
    const output = JSON.stringify(record);
    if (level === 'error' || level === 'fatal') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else if (level === 'debug' || level === 'verbose') {
      console.debug(output);
    } else {
      console.log(output);
    }
  }
}
