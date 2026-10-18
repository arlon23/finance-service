import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { StructuredLogger } from './infrastructure/logging/logger.service.js';

async function bootstrap() {
  const logger = new StructuredLogger();
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger,
    rawBody: true,
  });
  app.useLogger(logger);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
