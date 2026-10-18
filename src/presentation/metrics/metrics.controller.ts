import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FinancialMetricsService } from '../../infrastructure/metrics/financial-metrics.service.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: FinancialMetricsService) {}

  @Get('metrics')
  async getMetrics(@Res() response: Response): Promise<void> {
    const result = await this.metrics.scrape();
    response.setHeader('Content-Type', result.contentType).send(result.body);
  }
}
