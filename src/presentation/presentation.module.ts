import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FinancialUseCasesModule } from '../application/financial-use-cases.module.js';
import { WalletController } from './controllers/wallet.controller.js';
import { WagerController } from './controllers/wager.controller.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ProviderSignatureGuard } from './guards/provider-signature.guard.js';
import { RateLimitGuard } from './throttler/rate-limit.guard.js';
import { RateLimitStore } from './throttler/rate-limit.store.js';

@Module({
  imports: [FinancialUseCasesModule],
  controllers: [WalletController, WagerController],
  providers: [
    ApiKeyGuard,
    ProviderSignatureGuard,
    RateLimitStore,
    RateLimitGuard,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
  ],
})
export class FinancialPresentationModule {}
