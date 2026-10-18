import { FailureCode } from './failure-code.js';

export class DomainError extends Error {
  constructor(
    readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
