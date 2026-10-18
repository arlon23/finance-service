import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { TransactionService } from '../domain/transaction-service.js';
import { ApiKeyGuard } from '../presentation/guards/api-key.guard.js';
import { ProviderSignatureGuard } from '../presentation/guards/provider-signature.guard.js';

@Controller('transactions')
@UseGuards(ApiKeyGuard, ProviderSignatureGuard)
export class TransactionsController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post()
  process(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.transactionService.process(body, idempotencyKey);
  }
}
