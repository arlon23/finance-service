import { DomainError } from '../domain-error.js';
import { FailureCode } from '../failure-code.js';

export interface InboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  correlationId?: string;
  receivedAt?: Date;
  processedAt?: Date | null;
}

export interface InboxMessageState extends InboxMessageProps {
  receivedAt: Date;
  processedAt: Date | null;
}

export class InboxMessage {
  private _processedAt: Date | null;
  private readonly _receivedAt: Date;

  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    readonly correlationId: string | undefined,
    receivedAt: Date,
    processedAt: Date | null,
  ) {
    this._receivedAt = new Date(receivedAt);
    this._processedAt = processedAt ? new Date(processedAt) : null;
  }

  static receive(props: InboxMessageProps): InboxMessage {
    const receivedAt = props.receivedAt ?? new Date();
    if (
      !props.consumerName?.trim() ||
      !props.messageId?.trim() ||
      !/^[a-f\d]{64}$/i.test(props.payloadHash) ||
      (props.correlationId !== undefined &&
        (!props.correlationId.trim() || props.correlationId.length > 128)) ||
      Number.isNaN(receivedAt.getTime()) ||
      (props.processedAt != null && Number.isNaN(props.processedAt.getTime()))
    ) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Inbox message identifiers, payload hash or timestamps are invalid',
      );
    }
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      props.correlationId,
      receivedAt,
      props.processedAt ?? null,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return InboxMessage.receive(state);
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  get processedAt(): Date | null {
    return this._processedAt ? new Date(this._processedAt) : null;
  }

  markProcessed(processedAt = new Date()): void {
    if (Number.isNaN(processedAt.getTime())) {
      throw new DomainError(
        FailureCode.INVALID_PAYLOAD,
        'Inbox processed timestamp is invalid',
      );
    }
    if (this._processedAt) {
      throw new DomainError(
        FailureCode.INVALID_TRANSACTION_STATE,
        'Inbox message has already been processed',
      );
    }
    this._processedAt = new Date(processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== null;
  }

  toState(): InboxMessageState {
    return {
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      receivedAt: this.receivedAt,
      processedAt: this.processedAt,
    };
  }
}
