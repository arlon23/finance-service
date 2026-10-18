import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import type { FinancialRepository } from './domain/financial-repository.js';
import { TransactionService } from './domain/transaction-service.js';
import { PostgresFinancialRepository } from './infrastructure/postgres-financial-repository.js';
import { GlobalExceptionFilter } from './presentation/filters/global-exception.filter.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { CorrelationMiddleware } from './infrastructure/logging/correlation.middleware.js';
import { ApiKeyGuard } from './presentation/guards/api-key.guard.js';
import { ProviderSignatureGuard } from './presentation/guards/provider-signature.guard.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();
export const FINANCIAL_REPOSITORY = Symbol('FINANCIAL_REPOSITORY');

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'financial-service',
    }),
  ],
  controllers: [AppController, TransactionsController],
  providers: [
    AppService,
    CorrelationMiddleware,
    ApiKeyGuard,
    ProviderSignatureGuard,
    PostgresFinancialRepository,
    {
      provide: FINANCIAL_REPOSITORY,
      useExisting: PostgresFinancialRepository,
    },
    {
      provide: TransactionService,
      useFactory: (repository: FinancialRepository) =>
        new TransactionService(repository),
      inject: [FINANCIAL_REPOSITORY],
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
