import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
} from '../../application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import {
  IdempotencyKey,
  IdempotencyKeyPipe,
} from '../dtos/idempotency-key.pipe.js';
import { ProcessWagerTransactionDto } from '../dtos/process-wager-transaction.dto.js';
import { StrictDtoPipe } from '../dtos/strict-dto.pipe.js';
import { ApiKeyGuard } from '../guards/api-key.guard.js';
import { ProviderSignatureGuard } from '../guards/provider-signature.guard.js';
import { RateLimit } from '../throttler/rate-limit.decorator.js';

@Controller('wagers')
@UseGuards(ApiKeyGuard)
export class WagerController {
  constructor(private readonly processWager: ProcessWagerTransactionUseCase) {}

  @Post('transactions')
  @RateLimit({ limit: 30, windowMs: 60_000, identity: 'wager' })
  @UseGuards(ProviderSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async process(
    @Body(new StrictDtoPipe((value) => ProcessWagerTransactionDto.parse(value)))
    body: ProcessWagerTransactionDto,
    @IdempotencyKey(new IdempotencyKeyPipe())
    idempotencyKey: string,
    @Res({ passthrough: true })
    response: { status(statusCode: number): unknown },
  ) {
    const result = await this.processWager.execute(body.input, idempotencyKey);
    if (result.transaction.status === WagerTransactionStatus.REJECTED) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else if (
      result.transaction.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      response.status(HttpStatus.ACCEPTED);
    }
    return this.toResponse(result);
  }

  private toResponse(result: ProcessWagerTransactionResult) {
    const transaction = result.transaction;
    return {
      transaction: {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        amount: transaction.money.toJSON(),
        status: transaction.status,
        ...(transaction.referenceExternalTransactionId
          ? {
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId,
            }
          : {}),
        ...(transaction.failureCode
          ? { failureCode: transaction.failureCode }
          : {}),
        ...(transaction.processedAt
          ? { processedAt: transaction.processedAt.toISOString() }
          : {}),
      },
      walletBalance: result.walletBalance,
      idempotentReplay: result.idempotentReplay,
    };
  }
}
